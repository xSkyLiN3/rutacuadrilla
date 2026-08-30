import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Capability, PointType } from "../constants.js";
import type { DomainDatabase, SqlExecutor } from "../database/types.js";
import { DomainError } from "../errors.js";
import { type MultiLineStringGeometry, parseStoredGeometry } from "../routes/geometry.js";
import type { SegmentSource, ServiceSide } from "../routes/types.js";
import { decodeSyncCursor, encodeSyncCursor } from "./cursor.js";
import {
  type ContextAccessInput,
  type CreateTechnicalContextInput,
  type GetContextPackageInput,
  type ProvisionalPointState,
  type PullChangesInput,
  type PullChangesResult,
  type PushCommandsInput,
  type PushCommandsResult,
  provisionalPointStates,
  type SyncChange,
  type SyncCommand,
  type SyncCommandResult,
  type SyncServiceApi,
  syncContractVersion,
  type TechnicalContextPackage,
  type TechnicalContextPoint,
  type TechnicalContextSegment,
  type TechnicalContextSummary,
} from "./types.js";

const pointStateSchema = z.enum(provisionalPointStates);
const commandBaseSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  campaignPointId: z.string().uuid(),
  dependsOnOperationId: z.string().uuid().optional(),
  deviceId: z.string().uuid(),
  occurredAtDevice: z.iso.datetime({ offset: true }).optional(),
  operationId: z.string().uuid(),
  workSessionId: z.string().uuid(),
});
const syncCommandSchema = z.discriminatedUnion("type", [
  commandBaseSchema.extend({
    payload: z.object({ state: pointStateSchema }).strict(),
    type: z.literal("POINT_STATUS_CHANGED"),
  }),
  commandBaseSchema.extend({
    payload: z.object({ revertsOperationId: z.string().uuid() }).strict(),
    type: z.literal("POINT_STATUS_REVERTED"),
  }),
]);
const pushInputSchema = z.object({
  actorUserId: z.string().uuid(),
  commands: z.array(syncCommandSchema).min(1).max(100),
  crewId: z.string().uuid(),
});
const pullInputSchema = z.object({
  actorUserId: z.string().uuid(),
  crewId: z.string().uuid(),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
const contextAccessSchema = z.object({
  actorUserId: z.string().uuid(),
  crewId: z.string().uuid(),
});
const getContextSchema = contextAccessSchema.extend({ contextId: z.string().uuid() });
const createContextSchema = contextAccessSchema.extend({
  campaignName: z.string().trim().min(1).max(160).optional(),
  routeRevisionId: z.string().uuid(),
});

type MembershipRow = { capability_code: string | null; id: string };
type RevisionRow = {
  content_hash: string;
  point_count: number;
  route_id: string;
  route_name: string;
  status: string;
};
type RevisionPointRow = {
  display_order: number;
  service_point_id: string;
  service_point_version_id: string;
};
type ContextRow = {
  campaign_id: string;
  campaign_name: string;
  content_hash: string;
  context_id: string;
  point_count: number;
  route_id: string;
  route_name: string;
  route_revision_id: string;
  segment_count: number;
  vehicle_id: string | null;
  vehicle_name: string | null;
};
type ContextPointRow = {
  campaign_point_id: string;
  display_order: number;
  display_state: ProvisionalPointState;
  external_id: string;
  house_number: string | null;
  latitude: number;
  longitude: number;
  point_type: PointType;
  service_point_id: string;
  service_point_version_id: string;
  street: string | null;
  version: number | string;
};
type ContextSegmentRow = {
  attribution: string | null;
  display_order: number;
  external_id: string;
  geometry_geojson: unknown;
  name: string | null;
  service_side: ServiceSide;
  source: SegmentSource;
  source_version: string | null;
  street_segment_id: string;
  street_segment_version_id: string;
};
type PointRow = {
  campaign_route_id: string;
  campaign_status: string;
  display_state: ProvisionalPointState;
  id: string;
  last_event_id: string | null;
  route_status: string;
  version: number | string;
};
type ReceiptRow = {
  actor_membership_id?: string | null;
  campaign_point_id?: string;
  device_id?: string;
  payload_hash: string;
  result_json: unknown;
  status: SyncCommandResult["status"];
  work_session_id?: string | null;
};
type EventRow = {
  campaign_point_id: string;
  id: string;
  previous_state: ProvisionalPointState;
  work_session_id: string | null;
};
type WorkSessionRow = {
  campaign_route_id: string;
  campaign_status: string;
  route_status: string;
  status: string;
};
type SequenceRow = { last_sequence: number | string };
type ChangeRow = { payload: unknown; sequence: number | string };

function validationError(
  code: "SYNC_INVALID_COMMAND" | "SYNC_INVALID_CONTEXT",
  error: z.ZodError,
): never {
  throw new DomainError(code, {
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
    statusCode: 400,
  });
}

async function lockActiveCommandScope(
  transaction: SqlExecutor,
  crewId: string,
  campaignPointId: string,
  workSessionId: string,
  membershipId: string,
  deviceId: string,
): Promise<PointRow> {
  const sessions = await transaction.query<WorkSessionRow>(
    `SELECT session.campaign_route_id,
            session.status,
            campaign.status AS campaign_status,
            assignment.status AS route_status
       FROM work_session AS session
       JOIN campaign_route AS assignment
         ON assignment.crew_id = session.crew_id
        AND assignment.campaign_id = session.campaign_id
        AND assignment.id = session.campaign_route_id
       JOIN campaign
         ON campaign.crew_id = session.crew_id
        AND campaign.id = session.campaign_id
       WHERE session.crew_id = $1 AND session.id = $2
       LIMIT 1
       FOR UPDATE OF session
       FOR SHARE OF campaign, assignment`,
    [crewId, workSessionId],
  );
  const session = sessions.rows[0];
  if (!session) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 404 });
  if (session.campaign_status !== "ACTIVE") {
    throw new DomainError("CAMPAIGN_NOT_ACTIVE", {
      details: { campaignStatus: session.campaign_status, requiredStatus: "ACTIVE" },
      statusCode: 409,
    });
  }
  if (session.route_status !== "ACTIVE") {
    throw new DomainError("CAMPAIGN_ROUTE_NOT_ACTIVE", {
      details: { requiredStatus: "ACTIVE", routeStatus: session.route_status },
      statusCode: 409,
    });
  }
  if (session.status !== "ACTIVE") {
    throw new DomainError("WORK_SESSION_NOT_ACTIVE", {
      details: { status: session.status },
      statusCode: 409,
    });
  }

  const points = await transaction.query<PointRow>(
    `SELECT point.id, point.campaign_route_id,
            point.display_state, point.version, point.last_event_id,
            campaign.status AS campaign_status,
            assignment.status AS route_status
       FROM campaign_point AS point
       JOIN campaign
         ON campaign.crew_id = point.crew_id
        AND campaign.id = point.campaign_id
       JOIN campaign_route AS assignment
         ON assignment.crew_id = point.crew_id
        AND assignment.campaign_id = point.campaign_id
        AND assignment.id = point.campaign_route_id
       WHERE point.crew_id = $1 AND point.id = $2
       LIMIT 1
       FOR UPDATE OF point
       FOR SHARE OF campaign, assignment`,
    [crewId, campaignPointId],
  );
  const point = points.rows[0];
  if (!point) throw new DomainError("CAMPAIGN_POINT_NOT_FOUND", { statusCode: 404 });
  if (point.campaign_status !== "ACTIVE" || point.route_status !== "ACTIVE") {
    throw new DomainError("CAMPAIGN_NOT_ACTIVE", {
      details: {
        campaignStatus: point.campaign_status,
        requiredStatus: "ACTIVE",
        routeStatus: point.route_status,
      },
      statusCode: 409,
    });
  }
  if (point.campaign_route_id !== session.campaign_route_id) {
    throw new DomainError("WORK_SESSION_SCOPE_MISMATCH", {
      details: {
        campaignPointId,
        campaignRouteId: point.campaign_route_id,
        workSessionId,
        workSessionRouteId: session.campaign_route_id,
      },
      statusCode: 409,
    });
  }
  const device = await transaction.query<{ membership_id: string }>(
    `SELECT membership_id
       FROM session_device
       WHERE crew_id = $1
         AND work_session_id = $2
         AND campaign_route_id = $3
         AND device_id = $4
       LIMIT 1`,
    [crewId, workSessionId, session.campaign_route_id, deviceId],
  );
  if (!device.rows[0] || device.rows[0].membership_id !== membershipId) {
    throw new DomainError("WORK_SESSION_PARTICIPATION_REQUIRED", {
      details: { deviceId, workSessionId },
      statusCode: 403,
    });
  }
  return point;
}

async function requireCapability(
  executor: SqlExecutor,
  crewId: string,
  userId: string,
  capability: Capability,
): Promise<string> {
  const result = await executor.query<MembershipRow>(
    `SELECT m.id, mc.capability_code
       FROM crew_membership m
       JOIN crew c ON c.id = m.crew_id AND c.status = 'ACTIVE'
       LEFT JOIN membership_capability mc
         ON mc.crew_id = m.crew_id
        AND mc.membership_id = m.id
        AND mc.capability_code = $3
       WHERE m.crew_id = $1
         AND m.user_id = $2
         AND m.status = 'ACTIVE'
       LIMIT 1`,
    [crewId, userId, capability],
  );
  const membership = result.rows[0];
  if (!membership || membership.capability_code !== capability) {
    throw new DomainError("CAPABILITY_REQUIRED", {
      details: { capability },
      statusCode: 403,
    });
  }
  return membership.id;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, candidate]) => [key, canonicalize(candidate)]),
    );
  }
  return value;
}

function commandPayloadHash(command: SyncCommand): string {
  const { operationId: _operationId, ...semanticPayload } = command;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(semanticPayload)))
    .digest("hex");
}

function parseJson<Value>(value: unknown): Value {
  return (typeof value === "string" ? JSON.parse(value) : value) as Value;
}

function mapContext(row: ContextRow): TechnicalContextSummary {
  return {
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    contentHash: row.content_hash,
    id: row.context_id,
    pointCount: Number(row.point_count),
    routeId: row.route_id,
    routeName: row.route_name,
    routeRevisionId: row.route_revision_id,
    segmentCount: Number(row.segment_count),
    ...(row.vehicle_id === null ? {} : { vehicleId: row.vehicle_id }),
    ...(row.vehicle_name === null ? {} : { vehicleName: row.vehicle_name }),
  };
}

function mapContextPoint(row: ContextPointRow): TechnicalContextPoint {
  return {
    displayOrder: Number(row.display_order),
    displayState: row.display_state,
    externalId: row.external_id,
    id: row.campaign_point_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    ...(row.house_number === null ? {} : { number: row.house_number }),
    pointType: row.point_type,
    servicePointId: row.service_point_id,
    servicePointVersionId: row.service_point_version_id,
    ...(row.street === null ? {} : { street: row.street }),
    version: Number(row.version),
  };
}

function mapContextSegment(row: ContextSegmentRow): TechnicalContextSegment {
  return {
    displayOrder: Number(row.display_order),
    externalId: row.external_id,
    geometry: parseStoredGeometry<MultiLineStringGeometry>(row.geometry_geojson),
    id: row.street_segment_id,
    serviceSide: row.service_side,
    source: row.source,
    streetSegmentVersionId: row.street_segment_version_id,
    ...(row.attribution === null ? {} : { attribution: row.attribution }),
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.source_version === null ? {} : { sourceVersion: row.source_version }),
  };
}

async function loadContextRows(
  executor: SqlExecutor,
  crewId: string,
  contextId?: string,
): Promise<ContextRow[]> {
  return (
    await executor.query<ContextRow>(
      `SELECT cr.id AS context_id,
              c.id AS campaign_id,
              c.name AS campaign_name,
              cr.route_id,
              cr.route_revision_id,
              cr.route_content_hash AS content_hash,
              cr.point_count,
              rr.segment_count,
              cr.vehicle_id,
              vehicle.name AS vehicle_name,
              r.name AS route_name
         FROM campaign_route cr
         JOIN campaign c
           ON c.crew_id = cr.crew_id AND c.id = cr.campaign_id
         JOIN route r
           ON r.crew_id = cr.crew_id AND r.id = cr.route_id
         JOIN route_revision rr
           ON rr.crew_id = cr.crew_id
          AND rr.route_id = cr.route_id
          AND rr.id = cr.route_revision_id
         LEFT JOIN vehicle
           ON vehicle.crew_id = cr.crew_id AND vehicle.id = cr.vehicle_id
         WHERE cr.crew_id = $1
           AND c.status = 'ACTIVE'
           AND cr.status = 'ACTIVE'
           AND ($2::uuid IS NULL OR cr.id = $2)
         ORDER BY cr.created_at DESC, cr.id`,
      [crewId, contextId ?? null],
    )
  ).rows;
}

export class SyncService implements SyncServiceApi {
  constructor(private readonly database: DomainDatabase) {}

  async createTechnicalContext(
    rawInput: CreateTechnicalContextInput,
  ): Promise<TechnicalContextPackage> {
    const parsed = createContextSchema.safeParse(rawInput);
    if (!parsed.success) return validationError("SYNC_INVALID_CONTEXT", parsed.error);
    const input = parsed.data;

    const contextId = await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      const existing = await transaction.query<{ id: string }>(
        `SELECT cr.id
           FROM campaign_route cr
           JOIN campaign c
             ON c.crew_id = cr.crew_id AND c.id = cr.campaign_id
           WHERE cr.crew_id = $1
             AND cr.route_revision_id = $2
             AND c.technical_fixture = true
           LIMIT 1`,
        [input.crewId, input.routeRevisionId],
      );
      if (existing.rows[0]) return existing.rows[0].id;

      const revision = await transaction.query<RevisionRow>(
        `SELECT rr.route_id, rr.status, rr.content_hash, rr.point_count,
                r.name AS route_name
           FROM route_revision rr
           JOIN route r
             ON r.crew_id = rr.crew_id AND r.id = rr.route_id
           WHERE rr.crew_id = $1 AND rr.id = $2
           LIMIT 1
           FOR UPDATE`,
        [input.crewId, input.routeRevisionId],
      );
      const published = revision.rows[0];
      if (!published) {
        throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });
      }
      if (
        (published.status !== "PUBLISHED" && published.status !== "SUPERSEDED") ||
        !published.content_hash
      ) {
        throw new DomainError("INVALID_REVISION_STATE", {
          details: { status: published.status },
          statusCode: 409,
        });
      }

      const points = await transaction.query<RevisionPointRow>(
        `SELECT display_order, service_point_id, service_point_version_id
           FROM route_revision_point
           WHERE crew_id = $1 AND route_revision_id = $2
           ORDER BY display_order, service_point_id`,
        [input.crewId, input.routeRevisionId],
      );
      if (points.rows.length === 0 || points.rows.length !== Number(published.point_count)) {
        throw new DomainError("REVISION_EMPTY", { statusCode: 409 });
      }

      const campaignId = randomUUID();
      const newContextId = randomUUID();
      await transaction.query(
        `INSERT INTO campaign
           (crew_id, id, name, status, technical_fixture, created_by_membership_id)
         VALUES ($1, $2, $3, 'DRAFT', true, $4)`,
        [
          input.crewId,
          campaignId,
          input.campaignName ?? `Contexto técnico · ${published.route_name}`,
          membershipId,
        ],
      );
      await transaction.query(
        `INSERT INTO campaign_route
           (crew_id, id, campaign_id, route_id, route_revision_id,
            route_content_hash, point_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [
          input.crewId,
          newContextId,
          campaignId,
          published.route_id,
          input.routeRevisionId,
          published.content_hash,
          points.rows.length,
        ],
      );
      for (const point of points.rows) {
        await transaction.query(
          `INSERT INTO campaign_point
             (crew_id, id, campaign_id, campaign_route_id, service_point_id,
              service_point_version_id, display_order, display_state, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'SIN_VISITAR', 0)`,
          [
            input.crewId,
            randomUUID(),
            campaignId,
            newContextId,
            point.service_point_id,
            point.service_point_version_id,
            Number(point.display_order),
          ],
        );
      }
      await transaction.query(
        `UPDATE campaign
         SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, campaignId],
      );
      await transaction.query(
        `INSERT INTO audit_event
           (crew_id, id, actor_membership_id, action,
            aggregate_type, aggregate_id, metadata)
         VALUES ($1, $2, $3, 'TECHNICAL_CONTEXT_CREATED',
                 'CampaignRoute', $4, $5::jsonb)`,
        [
          input.crewId,
          randomUUID(),
          membershipId,
          newContextId,
          JSON.stringify({
            contractVersion: syncContractVersion,
            routeRevisionId: input.routeRevisionId,
            technicalFixture: true,
          }),
        ],
      );
      return newContextId;
    });

    const context = await this.getContextPackage({
      actorUserId: input.actorUserId,
      contextId,
      crewId: input.crewId,
    });
    if (!context) throw new DomainError("CONTEXT_NOT_FOUND", { statusCode: 500 });
    return context;
  }

  async listContexts(rawInput: ContextAccessInput): Promise<TechnicalContextSummary[]> {
    const parsed = contextAccessSchema.safeParse(rawInput);
    if (!parsed.success) return validationError("SYNC_INVALID_CONTEXT", parsed.error);
    await requireCapability(
      this.database,
      parsed.data.crewId,
      parsed.data.actorUserId,
      "ROUTE_VIEW",
    );
    return (await loadContextRows(this.database, parsed.data.crewId)).map(mapContext);
  }

  async getContextPackage(
    rawInput: GetContextPackageInput,
  ): Promise<TechnicalContextPackage | null> {
    const parsed = getContextSchema.safeParse(rawInput);
    if (!parsed.success) return validationError("SYNC_INVALID_CONTEXT", parsed.error);
    const input = parsed.data;
    await requireCapability(this.database, input.crewId, input.actorUserId, "ROUTE_VIEW");
    const row = (await loadContextRows(this.database, input.crewId, input.contextId))[0];
    if (!row) return null;
    const [points, segments] = await Promise.all([
      this.database.query<ContextPointRow>(
        `SELECT cp.id AS campaign_point_id,
              cp.display_order,
              cp.display_state,
              cp.version,
              cp.service_point_id,
              cp.service_point_version_id,
              sp.external_id,
              spv.latitude,
              spv.longitude,
              spv.street,
              spv.house_number,
              spv.point_type
         FROM campaign_point cp
         JOIN service_point sp
           ON sp.crew_id = cp.crew_id AND sp.id = cp.service_point_id
         JOIN service_point_version spv
           ON spv.crew_id = cp.crew_id
          AND spv.service_point_id = cp.service_point_id
          AND spv.id = cp.service_point_version_id
         WHERE cp.crew_id = $1 AND cp.campaign_route_id = $2
         ORDER BY cp.display_order, cp.id`,
        [input.crewId, input.contextId],
      ),
      this.database.query<ContextSegmentRow>(
        `SELECT rrs.display_order,
                rrs.service_side,
                segment.id AS street_segment_id,
                segment.external_id,
                version.id AS street_segment_version_id,
                version.name,
                version.geometry_geojson,
                version.source,
                version.source_version,
                version.attribution
           FROM route_revision_segment rrs
           JOIN route_street_segment segment
             ON segment.crew_id = rrs.crew_id
            AND segment.id = rrs.street_segment_id
           JOIN route_street_segment_version version
             ON version.crew_id = rrs.crew_id
            AND version.street_segment_id = rrs.street_segment_id
            AND version.id = rrs.street_segment_version_id
           WHERE rrs.crew_id = $1 AND rrs.route_revision_id = $2
           ORDER BY rrs.display_order, segment.id`,
        [input.crewId, row.route_revision_id],
      ),
    ]);
    return {
      context: mapContext(row),
      contractVersion: syncContractVersion,
      points: points.rows.map(mapContextPoint),
      segments: segments.rows.map(mapContextSegment),
    };
  }

  async pushCommands(rawInput: PushCommandsInput): Promise<PushCommandsResult> {
    const parsed = pushInputSchema.safeParse(rawInput);
    if (!parsed.success) return validationError("SYNC_INVALID_COMMAND", parsed.error);
    const input = parsed.data as PushCommandsInput;
    const identifiers = new Set<string>();
    for (const command of input.commands) {
      if (identifiers.has(command.operationId)) {
        throw new DomainError("SYNC_DUPLICATE_OPERATION_ID", { statusCode: 400 });
      }
      identifiers.add(command.operationId);
    }

    const results = await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "POINT_MARK",
      );
      if (input.commands.some((command) => command.type === "POINT_STATUS_REVERTED")) {
        await requireCapability(transaction, input.crewId, input.actorUserId, "POINT_CORRECT");
      }
      const byId = new Map(input.commands.map((command) => [command.operationId, command]));
      const completed = new Map<string, SyncCommandResult>();
      const pending = new Set(input.commands.map((command) => command.operationId));

      while (pending.size > 0) {
        let progressed = false;
        for (const operationId of [...pending]) {
          const command = byId.get(operationId) as SyncCommand;
          const dependencyId = command.dependsOnOperationId;
          if (dependencyId && pending.has(dependencyId)) continue;
          const dependencyCommand = dependencyId ? byId.get(dependencyId) : undefined;
          const dependencyResult = dependencyId ? completed.get(dependencyId) : undefined;
          const result = await this.processCommand(transaction, {
            command,
            crewId: input.crewId,
            dependencyCommand,
            dependencyResult,
            membershipId,
          });
          completed.set(operationId, result);
          pending.delete(operationId);
          progressed = true;
        }
        if (progressed) continue;

        // Remaining commands form an in-batch dependency cycle.
        for (const operationId of [...pending]) {
          const command = byId.get(operationId) as SyncCommand;
          const result = await this.persistNonApplied(transaction, {
            code: "DEPENDENCY_CYCLE",
            command,
            crewId: input.crewId,
            membershipId,
            payloadHash: commandPayloadHash(command),
            status: "BLOCKED_DEPENDENCY",
          });
          completed.set(operationId, result);
          pending.delete(operationId);
        }
      }
      return input.commands.map(
        (command) => completed.get(command.operationId) as SyncCommandResult,
      );
    });

    return { contractVersion: syncContractVersion, results };
  }

  async pullChanges(rawInput: PullChangesInput): Promise<PullChangesResult> {
    const parsed = pullInputSchema.safeParse(rawInput);
    if (!parsed.success) return validationError("SYNC_INVALID_COMMAND", parsed.error);
    const input = parsed.data;
    await requireCapability(this.database, input.crewId, input.actorUserId, "ROUTE_VIEW");
    const after = decodeSyncCursor(input.cursor, input.crewId);
    const rows = await this.database.query<ChangeRow>(
      `SELECT sequence, payload
         FROM sync_change
         WHERE crew_id = $1 AND sequence > $2
         ORDER BY sequence
         LIMIT $3`,
      [input.crewId, after, input.limit + 1],
    );
    const hasMore = rows.rows.length > input.limit;
    const selected = rows.rows.slice(0, input.limit);
    const changes = selected.map((row) => ({
      ...parseJson<Omit<SyncChange, "sequence">>(row.payload),
      sequence: Number(row.sequence),
    }));
    const lastSequence = changes.at(-1)?.sequence ?? after;
    return {
      changes,
      contractVersion: syncContractVersion,
      cursor: encodeSyncCursor(input.crewId, lastSequence),
      hasMore,
    };
  }

  private async processCommand(
    transaction: SqlExecutor,
    input: {
      command: SyncCommand;
      crewId: string;
      dependencyCommand: SyncCommand | undefined;
      dependencyResult: SyncCommandResult | undefined;
      membershipId: string;
    },
  ): Promise<SyncCommandResult> {
    const payloadHash = commandPayloadHash(input.command);
    const existing = await transaction.query<ReceiptRow>(
      `SELECT payload_hash, status, result_json,
              actor_membership_id, work_session_id
         FROM sync_operation_receipt
         WHERE crew_id = $1 AND operation_id = $2
         LIMIT 1`,
      [input.crewId, input.command.operationId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].payload_hash !== payloadHash ||
        existing.rows[0].actor_membership_id !== input.membershipId ||
        existing.rows[0].work_session_id !== input.command.workSessionId
      ) {
        throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
          details: { operationId: input.command.operationId },
          statusCode: 409,
        });
      }
      return { ...parseJson<SyncCommandResult>(existing.rows[0].result_json), replayed: true };
    }

    const point = await lockActiveCommandScope(
      transaction,
      input.crewId,
      input.command.campaignPointId,
      input.command.workSessionId,
      input.membershipId,
      input.command.deviceId,
    );
    const currentVersion = Number(point.version);

    let dependencyResult = input.dependencyResult;
    let dependencyDeviceId = input.dependencyCommand?.deviceId;
    if (input.command.dependsOnOperationId && !dependencyResult) {
      const dependency = await transaction.query<ReceiptRow>(
        `SELECT payload_hash, status, result_json, device_id, campaign_point_id,
                actor_membership_id, work_session_id
           FROM sync_operation_receipt
           WHERE crew_id = $1 AND operation_id = $2
           LIMIT 1`,
        [input.crewId, input.command.dependsOnOperationId],
      );
      if (dependency.rows[0]) {
        dependencyResult = parseJson<SyncCommandResult>(dependency.rows[0].result_json);
        dependencyDeviceId = dependency.rows[0].device_id;
      }
    }
    if (input.command.dependsOnOperationId) {
      if (dependencyResult?.status !== "APPLIED") {
        return this.persistNonApplied(transaction, {
          code: "DEPENDENCY_NOT_CONFIRMED",
          command: input.command,
          crewId: input.crewId,
          membershipId: input.membershipId,
          payloadHash,
          status: "BLOCKED_DEPENDENCY",
        });
      }
      if (
        dependencyResult.campaignPointId !== input.command.campaignPointId ||
        dependencyResult.workSessionId !== input.command.workSessionId ||
        dependencyDeviceId !== input.command.deviceId ||
        dependencyResult.version !== currentVersion
      ) {
        return this.persistNonApplied(transaction, {
          code:
            dependencyDeviceId !== input.command.deviceId
              ? "DEPENDENCY_DEVICE_MISMATCH"
              : "DEPENDENCY_NOT_CURRENT",
          command: input.command,
          crewId: input.crewId,
          membershipId: input.membershipId,
          payloadHash,
          state: point.display_state,
          status: "CONFLICT",
          version: currentVersion,
        });
      }
    } else if (input.command.baseVersion !== currentVersion) {
      return this.persistNonApplied(transaction, {
        code: "BASE_VERSION_MISMATCH",
        command: input.command,
        crewId: input.crewId,
        membershipId: input.membershipId,
        payloadHash,
        state: point.display_state,
        status: "CONFLICT",
        version: currentVersion,
      });
    }

    let nextState: ProvisionalPointState;
    let revertsEventId: string | undefined;
    if (input.command.type === "POINT_STATUS_CHANGED") {
      nextState = input.command.payload.state;
    } else {
      if (input.command.dependsOnOperationId !== input.command.payload.revertsOperationId) {
        return this.persistNonApplied(transaction, {
          code: "UNDO_REQUIRES_CAUSAL_DEPENDENCY",
          command: input.command,
          crewId: input.crewId,
          membershipId: input.membershipId,
          payloadHash,
          state: point.display_state,
          status: "REJECTED",
          version: currentVersion,
        });
      }
      const reverted = await transaction.query<EventRow>(
        `SELECT id, campaign_point_id, previous_state, work_session_id
           FROM point_event
           WHERE crew_id = $1 AND operation_id = $2
           LIMIT 1`,
        [input.crewId, input.command.payload.revertsOperationId],
      );
      const target = reverted.rows[0];
      if (
        !target ||
        target.campaign_point_id !== input.command.campaignPointId ||
        target.work_session_id !== input.command.workSessionId
      ) {
        return this.persistNonApplied(transaction, {
          code: "UNDO_TARGET_NOT_FOUND",
          command: input.command,
          crewId: input.crewId,
          membershipId: input.membershipId,
          payloadHash,
          state: point.display_state,
          status: "REJECTED",
          version: currentVersion,
        });
      }
      if (point.last_event_id !== target.id) {
        return this.persistNonApplied(transaction, {
          code: "UNDO_TARGET_NOT_CURRENT",
          command: input.command,
          crewId: input.crewId,
          membershipId: input.membershipId,
          payloadHash,
          state: point.display_state,
          status: "CONFLICT",
          version: currentVersion,
        });
      }
      nextState = target.previous_state;
      revertsEventId = target.id;
    }

    if (nextState === point.display_state) {
      return this.persistNonApplied(transaction, {
        code: "NO_STATE_CHANGE",
        command: input.command,
        crewId: input.crewId,
        membershipId: input.membershipId,
        payloadHash,
        state: point.display_state,
        status: "REJECTED",
        version: currentVersion,
      });
    }

    const sequence = await transaction.query<SequenceRow>(
      `INSERT INTO sync_sequence (crew_id, last_sequence)
       VALUES ($1, 1)
       ON CONFLICT (crew_id) DO UPDATE
         SET last_sequence = sync_sequence.last_sequence + 1
       RETURNING last_sequence`,
      [input.crewId],
    );
    const changeSequence = Number(sequence.rows[0]?.last_sequence);
    const eventId = randomUUID();
    const nextVersion = currentVersion + 1;
    await transaction.query(
      `INSERT INTO point_event
         (crew_id, id, operation_id, campaign_point_id,
          campaign_route_id, work_session_id,
          actor_membership_id, device_id, event_type,
          base_version, applied_version, previous_state, next_state,
          depends_on_operation_id, reverts_event_id, occurred_at_device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14, $15, $16)`,
      [
        input.crewId,
        eventId,
        input.command.operationId,
        input.command.campaignPointId,
        point.campaign_route_id,
        input.command.workSessionId,
        input.membershipId,
        input.command.deviceId,
        input.command.type,
        input.command.baseVersion,
        nextVersion,
        point.display_state,
        nextState,
        input.command.dependsOnOperationId ?? null,
        revertsEventId ?? null,
        input.command.occurredAtDevice ?? null,
      ],
    );
    await transaction.query(
      `UPDATE campaign_point
         SET display_state = $3,
             version = $4,
             last_event_id = $5,
             updated_at = CURRENT_TIMESTAMP
       WHERE crew_id = $1 AND id = $2 AND version = $6`,
      [
        input.crewId,
        input.command.campaignPointId,
        nextState,
        nextVersion,
        eventId,
        currentVersion,
      ],
    );
    const change: SyncChange = {
      campaignPointId: input.command.campaignPointId,
      eventId,
      operationId: input.command.operationId,
      ...(revertsEventId ? { revertsEventId } : {}),
      sequence: changeSequence,
      state: nextState,
      type: input.command.type,
      version: nextVersion,
      workSessionId: input.command.workSessionId,
    };
    const changePayload: Omit<SyncChange, "sequence"> = {
      campaignPointId: change.campaignPointId,
      eventId: change.eventId,
      operationId: change.operationId,
      ...(change.revertsEventId ? { revertsEventId: change.revertsEventId } : {}),
      state: change.state,
      type: change.type,
      version: change.version,
      workSessionId: input.command.workSessionId,
    };
    await transaction.query(
      `INSERT INTO sync_change
         (crew_id, sequence, event_id, campaign_point_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.crewId,
        changeSequence,
        eventId,
        input.command.campaignPointId,
        JSON.stringify(changePayload),
      ],
    );
    const result: SyncCommandResult = {
      campaignPointId: input.command.campaignPointId,
      changeSequence,
      eventId,
      operationId: input.command.operationId,
      replayed: false,
      state: nextState,
      status: "APPLIED",
      version: nextVersion,
      workSessionId: input.command.workSessionId,
    };
    await transaction.query(
      `INSERT INTO sync_operation_receipt
         (crew_id, operation_id, payload_hash, campaign_point_id,
          campaign_route_id, work_session_id, actor_membership_id,
          device_id, status, result_json, event_id, change_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'APPLIED', $9::jsonb, $10, $11)`,
      [
        input.crewId,
        input.command.operationId,
        payloadHash,
        input.command.campaignPointId,
        point.campaign_route_id,
        input.command.workSessionId,
        input.membershipId,
        input.command.deviceId,
        JSON.stringify(result),
        eventId,
        changeSequence,
      ],
    );
    return result;
  }

  private async persistNonApplied(
    transaction: SqlExecutor,
    input: {
      code: string;
      command: SyncCommand;
      crewId: string;
      membershipId: string;
      payloadHash: string;
      state?: ProvisionalPointState;
      status: "BLOCKED_DEPENDENCY" | "CONFLICT" | "REJECTED";
      version?: number;
    },
  ): Promise<SyncCommandResult> {
    const existing = await transaction.query<ReceiptRow>(
      `SELECT payload_hash, status, result_json,
              actor_membership_id, work_session_id
         FROM sync_operation_receipt
         WHERE crew_id = $1 AND operation_id = $2
         LIMIT 1`,
      [input.crewId, input.command.operationId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].payload_hash !== input.payloadHash ||
        existing.rows[0].actor_membership_id !== input.membershipId ||
        existing.rows[0].work_session_id !== input.command.workSessionId
      ) {
        throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
          details: { operationId: input.command.operationId },
          statusCode: 409,
        });
      }
      return { ...parseJson<SyncCommandResult>(existing.rows[0].result_json), replayed: true };
    }
    const point = await lockActiveCommandScope(
      transaction,
      input.crewId,
      input.command.campaignPointId,
      input.command.workSessionId,
      input.membershipId,
      input.command.deviceId,
    );
    const result: SyncCommandResult = {
      campaignPointId: input.command.campaignPointId,
      code: input.code,
      operationId: input.command.operationId,
      replayed: false,
      ...(input.state ? { state: input.state } : {}),
      status: input.status,
      ...(input.version === undefined ? {} : { version: input.version }),
      workSessionId: input.command.workSessionId,
    };
    await transaction.query(
      `INSERT INTO sync_operation_receipt
         (crew_id, operation_id, payload_hash, campaign_point_id,
          campaign_route_id, work_session_id, actor_membership_id,
          device_id, status, result_json, event_id, change_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL, NULL)`,
      [
        input.crewId,
        input.command.operationId,
        input.payloadHash,
        input.command.campaignPointId,
        point.campaign_route_id,
        input.command.workSessionId,
        input.membershipId,
        input.command.deviceId,
        input.status,
        JSON.stringify(result),
      ],
    );
    return result;
  }
}
