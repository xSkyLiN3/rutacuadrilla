import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Capability } from "../constants.js";
import type { DomainDatabase, SqlExecutor } from "../database/types.js";
import { DomainError } from "../errors.js";
import type { SegmentSource, ServiceSide } from "../routes/types.js";
import type {
  AssignCampaignRouteInput,
  AssignCampaignRouteResult,
  CampaignAccessInput,
  CampaignDetailView,
  CampaignRouteAssignmentView,
  CampaignServiceApi,
  CampaignStatus,
  CampaignSummaryView,
  CreateCampaignInput,
  CreateVehicleInput,
  RemoveCampaignRouteInput,
  VehicleStatus,
  VehicleView,
} from "./types.js";

type Temporal = Date | string;
type MembershipRow = { capability_code: string | null; id: string };
type CampaignStateRow = {
  id: string;
  status: CampaignStatus;
  technical_fixture: boolean;
};
type CampaignRow = {
  created_at: Temporal;
  currency: string;
  ends_on: Date | string | null;
  id: string;
  name: string;
  point_count: number | string;
  route_count: number | string;
  starts_on: Date | string | null;
  status: CampaignStatus;
  timezone: string;
  updated_at: Temporal;
};
type VehicleRow = {
  created_at: Temporal;
  id: string;
  name: string;
  registration: string | null;
  status: VehicleStatus;
};
type AssignmentRow = {
  created_at: Temporal;
  id: string;
  point_count: number;
  route_content_hash: string;
  route_id: string;
  route_name: string;
  route_revision_id: string;
  segment_side_claim_count: number | string;
  status: "ACTIVE" | "ARCHIVED" | "CLOSED";
  vehicle_created_at: Temporal;
  vehicle_id: string;
  vehicle_name: string;
  vehicle_registration: string | null;
  vehicle_status: VehicleStatus;
};
type RevisionRow = {
  content_hash: string | null;
  point_count: number;
  route_id: string;
  route_name: string;
  status: string;
};
type RevisionPointRow = {
  display_order: number;
  external_id: string;
  service_point_id: string;
  service_point_version_id: string;
};
type RevisionSegmentRow = {
  external_id: string;
  service_side: ServiceSide;
  source: SegmentSource;
  street_segment_id: string;
  street_segment_version_id: string;
};
type ExistingAssignmentRow = {
  id: string;
  route_id: string;
  route_name: string;
  route_revision_id: string;
  vehicle_id: string | null;
  vehicle_name: string | null;
};
type ExistingPointRow = {
  campaign_route_id: string;
  external_id: string;
  service_point_id: string;
};
type ExistingSideRow = {
  campaign_route_id: string;
  external_id: string;
  physical_side: "LEFT" | "RIGHT";
  source: SegmentSource;
  street_segment_id: string;
  street_segment_version_id: string;
};

const accessSchema = z.object({
  actorUserId: z.string().uuid(),
  campaignId: z.string().uuid(),
  crewId: z.string().uuid(),
});
const listSchema = accessSchema.omit({ campaignId: true });
const vehicleSchema = listSchema.extend({
  name: z.string().trim().min(1).max(120),
  registration: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .transform((value) => value.toUpperCase())
    .optional(),
});
const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/u));
const dateSchema = z.iso.date();
const campaignSchema = listSchema
  .extend({
    currency: currencySchema.optional(),
    endsOn: dateSchema.optional(),
    name: z.string().trim().min(1).max(160),
    startsOn: dateSchema.optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isValidTimeZone, { message: "Invalid IANA timezone" })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.startsOn && value.endsOn && value.startsOn > value.endsOn) {
      context.addIssue({
        code: "custom",
        message: "startsOn must be before or equal to endsOn",
        path: ["endsOn"],
      });
    }
  });
const assignmentSchema = accessSchema.extend({
  routeRevisionId: z.string().uuid(),
  vehicleId: z.string().uuid(),
});
const removalSchema = accessSchema.extend({ campaignRouteId: z.string().uuid() });

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validationError(error: z.ZodError): never {
  throw new DomainError("CAMPAIGN_INVALID_INPUT", {
    details: {
      issues: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    },
    statusCode: 400,
  });
}

async function requireCapability(
  executor: SqlExecutor,
  crewId: string,
  userId: string,
  capability: Capability,
): Promise<string> {
  const result = await executor.query<MembershipRow>(
    `SELECT membership.id, capability_grant.capability_code
       FROM crew_membership membership
       JOIN crew ON crew.id = membership.crew_id AND crew.status = 'ACTIVE'
       LEFT JOIN membership_capability capability_grant
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
  return membership.id;
}

function toIso(value: Temporal): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function mapVehicle(row: VehicleRow): VehicleView {
  return {
    createdAt: toIso(row.created_at),
    id: row.id,
    name: row.name,
    status: row.status,
    ...(row.registration === null ? {} : { registration: row.registration }),
  };
}

function mapCampaign(row: CampaignRow): CampaignSummaryView {
  return {
    createdAt: toIso(row.created_at),
    currency: row.currency,
    id: row.id,
    name: row.name,
    pointCount: Number(row.point_count),
    routeCount: Number(row.route_count),
    status: row.status,
    timezone: row.timezone,
    updatedAt: toIso(row.updated_at),
    ...(row.starts_on === null ? {} : { startsOn: toDate(row.starts_on) }),
    ...(row.ends_on === null ? {} : { endsOn: toDate(row.ends_on) }),
  };
}

function mapAssignment(row: AssignmentRow): CampaignRouteAssignmentView {
  return {
    createdAt: toIso(row.created_at),
    id: row.id,
    pointCount: Number(row.point_count),
    routeContentHash: row.route_content_hash,
    routeId: row.route_id,
    routeName: row.route_name,
    routeRevisionId: row.route_revision_id,
    segmentSideClaimCount: Number(row.segment_side_claim_count),
    status: row.status,
    vehicle: mapVehicle({
      created_at: row.vehicle_created_at,
      id: row.vehicle_id,
      name: row.vehicle_name,
      registration: row.vehicle_registration,
      status: row.vehicle_status,
    }),
  };
}

async function loadCampaignRows(
  executor: SqlExecutor,
  crewId: string,
  campaignId?: string,
): Promise<CampaignRow[]> {
  return (
    await executor.query<CampaignRow>(
      `SELECT campaign.id, campaign.name, campaign.timezone, campaign.currency,
              campaign.status, campaign.starts_on, campaign.ends_on,
              campaign.created_at, campaign.updated_at,
              COUNT(assignment.id)::int AS route_count,
              COALESCE(SUM(assignment.point_count), 0)::int AS point_count
         FROM campaign
         LEFT JOIN campaign_route assignment
           ON assignment.crew_id = campaign.crew_id
          AND assignment.campaign_id = campaign.id
         WHERE campaign.crew_id = $1
           AND campaign.technical_fixture = false
           AND ($2::uuid IS NULL OR campaign.id = $2)
         GROUP BY campaign.crew_id, campaign.id
         ORDER BY campaign.created_at DESC, campaign.id`,
      [crewId, campaignId ?? null],
    )
  ).rows;
}

async function loadAssignmentRows(
  executor: SqlExecutor,
  crewId: string,
  campaignId: string,
): Promise<AssignmentRow[]> {
  return (
    await executor.query<AssignmentRow>(
      `SELECT assignment.id, assignment.route_id, assignment.route_revision_id,
              assignment.route_content_hash, assignment.point_count,
              assignment.status, assignment.created_at,
              route.name AS route_name,
              vehicle.id AS vehicle_id, vehicle.name AS vehicle_name,
              vehicle.registration AS vehicle_registration,
              vehicle.status AS vehicle_status,
              vehicle.created_at AS vehicle_created_at,
              COUNT(claim.physical_side)::int AS segment_side_claim_count
         FROM campaign_route assignment
         JOIN route
           ON route.crew_id = assignment.crew_id
          AND route.id = assignment.route_id
         JOIN vehicle
           ON vehicle.crew_id = assignment.crew_id
          AND vehicle.id = assignment.vehicle_id
         LEFT JOIN campaign_route_segment_side claim
           ON claim.crew_id = assignment.crew_id
          AND claim.campaign_route_id = assignment.id
         WHERE assignment.crew_id = $1 AND assignment.campaign_id = $2
         GROUP BY assignment.crew_id, assignment.id, route.name,
                  vehicle.crew_id, vehicle.id
         ORDER BY assignment.created_at, assignment.id`,
      [crewId, campaignId],
    )
  ).rows;
}

async function loadCampaignDetail(
  executor: SqlExecutor,
  crewId: string,
  campaignId: string,
): Promise<CampaignDetailView | null> {
  const campaign = (await loadCampaignRows(executor, crewId, campaignId))[0];
  if (!campaign) return null;
  const routes = (await loadAssignmentRows(executor, crewId, campaignId)).map(mapAssignment);
  return { ...mapCampaign(campaign), routes };
}

async function insertAudit(
  executor: SqlExecutor,
  input: {
    action: string;
    actorMembershipId: string;
    aggregateId: string;
    aggregateType: string;
    crewId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_event
       (crew_id, id, actor_membership_id, action,
        aggregate_type, aggregate_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.crewId,
      randomUUID(),
      input.actorMembershipId,
      input.action,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

function sideKey(source: SegmentSource, externalId: string, side: "LEFT" | "RIGHT"): string {
  return `${source}\u0000${externalId.trim().toLocaleLowerCase("en-US")}\u0000${side}`;
}

function segmentIdentityKey(source: SegmentSource, externalId: string): string {
  return `${source}\u0000${externalId.trim().toLocaleLowerCase("en-US")}`;
}

function expandSides(serviceSide: ServiceSide): readonly ("LEFT" | "RIGHT")[] {
  return serviceSide === "BOTH" ? ["LEFT", "RIGHT"] : [serviceSide];
}

async function requireEditableCampaign(
  executor: SqlExecutor,
  crewId: string,
  campaignId: string,
): Promise<CampaignStateRow> {
  const campaign = (
    await executor.query<CampaignStateRow>(
      `SELECT id, status, technical_fixture
         FROM campaign
         WHERE crew_id = $1 AND id = $2 AND technical_fixture = false
         LIMIT 1
         FOR UPDATE`,
      [crewId, campaignId],
    )
  ).rows[0];
  if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 404 });
  if (campaign.status !== "DRAFT") {
    throw new DomainError("CAMPAIGN_INVALID_STATE", {
      details: { actualStatus: campaign.status, requiredStatus: "DRAFT" },
      statusCode: 409,
    });
  }
  return campaign;
}

export class CampaignService implements CampaignServiceApi {
  constructor(private readonly database: DomainDatabase) {}

  async createVehicle(rawInput: CreateVehicleInput): Promise<VehicleView> {
    const parsed = vehicleSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    const vehicleId = randomUUID();

    await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      // Serializa las altas de vehículos de una tripulación para que dos
      // solicitudes concurrentes reciban el mismo 409 de dominio en vez de
      // dejar que el índice único se convierta en un error de infraestructura.
      await transaction.query(`SELECT id FROM crew WHERE id = $1 FOR UPDATE`, [input.crewId]);
      const duplicate = (
        await transaction.query<{ id: string; name: string; registration: string | null }>(
          `SELECT id, name, registration
             FROM vehicle
             WHERE crew_id = $1
               AND (
                 lower(name) = lower($2)
                 OR ($3::text IS NOT NULL AND lower(registration) = lower($3))
               )
             LIMIT 1`,
          [input.crewId, input.name, input.registration ?? null],
        )
      ).rows[0];
      if (duplicate) {
        throw new DomainError("VEHICLE_DUPLICATE", {
          details: {
            conflict: {
              field:
                duplicate.name.toLocaleLowerCase("en-US") === input.name.toLocaleLowerCase("en-US")
                  ? "name"
                  : "registration",
              name: duplicate.name,
              vehicleId: duplicate.id,
            },
          },
          statusCode: 409,
        });
      }

      await transaction.query(
        `INSERT INTO vehicle
           (crew_id, id, name, registration, status, created_by_membership_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
        [input.crewId, vehicleId, input.name, input.registration ?? null, membershipId],
      );
      await insertAudit(transaction, {
        action: "VEHICLE_CREATED",
        actorMembershipId: membershipId,
        aggregateId: vehicleId,
        aggregateType: "Vehicle",
        crewId: input.crewId,
        metadata: { name: input.name },
      });
    });

    const vehicle = (
      await this.database.query<VehicleRow>(
        `SELECT id, name, registration, status, created_at
           FROM vehicle WHERE crew_id = $1 AND id = $2`,
        [input.crewId, vehicleId],
      )
    ).rows[0];
    if (!vehicle) throw new DomainError("VEHICLE_NOT_FOUND", { statusCode: 500 });
    return mapVehicle(vehicle);
  }

  async listVehicles(rawInput: Omit<CampaignAccessInput, "campaignId">): Promise<VehicleView[]> {
    const parsed = listSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    await requireCapability(
      this.database,
      parsed.data.crewId,
      parsed.data.actorUserId,
      "ROUTE_VIEW",
    );
    const vehicles = await this.database.query<VehicleRow>(
      `SELECT id, name, registration, status, created_at
         FROM vehicle
         WHERE crew_id = $1
         ORDER BY status, lower(name), id`,
      [parsed.data.crewId],
    );
    return vehicles.rows.map(mapVehicle);
  }

  async createCampaign(rawInput: CreateCampaignInput): Promise<CampaignDetailView> {
    const parsed = campaignSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;
    const campaignId = randomUUID();

    await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      const crew = (
        await transaction.query<{ currency: string; timezone: string }>(
          `SELECT currency, timezone FROM crew WHERE id = $1 AND status = 'ACTIVE' LIMIT 1`,
          [input.crewId],
        )
      ).rows[0];
      if (!crew) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 404 });
      const timezone = input.timezone ?? crew.timezone;
      if (!isValidTimeZone(timezone)) {
        throw new DomainError("CAMPAIGN_INVALID_INPUT", {
          details: { issues: [{ field: "timezone", message: "Invalid IANA timezone" }] },
          statusCode: 400,
        });
      }

      await transaction.query(
        `INSERT INTO campaign
           (crew_id, id, name, timezone, currency, status, technical_fixture,
            starts_on, ends_on, created_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, 'DRAFT', false, $6, $7, $8)`,
        [
          input.crewId,
          campaignId,
          input.name,
          timezone,
          input.currency ?? crew.currency,
          input.startsOn ?? null,
          input.endsOn ?? null,
          membershipId,
        ],
      );
      await insertAudit(transaction, {
        action: "CAMPAIGN_CREATED",
        actorMembershipId: membershipId,
        aggregateId: campaignId,
        aggregateType: "Campaign",
        crewId: input.crewId,
        metadata: {
          currency: input.currency ?? crew.currency,
          endsOn: input.endsOn ?? null,
          startsOn: input.startsOn ?? null,
          timezone,
        },
      });
    });

    const campaign = await loadCampaignDetail(this.database, input.crewId, campaignId);
    if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 500 });
    return campaign;
  }

  async listCampaigns(
    rawInput: Omit<CampaignAccessInput, "campaignId">,
  ): Promise<CampaignSummaryView[]> {
    const parsed = listSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    await requireCapability(
      this.database,
      parsed.data.crewId,
      parsed.data.actorUserId,
      "ROUTE_VIEW",
    );
    return (await loadCampaignRows(this.database, parsed.data.crewId)).map(mapCampaign);
  }

  async getCampaign(rawInput: CampaignAccessInput): Promise<CampaignDetailView | null> {
    const parsed = accessSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    await requireCapability(
      this.database,
      parsed.data.crewId,
      parsed.data.actorUserId,
      "ROUTE_VIEW",
    );
    return loadCampaignDetail(this.database, parsed.data.crewId, parsed.data.campaignId);
  }

  async assignRoute(rawInput: AssignCampaignRouteInput): Promise<AssignCampaignRouteResult> {
    const parsed = assignmentSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const assigned = await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      const campaign = (
        await transaction.query<CampaignStateRow>(
          `SELECT id, status, technical_fixture
             FROM campaign
             WHERE crew_id = $1 AND id = $2 AND technical_fixture = false
             LIMIT 1
             FOR UPDATE`,
          [input.crewId, input.campaignId],
        )
      ).rows[0];
      if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 404 });

      const revision = (
        await transaction.query<RevisionRow>(
          `SELECT revision.route_id, revision.status, revision.content_hash,
                  revision.point_count, route.name AS route_name
             FROM route_revision revision
             JOIN route
               ON route.crew_id = revision.crew_id
              AND route.id = revision.route_id
             WHERE revision.crew_id = $1 AND revision.id = $2
             LIMIT 1`,
          [input.crewId, input.routeRevisionId],
        )
      ).rows[0];
      if (!revision) throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });

      const existingAssignments = await transaction.query<ExistingAssignmentRow>(
        `SELECT assignment.id, assignment.route_id, assignment.route_revision_id,
                assignment.vehicle_id, route.name AS route_name,
                vehicle.name AS vehicle_name
           FROM campaign_route assignment
           JOIN route
             ON route.crew_id = assignment.crew_id AND route.id = assignment.route_id
           LEFT JOIN vehicle
             ON vehicle.crew_id = assignment.crew_id AND vehicle.id = assignment.vehicle_id
           WHERE assignment.crew_id = $1
             AND assignment.campaign_id = $2
             AND (assignment.route_id = $3 OR assignment.vehicle_id = $4)`,
        [input.crewId, input.campaignId, revision.route_id, input.vehicleId],
      );
      const identical = existingAssignments.rows.find(
        (candidate) =>
          candidate.route_revision_id === input.routeRevisionId &&
          candidate.vehicle_id === input.vehicleId,
      );
      if (identical) return { created: false, id: identical.id };

      if (campaign.status !== "DRAFT") {
        throw new DomainError("CAMPAIGN_INVALID_STATE", {
          details: { actualStatus: campaign.status, requiredStatus: "DRAFT" },
          statusCode: 409,
        });
      }
      if (
        (revision.status !== "PUBLISHED" && revision.status !== "SUPERSEDED") ||
        !revision.content_hash
      ) {
        throw new DomainError("CAMPAIGN_ROUTE_REVISION_INVALID", {
          details: {
            route: { id: revision.route_id, name: revision.route_name },
            routeRevisionId: input.routeRevisionId,
            status: revision.status,
          },
          statusCode: 409,
        });
      }

      const conflictingRoute = existingAssignments.rows.find(
        (candidate) => candidate.route_id === revision.route_id,
      );
      if (conflictingRoute) {
        throw new DomainError("CAMPAIGN_ROUTE_DUPLICATE", {
          details: {
            conflict: {
              campaignRouteId: conflictingRoute.id,
              route: { id: conflictingRoute.route_id, name: conflictingRoute.route_name },
              routeRevisionId: conflictingRoute.route_revision_id,
            },
          },
          statusCode: 409,
        });
      }
      const conflictingVehicle = existingAssignments.rows.find(
        (candidate) => candidate.vehicle_id === input.vehicleId,
      );
      if (conflictingVehicle) {
        throw new DomainError("CAMPAIGN_VEHICLE_DUPLICATE", {
          details: {
            conflict: {
              campaignRouteId: conflictingVehicle.id,
              route: { id: conflictingVehicle.route_id, name: conflictingVehicle.route_name },
              vehicle: {
                id: conflictingVehicle.vehicle_id,
                name: conflictingVehicle.vehicle_name,
              },
            },
          },
          statusCode: 409,
        });
      }

      const vehicle = (
        await transaction.query<{ id: string; name: string }>(
          `SELECT id, name FROM vehicle
             WHERE crew_id = $1 AND id = $2 AND status = 'ACTIVE'
             LIMIT 1`,
          [input.crewId, input.vehicleId],
        )
      ).rows[0];
      if (!vehicle) throw new DomainError("VEHICLE_NOT_FOUND", { statusCode: 404 });

      const points = await transaction.query<RevisionPointRow>(
        `SELECT link.display_order, link.service_point_id,
                link.service_point_version_id, point.external_id
           FROM route_revision_point link
           JOIN service_point point
             ON point.crew_id = link.crew_id AND point.id = link.service_point_id
           WHERE link.crew_id = $1 AND link.route_revision_id = $2
           ORDER BY link.display_order, link.service_point_id`,
        [input.crewId, input.routeRevisionId],
      );
      if (points.rows.length === 0 || points.rows.length !== Number(revision.point_count)) {
        throw new DomainError("REVISION_EMPTY", { statusCode: 409 });
      }

      const existingPoints = await transaction.query<ExistingPointRow>(
        `SELECT point.campaign_route_id, point.service_point_id,
                identity.external_id
           FROM campaign_point point
           JOIN service_point identity
             ON identity.crew_id = point.crew_id
            AND identity.id = point.service_point_id
           WHERE point.crew_id = $1 AND point.campaign_id = $2`,
        [input.crewId, input.campaignId],
      );
      const existingPointsById = new Map(
        existingPoints.rows.map((point) => [point.service_point_id, point]),
      );
      const pointConflicts = points.rows
        .map((point) => existingPointsById.get(point.service_point_id))
        .filter((point): point is ExistingPointRow => point !== undefined);
      if (pointConflicts.length > 0) {
        throw new DomainError("CAMPAIGN_POINT_DUPLICATE", {
          details: {
            conflictCount: pointConflicts.length,
            conflicts: pointConflicts.slice(0, 20).map((point) => ({
              campaignRouteId: point.campaign_route_id,
              servicePointExternalId: point.external_id,
              servicePointId: point.service_point_id,
            })),
          },
          statusCode: 409,
        });
      }

      const segments = await transaction.query<RevisionSegmentRow>(
        `SELECT segment.id AS street_segment_id,
                version.id AS street_segment_version_id,
                segment.source, segment.external_id, link.service_side
           FROM route_revision_segment link
           JOIN route_street_segment segment
             ON segment.crew_id = link.crew_id
            AND segment.id = link.street_segment_id
           JOIN route_street_segment_version version
             ON version.crew_id = link.crew_id
            AND version.street_segment_id = link.street_segment_id
            AND version.id = link.street_segment_version_id
           WHERE link.crew_id = $1 AND link.route_revision_id = $2
           ORDER BY link.display_order, segment.id`,
        [input.crewId, input.routeRevisionId],
      );
      const existingSides = await transaction.query<ExistingSideRow>(
        `SELECT campaign_route_id, source, external_id, physical_side,
                street_segment_id, street_segment_version_id
           FROM campaign_route_segment_side
           WHERE crew_id = $1 AND campaign_id = $2`,
        [input.crewId, input.campaignId],
      );
      const existingSidesByKey = new Map(
        existingSides.rows.map((claim) => [
          sideKey(claim.source, claim.external_id, claim.physical_side),
          claim,
        ]),
      );
      const existingSidesByIdentity = new Map<string, ExistingSideRow[]>();
      for (const claim of existingSides.rows) {
        const key = segmentIdentityKey(claim.source, claim.external_id);
        const claims = existingSidesByIdentity.get(key) ?? [];
        claims.push(claim);
        existingSidesByIdentity.set(key, claims);
      }
      const versionAmbiguities = segments.rows.flatMap((segment) =>
        expandSides(segment.service_side).flatMap((requestedPhysicalSide) =>
          (
            existingSidesByIdentity.get(segmentIdentityKey(segment.source, segment.external_id)) ??
            []
          ).flatMap((existing) =>
            existing.physical_side !== requestedPhysicalSide &&
            (existing.street_segment_id !== segment.street_segment_id ||
              existing.street_segment_version_id !== segment.street_segment_version_id)
              ? [
                  {
                    campaignRouteId: existing.campaign_route_id,
                    existingPhysicalSide: existing.physical_side,
                    existingStreetSegmentId: existing.street_segment_id,
                    existingStreetSegmentVersionId: existing.street_segment_version_id,
                    externalId: segment.external_id,
                    requestedPhysicalSide,
                    requestedStreetSegmentId: segment.street_segment_id,
                    requestedStreetSegmentVersionId: segment.street_segment_version_id,
                    source: segment.source,
                  },
                ]
              : [],
          ),
        ),
      );
      if (versionAmbiguities.length > 0) {
        throw new DomainError("CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS", {
          details: {
            conflictCount: versionAmbiguities.length,
            conflicts: versionAmbiguities.slice(0, 20),
            matchingRule: "source+normalizedExternalId+complementaryPhysicalSide",
            spatialInferenceUsed: false,
          },
          statusCode: 409,
        });
      }
      const sideConflicts = segments.rows.flatMap((segment) =>
        expandSides(segment.service_side).flatMap((physicalSide) => {
          const existing = existingSidesByKey.get(
            sideKey(segment.source, segment.external_id, physicalSide),
          );
          return existing
            ? [
                {
                  campaignRouteId: existing.campaign_route_id,
                  externalId: segment.external_id,
                  physicalSide,
                  source: segment.source,
                },
              ]
            : [];
        }),
      );
      if (sideConflicts.length > 0) {
        throw new DomainError("CAMPAIGN_SEGMENT_SIDE_DUPLICATE", {
          details: {
            conflictCount: sideConflicts.length,
            conflicts: sideConflicts.slice(0, 20),
            matchingRule: "source+normalizedExternalId+physicalSide",
            spatialInferenceUsed: false,
          },
          statusCode: 409,
        });
      }

      const campaignRouteId = randomUUID();
      await transaction.query(
        `INSERT INTO campaign_route
           (crew_id, id, campaign_id, route_id, route_revision_id,
            route_content_hash, point_count, status, vehicle_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
        [
          input.crewId,
          campaignRouteId,
          input.campaignId,
          revision.route_id,
          input.routeRevisionId,
          revision.content_hash,
          points.rows.length,
          input.vehicleId,
        ],
      );
      for (const point of points.rows) {
        await transaction.query(
          `INSERT INTO campaign_point
             (crew_id, id, campaign_id, campaign_route_id,
              service_point_id, service_point_version_id,
              display_order, display_state, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'SIN_VISITAR', 0)`,
          [
            input.crewId,
            randomUUID(),
            input.campaignId,
            campaignRouteId,
            point.service_point_id,
            point.service_point_version_id,
            Number(point.display_order),
          ],
        );
      }
      for (const segment of segments.rows) {
        for (const physicalSide of expandSides(segment.service_side)) {
          await transaction.query(
            `INSERT INTO campaign_route_segment_side
               (crew_id, campaign_id, campaign_route_id,
                street_segment_id, street_segment_version_id,
                source, external_id, physical_side)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              input.crewId,
              input.campaignId,
              campaignRouteId,
              segment.street_segment_id,
              segment.street_segment_version_id,
              segment.source,
              segment.external_id,
              physicalSide,
            ],
          );
        }
      }
      await transaction.query(
        `UPDATE campaign SET updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.campaignId],
      );
      await insertAudit(transaction, {
        action: "CAMPAIGN_ROUTE_ASSIGNED",
        actorMembershipId: membershipId,
        aggregateId: campaignRouteId,
        aggregateType: "CampaignRoute",
        crewId: input.crewId,
        metadata: {
          campaignId: input.campaignId,
          pointCount: points.rows.length,
          routeId: revision.route_id,
          routeRevisionId: input.routeRevisionId,
          segmentSideClaimCount: segments.rows.reduce(
            (count, segment) => count + expandSides(segment.service_side).length,
            0,
          ),
          vehicleId: input.vehicleId,
        },
      });
      return { created: true, id: campaignRouteId };
    });

    const campaign = await loadCampaignDetail(this.database, input.crewId, input.campaignId);
    const assignment = campaign?.routes.find((candidate) => candidate.id === assigned.id);
    if (!assignment) throw new DomainError("CAMPAIGN_ROUTE_NOT_FOUND", { statusCode: 500 });
    return { assignment, created: assigned.created };
  }

  async removeRoute(rawInput: RemoveCampaignRouteInput): Promise<CampaignDetailView> {
    const parsed = removalSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      await requireEditableCampaign(transaction, input.crewId, input.campaignId);
      const assignment = (
        await transaction.query<{
          id: string;
          point_count: number;
          route_id: string;
          route_revision_id: string;
          vehicle_id: string | null;
        }>(
          `SELECT id, route_id, route_revision_id, vehicle_id, point_count
             FROM campaign_route
             WHERE crew_id = $1 AND campaign_id = $2 AND id = $3
             LIMIT 1`,
          [input.crewId, input.campaignId, input.campaignRouteId],
        )
      ).rows[0];
      if (!assignment) {
        throw new DomainError("CAMPAIGN_ROUTE_NOT_FOUND", { statusCode: 404 });
      }

      const activity = (
        await transaction.query<{ event_count: string; receipt_count: string }>(
          `SELECT
             (SELECT COUNT(*)::text
                FROM point_event event
                JOIN campaign_point point
                  ON point.crew_id = event.crew_id
                 AND point.id = event.campaign_point_id
               WHERE point.crew_id = $1
                 AND point.campaign_route_id = $2) AS event_count,
             (SELECT COUNT(*)::text
                FROM sync_operation_receipt receipt
                JOIN campaign_point point
                  ON point.crew_id = receipt.crew_id
                 AND point.id = receipt.campaign_point_id
               WHERE point.crew_id = $1
                 AND point.campaign_route_id = $2) AS receipt_count`,
          [input.crewId, input.campaignRouteId],
        )
      ).rows[0];
      const eventCount = Number(activity?.event_count ?? 0);
      const receiptCount = Number(activity?.receipt_count ?? 0);
      if (eventCount > 0 || receiptCount > 0) {
        throw new DomainError("CAMPAIGN_ROUTE_HAS_ACTIVITY", {
          details: { eventCount, receiptCount },
          statusCode: 409,
        });
      }

      const claims = await transaction.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM campaign_route_segment_side
           WHERE crew_id = $1 AND campaign_route_id = $2`,
        [input.crewId, input.campaignRouteId],
      );
      await transaction.query(
        `DELETE FROM campaign_route_segment_side
         WHERE crew_id = $1 AND campaign_id = $2 AND campaign_route_id = $3`,
        [input.crewId, input.campaignId, input.campaignRouteId],
      );
      await transaction.query(
        `DELETE FROM campaign_point
         WHERE crew_id = $1 AND campaign_id = $2 AND campaign_route_id = $3`,
        [input.crewId, input.campaignId, input.campaignRouteId],
      );
      await transaction.query(
        `DELETE FROM campaign_route
         WHERE crew_id = $1 AND campaign_id = $2 AND id = $3`,
        [input.crewId, input.campaignId, input.campaignRouteId],
      );
      await transaction.query(
        `UPDATE campaign SET updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.campaignId],
      );
      await insertAudit(transaction, {
        action: "CAMPAIGN_ROUTE_REMOVED",
        actorMembershipId: membershipId,
        aggregateId: input.campaignRouteId,
        aggregateType: "CampaignRoute",
        crewId: input.crewId,
        metadata: {
          campaignId: input.campaignId,
          pointCount: Number(assignment.point_count),
          routeId: assignment.route_id,
          routeRevisionId: assignment.route_revision_id,
          segmentSideClaimCount: Number(claims.rows[0]?.count ?? 0),
          vehicleId: assignment.vehicle_id,
        },
      });
    });

    const campaign = await loadCampaignDetail(this.database, input.crewId, input.campaignId);
    if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 500 });
    return campaign;
  }

  async activateCampaign(rawInput: CampaignAccessInput): Promise<CampaignDetailView> {
    const parsed = accessSchema.safeParse(rawInput);
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "CAMPAIGN_MANAGE",
      );
      const campaign = (
        await transaction.query<CampaignStateRow>(
          `SELECT id, status, technical_fixture
             FROM campaign
             WHERE crew_id = $1 AND id = $2 AND technical_fixture = false
             LIMIT 1
             FOR UPDATE`,
          [input.crewId, input.campaignId],
        )
      ).rows[0];
      if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 404 });
      if (campaign.status === "ACTIVE") return;
      if (campaign.status !== "DRAFT") {
        throw new DomainError("CAMPAIGN_INVALID_STATE", {
          details: { actualStatus: campaign.status, requiredStatus: "DRAFT" },
          statusCode: 409,
        });
      }
      // Congela durante esta transacción el estado de los vehículos ya
      // asignados. Un futuro flujo de archivado concurrente deberá esperar a
      // que termine esta revalidación.
      await transaction.query(
        `SELECT vehicle.id
           FROM vehicle
           JOIN campaign_route AS assignment
             ON assignment.crew_id = vehicle.crew_id
            AND assignment.vehicle_id = vehicle.id
          WHERE assignment.crew_id = $1 AND assignment.campaign_id = $2
          FOR SHARE OF vehicle`,
        [input.crewId, input.campaignId],
      );
      const composition = (
        await transaction.query<{
          invalid_route_count: number | string;
          invalid_vehicle_count: number | string;
          route_count: number | string;
        }>(
          `SELECT COUNT(*)::int AS route_count,
                  COUNT(*) FILTER (
                    WHERE assignment.status IS DISTINCT FROM 'ACTIVE'
                  )::int AS invalid_route_count,
                  COUNT(*) FILTER (
                    WHERE assignment.vehicle_id IS NULL
                       OR vehicle.status IS DISTINCT FROM 'ACTIVE'
                  )::int AS invalid_vehicle_count
             FROM campaign_route AS assignment
             LEFT JOIN vehicle
               ON vehicle.crew_id = assignment.crew_id
              AND vehicle.id = assignment.vehicle_id
             WHERE assignment.crew_id = $1 AND assignment.campaign_id = $2`,
          [input.crewId, input.campaignId],
        )
      ).rows[0];
      const routeCount = Number(composition?.route_count ?? 0);
      if (routeCount === 0) {
        throw new DomainError("CAMPAIGN_EMPTY", {
          details: { routeCount: 0 },
          statusCode: 409,
        });
      }
      if (Number(composition?.invalid_route_count ?? 0) > 0) {
        throw new DomainError("CAMPAIGN_ROUTE_NOT_ACTIVE", {
          details: { invalidRouteCount: Number(composition?.invalid_route_count ?? 0) },
          statusCode: 409,
        });
      }
      if (Number(composition?.invalid_vehicle_count ?? 0) > 0) {
        throw new DomainError("CAMPAIGN_VEHICLE_REQUIRED", {
          details: { invalidVehicleCount: Number(composition?.invalid_vehicle_count ?? 0) },
          statusCode: 409,
        });
      }

      await transaction.query(
        `UPDATE campaign
         SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.campaignId],
      );
      await insertAudit(transaction, {
        action: "CAMPAIGN_ACTIVATED",
        actorMembershipId: membershipId,
        aggregateId: input.campaignId,
        aggregateType: "Campaign",
        crewId: input.crewId,
        metadata: { routeCount },
      });
    });

    const campaign = await loadCampaignDetail(this.database, input.crewId, input.campaignId);
    if (!campaign) throw new DomainError("CAMPAIGN_NOT_FOUND", { statusCode: 500 });
    return campaign;
  }
}
