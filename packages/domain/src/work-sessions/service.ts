import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Capability } from "../constants.js";
import type { DomainDatabase, SqlExecutor } from "../database/types.js";
import { DomainError } from "../errors.js";
import type {
  CurrentWorkSessionInput,
  FinishWorkSessionInput,
  FinishWorkSessionResult,
  JoinWorkSessionInput,
  JoinWorkSessionResult,
  StartWorkSessionInput,
  StartWorkSessionResult,
  WorkSessionAccessInput,
  WorkSessionDeviceView,
  WorkSessionParticipantView,
  WorkSessionServiceApi,
  WorkSessionStatus,
  WorkSessionView,
} from "./types.js";

type Temporal = Date | string;
type MembershipRow = {
  capability_code: string | null;
  display_name: string;
  id: string;
  profile: "ASSISTANT" | "DRIVER" | "OTHER";
};
type CampaignRouteStateRow = {
  campaign_id: string;
  campaign_status: string;
  route_status: string;
};
type WorkSessionRow = {
  campaign_id: string;
  campaign_route_id: string;
  finished_at: Temporal | null;
  finished_by_membership_id: string | null;
  id: string;
  started_at: Temporal;
  started_by_device_id: string;
  started_by_membership_id: string;
  status: WorkSessionStatus;
  version: number | string;
};
type WorkSessionScopeRow = WorkSessionRow & {
  campaign_status: string;
  route_status: string;
};
type ParticipantRow = {
  display_name_snapshot: string;
  joined_at: Temporal;
  membership_id: string;
  profile_snapshot: "ASSISTANT" | "DRIVER" | "OTHER";
};
type DeviceRow = {
  device_id: string;
  joined_at: Temporal;
  membership_id: string;
};
type ReceiptRow = {
  operation_type: "FINISH" | "JOIN" | "START";
  payload_hash: string;
  result_json: unknown;
};

const baseAccessSchema = z.object({
  actorUserId: z.string().uuid(),
  crewId: z.string().uuid(),
});
const startSchema = baseAccessSchema.extend({
  campaignRouteId: z.string().uuid(),
  deviceId: z.string().uuid(),
  operationId: z.string().uuid(),
});
const workSessionAccessSchema = baseAccessSchema.extend({ workSessionId: z.string().uuid() });
const currentSchema = baseAccessSchema.extend({ campaignRouteId: z.string().uuid() });
const joinSchema = workSessionAccessSchema.extend({
  deviceId: z.string().uuid(),
  operationId: z.string().uuid(),
});
const finishSchema = workSessionAccessSchema.extend({
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
});

function validationError(error: z.ZodError): never {
  throw new DomainError("WORK_SESSION_INVALID_INPUT", {
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
    statusCode: 400,
  });
}

function toIso(value: Temporal): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function parseJson<Value>(value: unknown): Value {
  return (typeof value === "string" ? JSON.parse(value) : value) as Value;
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

function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

async function requireCapability(
  executor: SqlExecutor,
  crewId: string,
  userId: string,
  capability: Capability,
): Promise<MembershipRow> {
  const result = await executor.query<MembershipRow>(
    `SELECT membership.id,
            membership.profile,
            app_user.display_name,
            capability_grant.capability_code
       FROM crew_membership AS membership
       JOIN crew
         ON crew.id = membership.crew_id AND crew.status = 'ACTIVE'
       JOIN app_user
         ON app_user.id = membership.user_id AND app_user.status = 'ACTIVE'
       LEFT JOIN membership_capability AS capability_grant
         ON capability_grant.crew_id = membership.crew_id
        AND capability_grant.membership_id = membership.id
        AND capability_grant.capability_code = $3
       WHERE membership.crew_id = $1
         AND membership.user_id = $2
         AND membership.status = 'ACTIVE'
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
  return membership;
}

function assertCampaignRouteActive(row: CampaignRouteStateRow): void {
  if (row.campaign_status !== "ACTIVE") {
    throw new DomainError("CAMPAIGN_NOT_ACTIVE", {
      details: { campaignStatus: row.campaign_status, requiredStatus: "ACTIVE" },
      statusCode: 409,
    });
  }
  if (row.route_status !== "ACTIVE") {
    throw new DomainError("CAMPAIGN_ROUTE_NOT_ACTIVE", {
      details: { requiredStatus: "ACTIVE", routeStatus: row.route_status },
      statusCode: 409,
    });
  }
}

async function readReceipt<Result extends { replayed: boolean }>(
  executor: SqlExecutor,
  input: {
    crewId: string;
    operationId: string;
    operationType: ReceiptRow["operation_type"];
    payloadHash: string;
  },
): Promise<Result | null> {
  const result = await executor.query<ReceiptRow>(
    `SELECT operation_type, payload_hash, result_json
       FROM work_session_operation_receipt
       WHERE crew_id = $1 AND operation_id = $2
       LIMIT 1`,
    [input.crewId, input.operationId],
  );
  const receipt = result.rows[0];
  if (!receipt) return null;
  if (
    receipt.operation_type !== input.operationType ||
    receipt.payload_hash !== input.payloadHash
  ) {
    throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
      details: { operationId: input.operationId },
      statusCode: 409,
    });
  }
  return { ...parseJson<Result>(receipt.result_json), replayed: true };
}

async function loadWorkSession(
  executor: SqlExecutor,
  crewId: string,
  workSessionId: string,
): Promise<WorkSessionView | null> {
  const sessionResult = await executor.query<WorkSessionRow>(
    `SELECT id, campaign_id, campaign_route_id, status, version,
            started_by_membership_id, started_by_device_id, started_at,
            finished_by_membership_id, finished_at
       FROM work_session
       WHERE crew_id = $1 AND id = $2
       LIMIT 1`,
    [crewId, workSessionId],
  );
  const session = sessionResult.rows[0];
  if (!session) return null;
  const [participantResult, deviceResult] = await Promise.all([
    executor.query<ParticipantRow>(
      `SELECT membership_id, display_name_snapshot, profile_snapshot, joined_at
         FROM session_participant
         WHERE crew_id = $1 AND work_session_id = $2
         ORDER BY joined_at, membership_id`,
      [crewId, workSessionId],
    ),
    executor.query<DeviceRow>(
      `SELECT membership_id, device_id, joined_at
         FROM session_device
         WHERE crew_id = $1 AND work_session_id = $2
         ORDER BY joined_at, device_id`,
      [crewId, workSessionId],
    ),
  ]);
  const participants: WorkSessionParticipantView[] = participantResult.rows.map((row) => ({
    displayName: row.display_name_snapshot,
    joinedAt: toIso(row.joined_at),
    membershipId: row.membership_id,
    profile: row.profile_snapshot,
  }));
  const devices: WorkSessionDeviceView[] = deviceResult.rows.map((row) => ({
    deviceId: row.device_id,
    joinedAt: toIso(row.joined_at),
    membershipId: row.membership_id,
  }));
  return {
    campaignId: session.campaign_id,
    campaignRouteId: session.campaign_route_id,
    devices,
    ...(session.finished_at === null ? {} : { finishedAt: toIso(session.finished_at) }),
    ...(session.finished_by_membership_id === null
      ? {}
      : { finishedByMembershipId: session.finished_by_membership_id }),
    id: session.id,
    participants,
    startedAt: toIso(session.started_at),
    startedByDeviceId: session.started_by_device_id,
    startedByMembershipId: session.started_by_membership_id,
    status: session.status,
    version: Number(session.version),
  };
}

async function insertReceipt(
  executor: SqlExecutor,
  input: {
    actorMembershipId: string;
    campaignRouteId: string;
    crewId: string;
    operationId: string;
    operationType: ReceiptRow["operation_type"];
    payloadHash: string;
    result: unknown;
    workSessionId: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO work_session_operation_receipt
       (crew_id, operation_id, operation_type, payload_hash,
        work_session_id, campaign_route_id, actor_membership_id, result_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.crewId,
      input.operationId,
      input.operationType,
      input.payloadHash,
      input.workSessionId,
      input.campaignRouteId,
      input.actorMembershipId,
      JSON.stringify(input.result),
    ],
  );
}

async function audit(
  executor: SqlExecutor,
  input: {
    action: string;
    actorMembershipId: string;
    crewId: string;
    metadata: Record<string, unknown>;
    workSessionId: string;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_event
       (crew_id, id, actor_membership_id, action, aggregate_type, aggregate_id, metadata)
     VALUES ($1, $2, $3, $4, 'WorkSession', $5, $6::jsonb)`,
    [
      input.crewId,
      randomUUID(),
      input.actorMembershipId,
      input.action,
      input.workSessionId,
      JSON.stringify(input.metadata),
    ],
  );
}

export class WorkSessionService implements WorkSessionServiceApi {
  constructor(private readonly database: DomainDatabase) {}

  async start(rawInput: StartWorkSessionInput): Promise<StartWorkSessionResult> {
    const parsed = startSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    return this.database.transaction(async (transaction) => {
      const membership = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "SESSION_START",
      );
      const hash = payloadHash({
        actorMembershipId: membership.id,
        campaignRouteId: input.campaignRouteId,
        crewId: input.crewId,
        deviceId: input.deviceId,
        operationType: "START",
      });
      const replay = await readReceipt<StartWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "START",
        payloadHash: hash,
      });
      if (replay) return replay;

      const routeResult = await transaction.query<CampaignRouteStateRow>(
        `SELECT assignment.campaign_id,
                campaign.status AS campaign_status,
                assignment.status AS route_status
           FROM campaign_route AS assignment
           JOIN campaign
             ON campaign.crew_id = assignment.crew_id
            AND campaign.id = assignment.campaign_id
           WHERE assignment.crew_id = $1 AND assignment.id = $2
           LIMIT 1
           FOR UPDATE OF assignment
           FOR SHARE OF campaign`,
        [input.crewId, input.campaignRouteId],
      );
      const route = routeResult.rows[0];
      if (!route) throw new DomainError("CAMPAIGN_ROUTE_NOT_FOUND", { statusCode: 404 });

      const concurrentReplay = await readReceipt<StartWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "START",
        payloadHash: hash,
      });
      if (concurrentReplay) return concurrentReplay;
      assertCampaignRouteActive(route);

      const open = await transaction.query<{ id: string; status: WorkSessionStatus }>(
        `SELECT id, status
           FROM work_session
           WHERE crew_id = $1
             AND campaign_route_id = $2
             AND status IN ('ACTIVE', 'FINISHED')
           LIMIT 1`,
        [input.crewId, input.campaignRouteId],
      );
      if (open.rows[0]) {
        throw new DomainError("WORK_SESSION_ALREADY_OPEN", {
          details: { status: open.rows[0].status, workSessionId: open.rows[0].id },
          statusCode: 409,
        });
      }

      const workSessionId = randomUUID();
      await transaction.query(
        `INSERT INTO work_session
           (crew_id, id, campaign_id, campaign_route_id,
            started_by_membership_id, started_by_device_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.crewId,
          workSessionId,
          route.campaign_id,
          input.campaignRouteId,
          membership.id,
          input.deviceId,
        ],
      );
      await transaction.query(
        `INSERT INTO session_participant
           (crew_id, work_session_id, campaign_route_id, membership_id,
            display_name_snapshot, profile_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.crewId,
          workSessionId,
          input.campaignRouteId,
          membership.id,
          membership.display_name,
          membership.profile,
        ],
      );
      await transaction.query(
        `INSERT INTO session_device
           (crew_id, work_session_id, campaign_route_id, membership_id, device_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.crewId, workSessionId, input.campaignRouteId, membership.id, input.deviceId],
      );
      await audit(transaction, {
        action: "WORK_SESSION_STARTED",
        actorMembershipId: membership.id,
        crewId: input.crewId,
        metadata: {
          campaignRouteId: input.campaignRouteId,
          operationIdHash: createHash("sha256").update(input.operationId).digest("hex"),
          version: 1,
        },
        workSessionId,
      });
      const workSession = await loadWorkSession(transaction, input.crewId, workSessionId);
      if (!workSession) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 500 });
      const result: StartWorkSessionResult = { created: true, replayed: false, workSession };
      await insertReceipt(transaction, {
        actorMembershipId: membership.id,
        campaignRouteId: input.campaignRouteId,
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "START",
        payloadHash: hash,
        result,
        workSessionId,
      });
      return result;
    });
  }

  async join(rawInput: JoinWorkSessionInput): Promise<JoinWorkSessionResult> {
    const parsed = joinSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    return this.database.transaction(async (transaction) => {
      const membership = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "SESSION_JOIN",
      );
      const hash = payloadHash({
        actorMembershipId: membership.id,
        crewId: input.crewId,
        deviceId: input.deviceId,
        operationType: "JOIN",
        workSessionId: input.workSessionId,
      });
      const replay = await readReceipt<JoinWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "JOIN",
        payloadHash: hash,
      });
      if (replay) return replay;

      const sessionResult = await transaction.query<WorkSessionScopeRow>(
        `SELECT session.id, session.campaign_id, session.campaign_route_id,
                session.status, session.version,
                session.started_by_membership_id, session.started_by_device_id,
                session.started_at, session.finished_by_membership_id, session.finished_at,
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
        [input.crewId, input.workSessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 404 });
      const concurrentReplay = await readReceipt<JoinWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "JOIN",
        payloadHash: hash,
      });
      if (concurrentReplay) return concurrentReplay;
      assertCampaignRouteActive(session);
      if (session.status !== "ACTIVE") {
        throw new DomainError("WORK_SESSION_NOT_ACTIVE", {
          details: { status: session.status },
          statusCode: 409,
        });
      }

      const participant = await transaction.query<{ membership_id: string }>(
        `SELECT membership_id
           FROM session_participant
           WHERE crew_id = $1 AND work_session_id = $2 AND membership_id = $3
           LIMIT 1`,
        [input.crewId, input.workSessionId, membership.id],
      );
      const device = await transaction.query<{ membership_id: string }>(
        `SELECT membership_id
           FROM session_device
           WHERE crew_id = $1 AND work_session_id = $2 AND device_id = $3
           LIMIT 1`,
        [input.crewId, input.workSessionId, input.deviceId],
      );
      if (device.rows[0] && device.rows[0].membership_id !== membership.id) {
        throw new DomainError("WORK_SESSION_DEVICE_CONFLICT", {
          details: { deviceId: input.deviceId },
          statusCode: 409,
        });
      }
      const participantJoined = !participant.rows[0];
      const deviceJoined = !device.rows[0];
      if (participantJoined) {
        await transaction.query(
          `INSERT INTO session_participant
             (crew_id, work_session_id, campaign_route_id, membership_id,
              display_name_snapshot, profile_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.crewId,
            input.workSessionId,
            session.campaign_route_id,
            membership.id,
            membership.display_name,
            membership.profile,
          ],
        );
      }
      if (deviceJoined) {
        await transaction.query(
          `INSERT INTO session_device
             (crew_id, work_session_id, campaign_route_id, membership_id, device_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            input.crewId,
            input.workSessionId,
            session.campaign_route_id,
            membership.id,
            input.deviceId,
          ],
        );
      }
      if (participantJoined || deviceJoined) {
        await transaction.query(
          `UPDATE work_session
           SET version = version + 1
           WHERE crew_id = $1 AND id = $2 AND status = 'ACTIVE'`,
          [input.crewId, input.workSessionId],
        );
        await audit(transaction, {
          action: "WORK_SESSION_JOINED",
          actorMembershipId: membership.id,
          crewId: input.crewId,
          metadata: {
            deviceJoined,
            operationIdHash: createHash("sha256").update(input.operationId).digest("hex"),
            participantJoined,
            previousVersion: Number(session.version),
            version: Number(session.version) + 1,
          },
          workSessionId: input.workSessionId,
        });
      }
      const workSession = await loadWorkSession(transaction, input.crewId, input.workSessionId);
      if (!workSession) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 500 });
      const result: JoinWorkSessionResult = {
        deviceJoined,
        participantJoined,
        replayed: false,
        workSession,
      };
      await insertReceipt(transaction, {
        actorMembershipId: membership.id,
        campaignRouteId: session.campaign_route_id,
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "JOIN",
        payloadHash: hash,
        result,
        workSessionId: input.workSessionId,
      });
      return result;
    });
  }

  async finish(rawInput: FinishWorkSessionInput): Promise<FinishWorkSessionResult> {
    const parsed = finishSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    return this.database.transaction(async (transaction) => {
      const membership = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "SESSION_START",
      );
      const hash = payloadHash({
        actorMembershipId: membership.id,
        crewId: input.crewId,
        expectedVersion: input.expectedVersion,
        operationType: "FINISH",
        workSessionId: input.workSessionId,
      });
      const replay = await readReceipt<FinishWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "FINISH",
        payloadHash: hash,
      });
      if (replay) return replay;

      const sessionResult = await transaction.query<WorkSessionScopeRow>(
        `SELECT session.id, session.campaign_id, session.campaign_route_id,
                session.status, session.version,
                session.started_by_membership_id, session.started_by_device_id,
                session.started_at, session.finished_by_membership_id, session.finished_at,
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
        [input.crewId, input.workSessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 404 });
      const concurrentReplay = await readReceipt<FinishWorkSessionResult>(transaction, {
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "FINISH",
        payloadHash: hash,
      });
      if (concurrentReplay) return concurrentReplay;
      assertCampaignRouteActive(session);
      const currentVersion = Number(session.version);
      if (currentVersion !== input.expectedVersion) {
        throw new DomainError("WORK_SESSION_VERSION_CONFLICT", {
          details: { actualVersion: currentVersion, expectedVersion: input.expectedVersion },
          statusCode: 409,
        });
      }
      if (session.status !== "ACTIVE") {
        throw new DomainError("WORK_SESSION_NOT_ACTIVE", {
          details: { status: session.status },
          statusCode: 409,
        });
      }
      const participant = await transaction.query<{ membership_id: string }>(
        `SELECT membership_id
           FROM session_participant
           WHERE crew_id = $1 AND work_session_id = $2 AND membership_id = $3
           LIMIT 1`,
        [input.crewId, input.workSessionId, membership.id],
      );
      if (!participant.rows[0]) {
        throw new DomainError("WORK_SESSION_PARTICIPATION_REQUIRED", { statusCode: 403 });
      }
      await transaction.query(
        `UPDATE work_session
           SET status = 'FINISHED',
               version = version + 1,
               finished_by_membership_id = $3,
               finished_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2 AND version = $4`,
        [input.crewId, input.workSessionId, membership.id, currentVersion],
      );
      await audit(transaction, {
        action: "WORK_SESSION_FINISHED",
        actorMembershipId: membership.id,
        crewId: input.crewId,
        metadata: {
          operationIdHash: createHash("sha256").update(input.operationId).digest("hex"),
          previousVersion: currentVersion,
          version: currentVersion + 1,
        },
        workSessionId: input.workSessionId,
      });
      const workSession = await loadWorkSession(transaction, input.crewId, input.workSessionId);
      if (!workSession) throw new DomainError("WORK_SESSION_NOT_FOUND", { statusCode: 500 });
      const result: FinishWorkSessionResult = { replayed: false, workSession };
      await insertReceipt(transaction, {
        actorMembershipId: membership.id,
        campaignRouteId: session.campaign_route_id,
        crewId: input.crewId,
        operationId: input.operationId,
        operationType: "FINISH",
        payloadHash: hash,
        result,
        workSessionId: input.workSessionId,
      });
      return result;
    });
  }

  async get(rawInput: WorkSessionAccessInput): Promise<WorkSessionView | null> {
    const parsed = workSessionAccessSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    await requireCapability(
      this.database,
      parsed.data.crewId,
      parsed.data.actorUserId,
      "ROUTE_VIEW",
    );
    return loadWorkSession(this.database, parsed.data.crewId, parsed.data.workSessionId);
  }

  async getCurrent(rawInput: CurrentWorkSessionInput): Promise<WorkSessionView | null> {
    const parsed = currentSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    await requireCapability(this.database, input.crewId, input.actorUserId, "ROUTE_VIEW");
    const routeResult = await this.database.query<CampaignRouteStateRow>(
      `SELECT assignment.campaign_id,
              campaign.status AS campaign_status,
              assignment.status AS route_status
         FROM campaign_route AS assignment
         JOIN campaign
           ON campaign.crew_id = assignment.crew_id
          AND campaign.id = assignment.campaign_id
         WHERE assignment.crew_id = $1 AND assignment.id = $2
         LIMIT 1`,
      [input.crewId, input.campaignRouteId],
    );
    const route = routeResult.rows[0];
    if (!route) throw new DomainError("CAMPAIGN_ROUTE_NOT_FOUND", { statusCode: 404 });
    assertCampaignRouteActive(route);
    const result = await this.database.query<{ id: string }>(
      `SELECT id
         FROM work_session
         WHERE crew_id = $1
           AND campaign_route_id = $2
           AND status IN ('ACTIVE', 'FINISHED')
         LIMIT 1`,
      [input.crewId, input.campaignRouteId],
    );
    const row = result.rows[0];
    return row ? loadWorkSession(this.database, input.crewId, row.id) : null;
  }
}
