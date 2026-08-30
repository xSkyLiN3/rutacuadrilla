import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Capability, PointSource, PointType } from "../constants.js";
import type { DomainDatabase, SqlExecutor } from "../database/types.js";
import { DomainError } from "../errors.js";
import {
  type CanonicalRoutePoint,
  type CsvPreview,
  canonicalImportHash,
  previewRouteCsv,
} from "./csv.js";
import {
  canonicalHash,
  type MultiPolygonGeometry,
  normalizeAreaGeometry,
  normalizeLineGeometry,
  normalizePointGeometry,
  parseStoredGeometry,
} from "./geometry.js";
import { previewOsmExport as parseOsmExport } from "./osm.js";
import { RouteRepository } from "./repository.js";
import type {
  ApplyRouteRevisionChangeInput,
  ApplyRouteRevisionChangeResult,
  CorrectDraftPointsInput,
  CorrectDraftPointsResult,
  EditableRoutePoint,
  EditableStreetSegment,
  ImportRouteInput,
  ImportRouteResult,
  OsmCandidatePreview,
  PublishRevisionInput,
  RouteDetailView,
  RoutePackageDto,
  RouteRevisionChange,
  RouteRevisionFeatures,
  RouteServiceApi,
  RouteSummaryView,
  SegmentSource,
  ServiceSide,
} from "./types.js";
import { serviceSides } from "./types.js";

const publishInputSchema = z.object({
  actorUserId: z.string().uuid(),
  crewId: z.string().uuid(),
  revisionId: z.string().uuid(),
  routeId: z.string().uuid(),
});

const correctDraftPointsInputSchema = publishInputSchema.extend({
  csv: z.string(),
  editKey: z.string().trim().min(1).max(120),
});

const editablePointSchema = z.object({
  externalId: z.string().trim().min(1).max(128),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  number: z.string().trim().max(50).optional(),
  pointType: z.enum(["DWELLING", "BUILDING_ENTRANCE", "COMPLEX_ACCESS", "SPECIAL"]),
  source: z.enum(["MANUAL", "CSV", "OSM", "GEOJSON"]),
  street: z.string().trim().max(200).optional(),
});

const editableSegmentSchema = z.object({
  attribution: z.string().trim().max(500).optional(),
  externalId: z.string().trim().min(1).max(160),
  geometry: z.unknown(),
  name: z.string().trim().max(200).optional(),
  serviceSide: z
    .enum(serviceSides, {
      error:
        "serviceSide debe ser LEFT, RIGHT o BOTH; LEFT/RIGHT se interpretan respecto al orden de coordenadas, no como orientación geográfica.",
    })
    .default("BOTH"),
  source: z.enum(["MANUAL", "OSM", "GEOJSON"]),
  sourceVersion: z.string().trim().max(120).optional(),
});

const importInputSchema = z.object({
  actorUserId: z.string().uuid(),
  area: z.unknown().nullable().optional(),
  crewId: z.string().uuid(),
  csv: z.string(),
  importKey: z.string().trim().min(1).max(120),
  routeName: z.string().trim().min(1).max(120),
  sectorName: z.string().trim().min(1).max(120),
  segments: z.array(editableSegmentSchema).max(10_000).optional(),
});

const routeRevisionChangeSchema = z.discriminatedUnion("type", [
  z.object({ geometry: z.unknown().nullable(), type: z.literal("SET_AREA") }),
  z.object({ point: editablePointSchema, type: z.literal("ADD_POINT") }),
  z.object({
    expectedServicePointVersionId: z.uuid().optional(),
    point: editablePointSchema
      .omit({ externalId: true, source: true })
      .partial()
      .refine((point) => Object.keys(point).length > 0, "Debe indicar al menos un cambio."),
    servicePointId: z.uuid(),
    type: z.literal("UPDATE_POINT"),
  }),
  z.object({ servicePointId: z.uuid(), type: z.literal("REMOVE_POINT") }),
  z.object({
    segments: z.array(editableSegmentSchema).max(10_000),
    type: z.literal("REPLACE_SEGMENTS"),
  }),
  z.object({
    points: z.array(editablePointSchema).max(10_000),
    segments: z.array(editableSegmentSchema).max(10_000),
    type: z.literal("IMPORT_OSM_SELECTION"),
  }),
]);

const applyRouteRevisionChangeInputSchema = publishInputSchema.extend({
  baseDraftVersion: z.number().int().positive(),
  change: routeRevisionChangeSchema,
  operationId: z.uuid(),
});

type MembershipRow = {
  capability_code: string | null;
  id: string;
};

type ImportReceiptRow = {
  payload_hash: string;
  revision_id: string;
  route_id: string;
};

type EditReceiptRow = {
  payload_hash: string;
  revision_id: string;
  route_id: string;
};

type ChangeReceiptRow = {
  payload_hash: string;
  result_json: unknown;
  revision_id: string;
  route_id: string;
};

type IdRow = { id: string };

type VersionRow = {
  id: string;
  version_number: number;
};

type RevisionStateRow = {
  area_version_id: string | null;
  draft_version: number;
  point_count: number;
  segment_count: number;
  status: "ARCHIVED" | "DRAFT" | "PUBLISHED" | "SUPERSEDED";
};

type CurrentPointRow = PublicationPointRow & {
  service_point_id: string;
  service_point_version_id: string;
};

type PublicationSegmentRow = {
  attribution: string | null;
  display_order: number;
  external_id: string;
  geometry_geojson: unknown;
  name: string | null;
  service_side: ServiceSide;
  source: SegmentSource;
  source_version: string | null;
};

type SegmentIdentityRow = {
  display_order: number;
  external_id: string;
  source: SegmentSource;
};

type AreaGeometryRow = { geometry_geojson: unknown };

type PublicationPointRow = {
  display_order: number;
  external_id: string;
  house_number: string | null;
  latitude: number;
  longitude: number;
  point_type: PointType;
  source: PointSource;
  street: string | null;
};

type CounterRow = { published_revision_sequence: number };

type ImportTransactionResult = {
  created: boolean;
  revisionId: string;
  routeId: string;
};

type EditTransactionResult = {
  replayed: boolean;
  revisionId: string;
  routeId: string;
};

type ChangeTransactionResult = ApplyRouteRevisionChangeResult;

function invalidInput(error: z.ZodError): never {
  throw new DomainError("CSV_INVALID", {
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
    message: "Los datos de la importación no son válidos.",
    statusCode: 400,
  });
}

function invalidRouteRevisionChange(error: z.ZodError): never {
  throw new DomainError("ROUTE_REVISION_CHANGE_INVALID", {
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
    message:
      "El cambio de revisión no es válido. LEFT/RIGHT siempre se interpretan respecto al orden de coordenadas del tramo, no como orientación geográfica.",
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
  if (!membership) {
    throw new DomainError("MEMBERSHIP_NOT_FOUND", {
      statusCode: 403,
    });
  }
  if (membership.capability_code !== capability) {
    throw new DomainError("CAPABILITY_REQUIRED", {
      details: { capability },
      statusCode: 403,
    });
  }
  return membership.id;
}

function pointVersionHash(point: CanonicalRoutePoint): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        latitude: point.latitude,
        longitude: point.longitude,
        number: point.number ?? null,
        pointType: point.pointType,
        source: point.source,
        street: point.street ?? null,
      }),
    )
    .digest("hex");
}

function canonicalPublicationPoints(points: readonly PublicationPointRow[]) {
  return points.map((point) => ({
    displayOrder: Number(point.display_order),
    externalId: point.external_id,
    latitude: Number(point.latitude),
    longitude: Number(point.longitude),
    number: point.house_number,
    pointType: point.point_type,
    source: point.source,
    street: point.street,
  }));
}

function canonicalPublicationHash(input: {
  area: MultiPolygonGeometry | null;
  points: readonly PublicationPointRow[];
  segments: readonly PublicationSegmentRow[];
}): string {
  return canonicalHash({
    area: input.area,
    points: canonicalPublicationPoints(input.points),
    schemaVersion: 2,
    segments: input.segments.map((segment) => ({
      attribution: segment.attribution,
      displayOrder: Number(segment.display_order),
      externalId: segment.external_id,
      geometry: parseStoredGeometry(segment.geometry_geojson),
      name: segment.name,
      source: segment.source,
      sourceVersion: segment.source_version,
      ...(segment.service_side === "BOTH" ? {} : { serviceSide: segment.service_side }),
    })),
  });
}

function draftEditHash(input: {
  revisionId: string;
  routeId: string;
  rows: readonly CanonicalRoutePoint[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        revisionId: input.revisionId,
        routeId: input.routeId,
        rows: input.rows.map((point, displayOrder) => ({
          displayOrder,
          externalId: point.externalId,
          latitude: point.latitude,
          longitude: point.longitude,
          number: point.number ?? null,
          pointType: point.pointType,
          source: point.source,
          street: point.street ?? null,
        })),
      }),
    )
    .digest("hex");
}

async function findOrCreateSector(
  transaction: SqlExecutor,
  input: {
    crewId: string;
    membershipId: string;
    name: string;
  },
): Promise<string> {
  const existing = await transaction.query<IdRow>(
    `SELECT id
     FROM sector
     WHERE crew_id = $1 AND lower(name) = lower($2)
     LIMIT 1`,
    [input.crewId, input.name],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO sector
       (crew_id, id, name, created_by_membership_id)
     VALUES ($1, $2, $3, $4)`,
    [input.crewId, id, input.name, input.membershipId],
  );
  return id;
}

async function findOrCreateRoute(
  transaction: SqlExecutor,
  input: {
    crewId: string;
    membershipId: string;
    name: string;
    sectorId: string;
  },
): Promise<string> {
  const existing = await transaction.query<IdRow>(
    `SELECT id
     FROM route
     WHERE crew_id = $1
       AND sector_id = $2
       AND lower(name) = lower($3)
     LIMIT 1`,
    [input.crewId, input.sectorId, input.name],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO route
       (crew_id, id, sector_id, name, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.crewId, id, input.sectorId, input.name, input.membershipId],
  );
  return id;
}

async function findOrCreateServicePoint(
  transaction: SqlExecutor,
  crewId: string,
  point: CanonicalRoutePoint,
): Promise<string> {
  const existing = await transaction.query<IdRow>(
    `SELECT id
     FROM service_point
     WHERE crew_id = $1
       AND source = $2
       AND lower(external_id) = lower($3)
     LIMIT 1
     FOR UPDATE`,
    [crewId, point.source, point.externalId],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO service_point (crew_id, id, source, external_id)
     VALUES ($1, $2, $3, $4)`,
    [crewId, id, point.source, point.externalId],
  );
  return id;
}

async function findOrCreatePointVersion(
  transaction: SqlExecutor,
  input: {
    crewId: string;
    importBatchId?: string;
    point: CanonicalRoutePoint;
    routeRevisionChangeId?: string;
    routeRevisionEditId?: string;
    servicePointId: string;
  },
): Promise<string> {
  const contentHash = pointVersionHash(input.point);
  const existing = await transaction.query<VersionRow>(
    `SELECT id, version_number
     FROM service_point_version
     WHERE crew_id = $1
       AND service_point_id = $2
       AND content_hash = $3
     LIMIT 1`,
    [input.crewId, input.servicePointId, contentHash],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  const nextVersion = await transaction.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
     FROM service_point_version
     WHERE crew_id = $1 AND service_point_id = $2`,
    [input.crewId, input.servicePointId],
  );
  const id = randomUUID();
  if (
    [input.importBatchId, input.routeRevisionEditId, input.routeRevisionChangeId].filter(
      (value) => value !== undefined,
    ).length !== 1
  ) {
    throw new DomainError("INVALID_REVISION_STATE", {
      message: "A point version requires exactly one provenance receipt.",
      statusCode: 500,
    });
  }
  await transaction.query(
    `INSERT INTO service_point_version
       (crew_id, id, service_point_id, version_number, latitude, longitude,
        street, house_number, point_type, source, content_hash,
        import_batch_id, route_revision_edit_id, route_revision_change_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      input.crewId,
      id,
      input.servicePointId,
      Number(nextVersion.rows[0]?.next_version ?? 1),
      input.point.latitude,
      input.point.longitude,
      input.point.street ?? null,
      input.point.number ?? null,
      input.point.pointType,
      input.point.source,
      contentHash,
      input.importBatchId ?? null,
      input.routeRevisionEditId ?? null,
      input.routeRevisionChangeId ?? null,
    ],
  );
  return id;
}

type EditableRoutePointInput = Omit<EditableRoutePoint, "number" | "street"> & {
  number?: string | undefined;
  street?: string | undefined;
};

function normalizeEditablePoint(point: EditableRoutePointInput): CanonicalRoutePoint {
  const geometry = normalizePointGeometry({
    coordinates: [point.longitude, point.latitude],
    type: "Point",
  });
  return {
    externalId: point.externalId.trim(),
    latitude: geometry.coordinates[1],
    longitude: geometry.coordinates[0],
    pointType: point.pointType,
    source: point.source,
    ...(point.number?.trim() ? { number: point.number.trim() } : {}),
    ...(point.street?.trim() ? { street: point.street.trim() } : {}),
  };
}

function normalizeEditableSegment(
  segment: z.infer<typeof editableSegmentSchema>,
): EditableStreetSegment {
  const attribution = segment.attribution?.trim();
  if (segment.source === "OSM" && !attribution) {
    throw new DomainError("INVALID_GEOMETRY", {
      message: "Los segmentos OSM deben conservar atribución.",
      statusCode: 422,
    });
  }
  const geometry = normalizeLineGeometry(segment.geometry);
  if (segment.serviceSide !== "BOTH") {
    for (let index = 1; index < geometry.coordinates.length; index += 1) {
      const previous = geometry.coordinates[index - 1];
      const current = geometry.coordinates[index];
      const previousEnd = previous?.at(-1);
      const currentStart = current?.[0];
      if (
        !previousEnd ||
        !currentStart ||
        previousEnd[0] !== currentStart[0] ||
        previousEnd[1] !== currentStart[1]
      ) {
        throw new DomainError("SEGMENT_SIDE_ORIENTATION_INVALID", {
          details: {
            componentIndex: index,
            externalId: segment.externalId,
            serviceSide: segment.serviceSide,
          },
          message:
            "LEFT/RIGHT se aplica al orden de coordenadas de cada componente. Las componentes deben formar una cadena fin-a-inicio coherente; reordene, invierta o divida el tramo.",
          statusCode: 422,
        });
      }
    }
  }
  return {
    externalId: segment.externalId.trim(),
    geometry,
    serviceSide: segment.serviceSide,
    source: segment.source,
    ...(attribution ? { attribution } : {}),
    ...(segment.name?.trim() ? { name: segment.name.trim() } : {}),
    ...(segment.sourceVersion?.trim() ? { sourceVersion: segment.sourceVersion.trim() } : {}),
  };
}

function normalizeRevisionChange(
  change: z.infer<typeof routeRevisionChangeSchema>,
): RouteRevisionChange {
  switch (change.type) {
    case "SET_AREA":
      return {
        geometry: change.geometry === null ? null : normalizeAreaGeometry(change.geometry),
        type: change.type,
      };
    case "ADD_POINT":
      return { point: normalizeEditablePoint(change.point), type: change.type };
    case "UPDATE_POINT": {
      let latitude = change.point.latitude;
      let longitude = change.point.longitude;
      if (latitude !== undefined || longitude !== undefined) {
        if (latitude === undefined || longitude === undefined) {
          throw new DomainError("INVALID_GEOMETRY", {
            message: "Mover un punto requiere latitud y longitud.",
            statusCode: 422,
          });
        }
        const geometry = normalizePointGeometry({
          coordinates: [longitude, latitude],
          type: "Point",
        });
        longitude = geometry.coordinates[0];
        latitude = geometry.coordinates[1];
      }
      const normalizedChange: Extract<RouteRevisionChange, { type: "UPDATE_POINT" }> = {
        point: {
          ...(latitude !== undefined ? { latitude } : {}),
          ...(longitude !== undefined ? { longitude } : {}),
          ...(change.point.number !== undefined ? { number: change.point.number } : {}),
          ...(change.point.pointType !== undefined ? { pointType: change.point.pointType } : {}),
          ...(change.point.street !== undefined ? { street: change.point.street } : {}),
        },
        servicePointId: change.servicePointId,
        type: change.type,
        ...(change.expectedServicePointVersionId
          ? { expectedServicePointVersionId: change.expectedServicePointVersionId }
          : {}),
      };
      return normalizedChange;
    }
    case "REMOVE_POINT":
      return change;
    case "REPLACE_SEGMENTS":
      return { segments: change.segments.map(normalizeEditableSegment), type: change.type };
    case "IMPORT_OSM_SELECTION":
      return {
        points: change.points.map(normalizeEditablePoint),
        segments: change.segments.map(normalizeEditableSegment),
        type: change.type,
      };
  }
}

function canonicalSegmentForHash(segment: EditableStreetSegment): unknown {
  const { serviceSide, ...legacySegment } = segment;
  return serviceSide === "BOTH" ? legacySegment : { ...legacySegment, serviceSide };
}

function canonicalRevisionChangeForHash(change: RouteRevisionChange): unknown {
  if (change.type === "REPLACE_SEGMENTS") {
    return { ...change, segments: change.segments.map(canonicalSegmentForHash) };
  }
  if (change.type === "IMPORT_OSM_SELECTION") {
    return { ...change, segments: change.segments.map(canonicalSegmentForHash) };
  }
  return change;
}

function importPayloadHash(input: {
  area: MultiPolygonGeometry | null;
  routeName: string;
  rows: readonly CanonicalRoutePoint[];
  sectorName: string;
  segments: readonly EditableStreetSegment[];
}): string {
  const pointImportHash = canonicalImportHash({
    routeName: input.routeName,
    rows: input.rows,
    sectorName: input.sectorName,
  });
  if (input.area === null && input.segments.length === 0) return pointImportHash;
  return canonicalHash({
    area: input.area,
    pointImportHash,
    schemaVersion: 1,
    segments: input.segments.map(canonicalSegmentForHash),
  });
}

function assertUniqueSegments(segments: readonly EditableStreetSegment[]): void {
  const keys = new Set<string>();
  for (const segment of segments) {
    const key = `${segment.source}:${segment.externalId.toLocaleLowerCase("en")}`;
    if (keys.has(key)) {
      throw new DomainError("SEGMENT_DUPLICATE", {
        details: { externalId: segment.externalId, source: segment.source },
        statusCode: 422,
      });
    }
    keys.add(key);
  }
}

async function findOrCreateStreetSegment(
  transaction: SqlExecutor,
  input: { crewId: string; segment: EditableStreetSegment },
): Promise<string> {
  const existing = await transaction.query<IdRow>(
    `SELECT id
     FROM route_street_segment
     WHERE crew_id = $1 AND source = $2 AND lower(external_id) = lower($3)
     LIMIT 1
     FOR UPDATE`,
    [input.crewId, input.segment.source, input.segment.externalId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO route_street_segment (crew_id, id, source, external_id)
     VALUES ($1, $2, $3, $4)`,
    [input.crewId, id, input.segment.source, input.segment.externalId],
  );
  return id;
}

async function findOrCreateStreetSegmentVersion(
  transaction: SqlExecutor,
  input: {
    changeId: string;
    crewId: string;
    segment: EditableStreetSegment;
    streetSegmentId: string;
  },
): Promise<string> {
  const contentHash = canonicalHash({
    attribution: input.segment.attribution ?? null,
    geometry: input.segment.geometry,
    name: input.segment.name ?? null,
    source: input.segment.source,
    sourceVersion: input.segment.sourceVersion ?? null,
  });
  const existing = await transaction.query<IdRow>(
    `SELECT id
     FROM route_street_segment_version
     WHERE crew_id = $1 AND street_segment_id = $2 AND content_hash = $3
     LIMIT 1`,
    [input.crewId, input.streetSegmentId, contentHash],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const next = await transaction.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
     FROM route_street_segment_version
     WHERE crew_id = $1 AND street_segment_id = $2`,
    [input.crewId, input.streetSegmentId],
  );
  const id = randomUUID();
  await transaction.query(
    `INSERT INTO route_street_segment_version
       (crew_id, id, street_segment_id, version_number, name,
        geometry_geojson, source, source_version, attribution,
        content_hash, origin_change_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
    [
      input.crewId,
      id,
      input.streetSegmentId,
      Number(next.rows[0]?.next_version ?? 1),
      input.segment.name ?? null,
      JSON.stringify(input.segment.geometry),
      input.segment.source,
      input.segment.sourceVersion ?? null,
      input.segment.attribution ?? null,
      contentHash,
      input.changeId,
    ],
  );
  return id;
}

async function replaceSegments(
  transaction: SqlExecutor,
  input: {
    changeId: string;
    crewId: string;
    revisionId: string;
    segments: readonly EditableStreetSegment[];
  },
): Promise<void> {
  assertUniqueSegments(input.segments);
  await transaction.query(
    `DELETE FROM route_revision_segment WHERE crew_id = $1 AND route_revision_id = $2`,
    [input.crewId, input.revisionId],
  );
  for (const [displayOrder, segment] of input.segments.entries()) {
    const segmentId = await findOrCreateStreetSegment(transaction, {
      crewId: input.crewId,
      segment,
    });
    const versionId = await findOrCreateStreetSegmentVersion(transaction, {
      changeId: input.changeId,
      crewId: input.crewId,
      segment,
      streetSegmentId: segmentId,
    });
    await transaction.query(
      `INSERT INTO route_revision_segment
         (crew_id, route_revision_id, street_segment_id,
          street_segment_version_id, display_order, service_side)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.crewId, input.revisionId, segmentId, versionId, displayOrder, segment.serviceSide],
    );
  }
}

async function applyInitialImportGeography(
  transaction: SqlExecutor,
  input: {
    area: MultiPolygonGeometry | null;
    crewId: string;
    membershipId: string;
    pointCount: number;
    revisionId: string;
    routeId: string;
    segments: readonly EditableStreetSegment[];
  },
): Promise<{ areaVersionId: string | null; draftVersion: number; segmentCount: number }> {
  assertUniqueSegments(input.segments);
  let areaVersionId: string | null = null;
  let draftVersion = 1;
  let segmentCount = 0;

  if (input.area !== null) {
    const changeId = randomUUID();
    const resultingDraftVersion = draftVersion + 1;
    const result: ApplyRouteRevisionChangeResult = {
      draftVersion: resultingDraftVersion,
      pointCount: input.pointCount,
      replayed: false,
      revisionId: input.revisionId,
      routeId: input.routeId,
      segmentCount,
    };
    await transaction.query(
      `INSERT INTO route_revision_change
         (crew_id, id, route_id, revision_id, change_type, payload_hash,
          base_draft_version, resulting_draft_version, result_json,
          created_by_membership_id)
       VALUES ($1, $2, $3, $4, 'SET_AREA', $5, $6, $7, $8::jsonb, $9)`,
      [
        input.crewId,
        changeId,
        input.routeId,
        input.revisionId,
        canonicalHash({
          baseDraftVersion: draftVersion,
          change: { geometry: input.area, type: "SET_AREA" },
          revisionId: input.revisionId,
          routeId: input.routeId,
        }),
        draftVersion,
        resultingDraftVersion,
        JSON.stringify(result),
        input.membershipId,
      ],
    );
    areaVersionId = randomUUID();
    await transaction.query(
      `INSERT INTO route_revision_area_version
         (crew_id, id, route_revision_id, version_number,
          geometry_geojson, content_hash, origin_change_id)
       VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        input.crewId,
        areaVersionId,
        input.revisionId,
        JSON.stringify(input.area),
        canonicalHash(input.area),
        changeId,
      ],
    );
    draftVersion = resultingDraftVersion;
  }

  if (input.segments.length > 0) {
    const changeId = randomUUID();
    const resultingDraftVersion = draftVersion + 1;
    segmentCount = input.segments.length;
    const result: ApplyRouteRevisionChangeResult = {
      draftVersion: resultingDraftVersion,
      pointCount: input.pointCount,
      replayed: false,
      revisionId: input.revisionId,
      routeId: input.routeId,
      segmentCount,
    };
    await transaction.query(
      `INSERT INTO route_revision_change
         (crew_id, id, route_id, revision_id, change_type, payload_hash,
          base_draft_version, resulting_draft_version, result_json,
          created_by_membership_id)
       VALUES ($1, $2, $3, $4, 'REPLACE_SEGMENTS', $5, $6, $7, $8::jsonb, $9)`,
      [
        input.crewId,
        changeId,
        input.routeId,
        input.revisionId,
        canonicalHash({
          baseDraftVersion: draftVersion,
          change: {
            segments: input.segments.map(canonicalSegmentForHash),
            type: "REPLACE_SEGMENTS",
          },
          revisionId: input.revisionId,
          routeId: input.routeId,
        }),
        draftVersion,
        resultingDraftVersion,
        JSON.stringify(result),
        input.membershipId,
      ],
    );
    await replaceSegments(transaction, {
      changeId,
      crewId: input.crewId,
      revisionId: input.revisionId,
      segments: input.segments,
    });
    draftVersion = resultingDraftVersion;
  }

  return { areaVersionId, draftVersion, segmentCount };
}

async function appendSegments(
  transaction: SqlExecutor,
  input: {
    changeId: string;
    crewId: string;
    revisionId: string;
    segments: readonly EditableStreetSegment[];
  },
): Promise<void> {
  assertUniqueSegments(input.segments);
  const current = await transaction.query<SegmentIdentityRow>(
    `SELECT rss.source, rss.external_id, rrs.display_order
     FROM route_revision_segment rrs
     JOIN route_street_segment rss
       ON rss.crew_id = rrs.crew_id AND rss.id = rrs.street_segment_id
     WHERE rrs.crew_id = $1 AND rrs.route_revision_id = $2
     ORDER BY rrs.display_order`,
    [input.crewId, input.revisionId],
  );
  const currentKeys = new Set(
    current.rows.map(
      (segment) => `${segment.source}:${segment.external_id.toLocaleLowerCase("en")}`,
    ),
  );
  for (const segment of input.segments) {
    const key = `${segment.source}:${segment.externalId.toLocaleLowerCase("en")}`;
    if (currentKeys.has(key)) {
      throw new DomainError("SEGMENT_DUPLICATE", {
        details: { externalId: segment.externalId, source: segment.source },
        statusCode: 409,
      });
    }
  }

  const firstDisplayOrder =
    current.rows.reduce(
      (maximum, segment) => Math.max(maximum, Number(segment.display_order)),
      -1,
    ) + 1;
  for (const [index, segment] of input.segments.entries()) {
    const segmentId = await findOrCreateStreetSegment(transaction, {
      crewId: input.crewId,
      segment,
    });
    const versionId = await findOrCreateStreetSegmentVersion(transaction, {
      changeId: input.changeId,
      crewId: input.crewId,
      segment,
      streetSegmentId: segmentId,
    });
    await transaction.query(
      `INSERT INTO route_revision_segment
         (crew_id, route_revision_id, street_segment_id,
          street_segment_version_id, display_order, service_side)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.crewId,
        input.revisionId,
        segmentId,
        versionId,
        firstDisplayOrder + index,
        segment.serviceSide,
      ],
    );
  }
}

export class RouteService implements RouteServiceApi {
  constructor(private readonly database: DomainDatabase) {}

  previewOsmExport(raw: unknown): OsmCandidatePreview {
    return parseOsmExport(raw);
  }

  async getRevisionFeatures(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RouteRevisionFeatures | null> {
    return new RouteRepository(this.database).getRevisionFeatures(crewId, routeId, revisionId);
  }

  async getRoutePackage(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RoutePackageDto> {
    const features = await this.getRevisionFeatures(crewId, routeId, revisionId);
    if (!features) throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });
    const contentHash = features.contentHash;
    if (features.status === "DRAFT" || !contentHash) {
      throw new DomainError("ROUTE_PACKAGE_DRAFT", {
        message: "El paquete local requiere una revisión publicada e inmutable.",
        statusCode: 409,
      });
    }
    const revision = await this.database.query<{
      published_at: Date | string | null;
      content_schema_version: number | null;
      revision_number: number | null;
      route_name: string;
      sector_name: string;
      status: "ARCHIVED" | "PUBLISHED" | "SUPERSEDED";
    }>(
      `SELECT rr.revision_number, rr.status, rr.published_at, rr.content_schema_version,
              route.name AS route_name, sector.name AS sector_name
       FROM route_revision rr
       JOIN route ON route.crew_id = rr.crew_id AND route.id = rr.route_id
       JOIN sector ON sector.crew_id = route.crew_id AND sector.id = route.sector_id
       WHERE rr.crew_id = $1 AND rr.route_id = $2 AND rr.id = $3
       LIMIT 1`,
      [crewId, routeId, revisionId],
    );
    const metadata = revision.rows[0];
    const revisionNumber = metadata?.revision_number;
    if (
      !metadata ||
      revisionNumber === null ||
      revisionNumber === undefined ||
      metadata.published_at === null ||
      metadata.content_schema_version !== 2 ||
      features.bounds === null
    ) {
      throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });
    }
    const [west, south, east, north] = features.bounds;
    const usesOsm =
      features.points.features.some((feature) => feature.properties.source === "OSM") ||
      features.segments.features.some((feature) => feature.properties.source === "OSM");
    return {
      area: features.area,
      attributions: usesOsm
        ? [
            {
              label: "© OpenStreetMap contributors",
              url: "https://www.openstreetmap.org/copyright",
            },
          ]
        : [],
      bounds: { east, north, south, west },
      crewId,
      kind: "ROUTE_REVISION_PACKAGE",
      points: features.points.features.map((feature, displayOrder) => ({
        displayOrder,
        externalId: feature.properties.externalId,
        id: feature.id,
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
        pointType: feature.properties.pointType,
        servicePointVersionId: feature.properties.servicePointVersionId,
        source: feature.properties.source,
        ...(feature.properties.number ? { number: feature.properties.number } : {}),
        ...(feature.properties.street ? { street: feature.properties.street } : {}),
      })),
      revision: {
        contentHash,
        id: revisionId,
        number: Number(revisionNumber),
        pointCount: features.pointCount,
        publishedAt:
          metadata.published_at instanceof Date
            ? metadata.published_at.toISOString()
            : new Date(metadata.published_at).toISOString(),
        status: metadata.status,
      },
      route: { id: routeId, name: metadata.route_name, sectorName: metadata.sector_name },
      schemaVersion: 1,
      segments: features.segments.features.map((feature) => ({
        displayOrder: feature.properties.displayOrder,
        externalId: feature.properties.externalId,
        geometry: feature.geometry,
        id: feature.id,
        source: feature.properties.source,
        serviceSide: feature.properties.serviceSide,
        streetSegmentVersionId: feature.properties.streetSegmentVersionId,
        ...(feature.properties.attribution ? { attribution: feature.properties.attribution } : {}),
        ...(feature.properties.name ? { name: feature.properties.name } : {}),
        ...(feature.properties.sourceVersion
          ? { sourceVersion: feature.properties.sourceVersion }
          : {}),
      })),
    };
  }

  async applyRevisionChange(
    rawInput: ApplyRouteRevisionChangeInput,
  ): Promise<ApplyRouteRevisionChangeResult> {
    const parsedInput = applyRouteRevisionChangeInputSchema.safeParse(rawInput);
    if (!parsedInput.success) return invalidRouteRevisionChange(parsedInput.error);
    const input = parsedInput.data;
    const change = normalizeRevisionChange(input.change);
    const payloadHash = canonicalHash({
      baseDraftVersion: input.baseDraftVersion,
      change: canonicalRevisionChangeForHash(change),
      revisionId: input.revisionId,
      routeId: input.routeId,
    });

    return this.database.transaction<ChangeTransactionResult>(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "ROUTE_DRAFT_EDIT",
      );
      await transaction.query(`SELECT id FROM crew WHERE id = $1 FOR UPDATE`, [input.crewId]);
      const route = await transaction.query<IdRow>(
        `SELECT id FROM route
         WHERE crew_id = $1 AND id = $2
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.routeId],
      );
      if (!route.rows[0]) throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 404 });
      const revisionResult = await transaction.query<RevisionStateRow>(
        `SELECT status, point_count, segment_count, draft_version, area_version_id
         FROM route_revision
         WHERE crew_id = $1 AND route_id = $2 AND id = $3
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.routeId, input.revisionId],
      );
      const current = revisionResult.rows[0];
      if (!current) throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });

      const receipt = await transaction.query<ChangeReceiptRow>(
        `SELECT route_id, revision_id, payload_hash, result_json
         FROM route_revision_change
         WHERE crew_id = $1 AND id = $2
         LIMIT 1`,
        [input.crewId, input.operationId],
      );
      const previous = receipt.rows[0];
      if (previous) {
        if (
          previous.payload_hash !== payloadHash ||
          previous.route_id !== input.routeId ||
          previous.revision_id !== input.revisionId
        ) {
          throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
            details: { operationId: input.operationId },
            statusCode: 409,
          });
        }
        const stored =
          typeof previous.result_json === "string"
            ? (JSON.parse(previous.result_json) as ApplyRouteRevisionChangeResult)
            : (previous.result_json as ApplyRouteRevisionChangeResult);
        return { ...stored, replayed: true };
      }
      if (current.status !== "DRAFT") {
        throw new DomainError("INVALID_REVISION_STATE", {
          details: { status: current.status },
          statusCode: 409,
        });
      }
      if (Number(current.draft_version) !== input.baseDraftVersion) {
        throw new DomainError("DRAFT_VERSION_CONFLICT", {
          details: { currentDraftVersion: Number(current.draft_version) },
          statusCode: 409,
        });
      }

      const previousPointCount = Number(current.point_count);
      let pointCount = previousPointCount;
      let segmentCount = Number(current.segment_count);
      let areaVersionId = current.area_version_id;
      const draftVersion = input.baseDraftVersion + 1;
      if (change.type === "ADD_POINT") pointCount += 1;
      if (change.type === "REMOVE_POINT") pointCount -= 1;
      if (change.type === "REPLACE_SEGMENTS") segmentCount = change.segments.length;
      if (change.type === "IMPORT_OSM_SELECTION") {
        pointCount += change.points.length;
        segmentCount += change.segments.length;
      }
      const result: ApplyRouteRevisionChangeResult = {
        draftVersion,
        pointCount,
        replayed: false,
        revisionId: input.revisionId,
        routeId: input.routeId,
        segmentCount,
      };
      await transaction.query(
        `INSERT INTO route_revision_change
           (crew_id, id, route_id, revision_id, change_type, payload_hash,
            base_draft_version, resulting_draft_version, result_json,
            created_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          input.crewId,
          input.operationId,
          input.routeId,
          input.revisionId,
          change.type,
          payloadHash,
          input.baseDraftVersion,
          draftVersion,
          JSON.stringify(result),
          membershipId,
        ],
      );

      if (change.type === "SET_AREA") {
        if (change.geometry === null) {
          areaVersionId = null;
        } else {
          const contentHash = canonicalHash(change.geometry);
          const existing = await transaction.query<IdRow>(
            `SELECT id FROM route_revision_area_version
             WHERE crew_id = $1 AND route_revision_id = $2 AND content_hash = $3
             LIMIT 1`,
            [input.crewId, input.revisionId, contentHash],
          );
          if (existing.rows[0]) {
            areaVersionId = existing.rows[0].id;
          } else {
            const next = await transaction.query<{ next_version: number }>(
              `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
               FROM route_revision_area_version
               WHERE crew_id = $1 AND route_revision_id = $2`,
              [input.crewId, input.revisionId],
            );
            areaVersionId = randomUUID();
            await transaction.query(
              `INSERT INTO route_revision_area_version
                 (crew_id, id, route_revision_id, version_number,
                  geometry_geojson, content_hash, origin_change_id)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
              [
                input.crewId,
                areaVersionId,
                input.revisionId,
                Number(next.rows[0]?.next_version ?? 1),
                JSON.stringify(change.geometry),
                contentHash,
                input.operationId,
              ],
            );
          }
        }
      } else if (change.type === "ADD_POINT") {
        const point = normalizeEditablePoint(change.point);
        const servicePointId = await findOrCreateServicePoint(transaction, input.crewId, point);
        const included = await transaction.query<IdRow>(
          `SELECT service_point_id AS id FROM route_revision_point
           WHERE crew_id = $1 AND route_revision_id = $2 AND service_point_id = $3
           LIMIT 1`,
          [input.crewId, input.revisionId, servicePointId],
        );
        if (included.rows[0]) {
          throw new DomainError("POINT_ALREADY_INCLUDED", { statusCode: 409 });
        }
        const versionId = await findOrCreatePointVersion(transaction, {
          crewId: input.crewId,
          point,
          routeRevisionChangeId: input.operationId,
          servicePointId,
        });
        await transaction.query(
          `INSERT INTO route_revision_point
             (crew_id, route_revision_id, service_point_id,
              service_point_version_id, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.crewId, input.revisionId, servicePointId, versionId, previousPointCount],
        );
      } else if (change.type === "UPDATE_POINT") {
        const existing = await transaction.query<CurrentPointRow>(
          `SELECT rrp.display_order, rrp.service_point_id,
                  rrp.service_point_version_id, sp.external_id,
                  spv.latitude, spv.longitude, spv.street, spv.house_number,
                  spv.point_type, spv.source
           FROM route_revision_point rrp
           JOIN service_point sp
             ON sp.crew_id = rrp.crew_id AND sp.id = rrp.service_point_id
           JOIN service_point_version spv
             ON spv.crew_id = rrp.crew_id
            AND spv.service_point_id = rrp.service_point_id
            AND spv.id = rrp.service_point_version_id
           WHERE rrp.crew_id = $1 AND rrp.route_revision_id = $2
             AND rrp.service_point_id = $3
           LIMIT 1`,
          [input.crewId, input.revisionId, change.servicePointId],
        );
        const currentPoint = existing.rows[0];
        if (!currentPoint) throw new DomainError("POINT_NOT_IN_REVISION", { statusCode: 404 });
        if (
          change.expectedServicePointVersionId &&
          change.expectedServicePointVersionId !== currentPoint.service_point_version_id
        ) {
          throw new DomainError("POINT_VERSION_CONFLICT", {
            details: { currentServicePointVersionId: currentPoint.service_point_version_id },
            statusCode: 409,
          });
        }
        const patch = change.point;
        const nextNumber = Object.hasOwn(patch, "number")
          ? patch.number
          : (currentPoint.house_number ?? undefined);
        const nextStreet = Object.hasOwn(patch, "street")
          ? patch.street
          : (currentPoint.street ?? undefined);
        const point = normalizeEditablePoint({
          externalId: currentPoint.external_id,
          latitude: patch.latitude ?? Number(currentPoint.latitude),
          longitude: patch.longitude ?? Number(currentPoint.longitude),
          pointType: patch.pointType ?? currentPoint.point_type,
          source: currentPoint.source,
          ...(nextNumber ? { number: nextNumber } : {}),
          ...(nextStreet ? { street: nextStreet } : {}),
        });
        const versionId = await findOrCreatePointVersion(transaction, {
          crewId: input.crewId,
          point,
          routeRevisionChangeId: input.operationId,
          servicePointId: change.servicePointId,
        });
        await transaction.query(
          `UPDATE route_revision_point SET service_point_version_id = $4
           WHERE crew_id = $1 AND route_revision_id = $2 AND service_point_id = $3`,
          [input.crewId, input.revisionId, change.servicePointId, versionId],
        );
      } else if (change.type === "REMOVE_POINT") {
        const removed = await transaction.query(
          `DELETE FROM route_revision_point
           WHERE crew_id = $1 AND route_revision_id = $2 AND service_point_id = $3`,
          [input.crewId, input.revisionId, change.servicePointId],
        );
        if (removed.affectedRows === 0) {
          throw new DomainError("POINT_NOT_IN_REVISION", { statusCode: 404 });
        }
      } else if (change.type === "REPLACE_SEGMENTS") {
        await replaceSegments(transaction, {
          changeId: input.operationId,
          crewId: input.crewId,
          revisionId: input.revisionId,
          segments: change.segments,
        });
      } else if (change.type === "IMPORT_OSM_SELECTION") {
        await appendSegments(transaction, {
          changeId: input.operationId,
          crewId: input.crewId,
          revisionId: input.revisionId,
          segments: change.segments,
        });
        for (const [pointIndex, editable] of change.points.entries()) {
          const point = normalizeEditablePoint(editable);
          const servicePointId = await findOrCreateServicePoint(transaction, input.crewId, point);
          const included = await transaction.query<IdRow>(
            `SELECT service_point_id AS id FROM route_revision_point
             WHERE crew_id = $1 AND route_revision_id = $2 AND service_point_id = $3
             LIMIT 1`,
            [input.crewId, input.revisionId, servicePointId],
          );
          if (included.rows[0]) {
            throw new DomainError("POINT_ALREADY_INCLUDED", {
              details: { externalId: point.externalId },
              statusCode: 409,
            });
          }
          const versionId = await findOrCreatePointVersion(transaction, {
            crewId: input.crewId,
            point,
            routeRevisionChangeId: input.operationId,
            servicePointId,
          });
          await transaction.query(
            `INSERT INTO route_revision_point
               (crew_id, route_revision_id, service_point_id,
                service_point_version_id, display_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              input.crewId,
              input.revisionId,
              servicePointId,
              versionId,
              previousPointCount + pointIndex,
            ],
          );
        }
      }

      result.pointCount = pointCount;
      result.segmentCount = segmentCount;
      await transaction.query(
        `UPDATE route_revision
         SET point_count = $4, segment_count = $5, draft_version = $6,
             area_version_id = $7, updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND route_id = $2 AND id = $3`,
        [
          input.crewId,
          input.routeId,
          input.revisionId,
          pointCount,
          segmentCount,
          draftVersion,
          areaVersionId,
        ],
      );
      await transaction.query(
        `UPDATE route SET updated_at = CURRENT_TIMESTAMP WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.routeId],
      );
      await transaction.query(
        `INSERT INTO audit_event
           (crew_id, id, actor_membership_id, action,
            aggregate_type, aggregate_id, metadata)
         VALUES ($1, $2, $3, 'ROUTE_DRAFT_GEOGRAPHY_CHANGED',
                 'RouteRevision', $4, $5::jsonb)`,
        [
          input.crewId,
          randomUUID(),
          membershipId,
          input.revisionId,
          JSON.stringify({
            changeType: change.type,
            draftVersion,
            operationIdHash: createHash("sha256").update(input.operationId).digest("hex"),
            pointCount,
            routeId: input.routeId,
            segmentCount,
          }),
        ],
      );
      return result;
    });
  }

  previewCsv(csv: string): CsvPreview {
    return previewRouteCsv(csv);
  }

  async listRoutes(crewId: string): Promise<RouteSummaryView[]> {
    return new RouteRepository(this.database).listRoutes(crewId);
  }

  async getRoute(crewId: string, routeId: string): Promise<RouteDetailView | null> {
    return new RouteRepository(this.database).getRoute(crewId, routeId);
  }

  async importRoute(rawInput: ImportRouteInput): Promise<ImportRouteResult> {
    const parsedInput = importInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return invalidInput(parsedInput.error);
    }
    const input = parsedInput.data;
    const preview = previewRouteCsv(input.csv);
    if (!preview.valid) {
      return {
        created: false,
        errors: preview.errors,
        revision: null,
        route: null,
      };
    }
    const area = input.area == null ? null : normalizeAreaGeometry(input.area);
    const segments = (input.segments ?? []).map(normalizeEditableSegment);
    assertUniqueSegments(segments);
    const payloadHash = importPayloadHash({
      area,
      routeName: input.routeName,
      rows: preview.rows,
      sectorName: input.sectorName,
      segments,
    });

    const applied = await this.database.transaction<ImportTransactionResult>(
      async (transaction) => {
        const membershipId = await requireCapability(
          transaction,
          input.crewId,
          input.actorUserId,
          "ROUTE_DRAFT_EDIT",
        );
        const receipt = await transaction.query<ImportReceiptRow>(
          `SELECT route_id, revision_id, payload_hash
           FROM import_batch
           WHERE crew_id = $1 AND import_key = $2
           LIMIT 1`,
          [input.crewId, input.importKey],
        );
        const previous = receipt.rows[0];
        if (previous) {
          if (previous.payload_hash !== payloadHash) {
            throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
              details: { importKey: input.importKey },
              statusCode: 409,
            });
          }
          return {
            created: false,
            revisionId: previous.revision_id,
            routeId: previous.route_id,
          };
        }

        const sectorId = await findOrCreateSector(transaction, {
          crewId: input.crewId,
          membershipId,
          name: input.sectorName,
        });
        const routeId = await findOrCreateRoute(transaction, {
          crewId: input.crewId,
          membershipId,
          name: input.routeName,
          sectorId,
        });
        const openDraft = await transaction.query<IdRow>(
          `SELECT id
           FROM route_revision
           WHERE crew_id = $1 AND route_id = $2 AND status = 'DRAFT'
           LIMIT 1`,
          [input.crewId, routeId],
        );
        if (openDraft.rows[0]) {
          throw new DomainError("DRAFT_ALREADY_EXISTS", {
            details: { revisionId: openDraft.rows[0].id, routeId },
            statusCode: 409,
          });
        }

        const revisionId = randomUUID();
        const batchId = randomUUID();
        await transaction.query(
          `INSERT INTO route_revision
             (crew_id, id, route_id, created_by_membership_id)
           VALUES ($1, $2, $3, $4)`,
          [input.crewId, revisionId, routeId, membershipId],
        );
        await transaction.query(
          `INSERT INTO import_batch
             (crew_id, id, route_id, revision_id, import_key, payload_hash,
              status, total_rows, imported_rows, result_json,
              created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'APPLIED', $7, $7,
                   $8::jsonb, $9)`,
          [
            input.crewId,
            batchId,
            routeId,
            revisionId,
            input.importKey,
            payloadHash,
            preview.rows.length,
            JSON.stringify({ revisionId, routeId }),
            membershipId,
          ],
        );

        for (const [displayOrder, point] of preview.rows.entries()) {
          const servicePointId = await findOrCreateServicePoint(transaction, input.crewId, point);
          const versionId = await findOrCreatePointVersion(transaction, {
            crewId: input.crewId,
            importBatchId: batchId,
            point,
            servicePointId,
          });
          await transaction.query(
            `INSERT INTO route_revision_point
               (crew_id, route_revision_id, service_point_id,
                service_point_version_id, display_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [input.crewId, revisionId, servicePointId, versionId, displayOrder],
          );
        }

        const geography = await applyInitialImportGeography(transaction, {
          area,
          crewId: input.crewId,
          membershipId,
          pointCount: preview.rows.length,
          revisionId,
          routeId,
          segments,
        });

        await transaction.query(
          `UPDATE route_revision
           SET point_count = $3, segment_count = $4, draft_version = $5,
               area_version_id = $6, updated_at = CURRENT_TIMESTAMP
           WHERE crew_id = $1 AND id = $2`,
          [
            input.crewId,
            revisionId,
            preview.rows.length,
            geography.segmentCount,
            geography.draftVersion,
            geography.areaVersionId,
          ],
        );
        await transaction.query(
          `UPDATE route
           SET updated_at = CURRENT_TIMESTAMP
           WHERE crew_id = $1 AND id = $2`,
          [input.crewId, routeId],
        );
        await transaction.query(
          `INSERT INTO audit_event
             (crew_id, id, actor_membership_id, action,
              aggregate_type, aggregate_id, metadata)
           VALUES ($1, $2, $3, 'ROUTE_IMPORTED', 'RouteRevision', $4,
                   $5::jsonb)`,
          [
            input.crewId,
            randomUUID(),
            membershipId,
            revisionId,
            JSON.stringify({
              areaDefined: area !== null,
              draftVersion: geography.draftVersion,
              importKeyHash: createHash("sha256").update(input.importKey).digest("hex"),
              pointCount: preview.rows.length,
              routeId,
              segmentCount: geography.segmentCount,
            }),
          ],
        );
        return { created: true, revisionId, routeId };
      },
    );

    const route = await this.getRoute(input.crewId, applied.routeId);
    if (!route) {
      throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 500 });
    }
    const revision =
      route.revisions.find((candidate) => candidate.id === applied.revisionId) ?? null;
    if (!revision) {
      throw new DomainError("REVISION_NOT_FOUND", { statusCode: 500 });
    }
    return {
      created: applied.created,
      errors: [],
      revision,
      route,
    };
  }

  async correctDraftPoints(rawInput: CorrectDraftPointsInput): Promise<CorrectDraftPointsResult> {
    const parsedInput = correctDraftPointsInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return invalidInput(parsedInput.error);
    }
    const input = parsedInput.data;
    const preview = previewRouteCsv(input.csv);
    const payloadHash = preview.valid
      ? draftEditHash({
          revisionId: input.revisionId,
          routeId: input.routeId,
          rows: preview.rows,
        })
      : null;

    const applied = await this.database.transaction<EditTransactionResult>(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "ROUTE_DRAFT_EDIT",
      );
      await transaction.query(
        `SELECT id
           FROM crew
           WHERE id = $1
           FOR UPDATE`,
        [input.crewId],
      );
      const route = await transaction.query<IdRow>(
        `SELECT id
           FROM route
           WHERE crew_id = $1 AND id = $2
           LIMIT 1
           FOR UPDATE`,
        [input.crewId, input.routeId],
      );
      if (!route.rows[0]) {
        throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 404 });
      }
      const revision = await transaction.query<RevisionStateRow>(
        `SELECT status, point_count, segment_count, draft_version, area_version_id
           FROM route_revision
           WHERE crew_id = $1 AND route_id = $2 AND id = $3
           LIMIT 1
           FOR UPDATE`,
        [input.crewId, input.routeId, input.revisionId],
      );
      const current = revision.rows[0];
      if (!current) {
        throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });
      }
      if (current.status !== "DRAFT") {
        throw new DomainError("INVALID_REVISION_STATE", {
          details: { status: current.status },
          statusCode: 409,
        });
      }
      const receipt = await transaction.query<EditReceiptRow>(
        `SELECT route_id, revision_id, payload_hash
           FROM route_revision_edit
           WHERE crew_id = $1 AND edit_key = $2
           LIMIT 1`,
        [input.crewId, input.editKey],
      );
      const previous = receipt.rows[0];
      if (previous) {
        if (
          payloadHash === null ||
          previous.payload_hash !== payloadHash ||
          previous.route_id !== input.routeId ||
          previous.revision_id !== input.revisionId
        ) {
          throw new DomainError("IDEMPOTENCY_KEY_REUSE", {
            details: { editKey: input.editKey },
            statusCode: 409,
          });
        }
        return {
          replayed: true,
          revisionId: previous.revision_id,
          routeId: previous.route_id,
        };
      }
      if (!preview.valid || payloadHash === null) {
        return {
          replayed: false,
          revisionId: input.revisionId,
          routeId: input.routeId,
        };
      }

      const editId = randomUUID();
      await transaction.query(
        `INSERT INTO route_revision_edit
             (crew_id, id, route_id, revision_id, edit_key, payload_hash,
              point_count, result_json, created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          input.crewId,
          editId,
          input.routeId,
          input.revisionId,
          input.editKey,
          payloadHash,
          preview.rows.length,
          JSON.stringify({
            pointCount: preview.rows.length,
            revisionId: input.revisionId,
            routeId: input.routeId,
          }),
          membershipId,
        ],
      );

      await transaction.query(
        `DELETE FROM route_revision_point
           WHERE crew_id = $1 AND route_revision_id = $2`,
        [input.crewId, input.revisionId],
      );
      for (const [displayOrder, point] of preview.rows.entries()) {
        const servicePointId = await findOrCreateServicePoint(transaction, input.crewId, point);
        const versionId = await findOrCreatePointVersion(transaction, {
          crewId: input.crewId,
          point,
          routeRevisionEditId: editId,
          servicePointId,
        });
        await transaction.query(
          `INSERT INTO route_revision_point
               (crew_id, route_revision_id, service_point_id,
                service_point_version_id, display_order)
             VALUES ($1, $2, $3, $4, $5)`,
          [input.crewId, input.revisionId, servicePointId, versionId, displayOrder],
        );
      }

      await transaction.query(
        `UPDATE route_revision
           SET point_count = $3,
               draft_version = draft_version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE crew_id = $1 AND route_id = $2 AND id = $4`,
        [input.crewId, input.routeId, preview.rows.length, input.revisionId],
      );
      await transaction.query(
        `UPDATE route
           SET updated_at = CURRENT_TIMESTAMP
           WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.routeId],
      );
      await transaction.query(
        `INSERT INTO audit_event
             (crew_id, id, actor_membership_id, action,
              aggregate_type, aggregate_id, metadata)
           VALUES ($1, $2, $3, 'ROUTE_DRAFT_POINTS_CORRECTED',
                   'RouteRevision', $4, $5::jsonb)`,
        [
          input.crewId,
          randomUUID(),
          membershipId,
          input.revisionId,
          JSON.stringify({
            editKeyHash: createHash("sha256").update(input.editKey).digest("hex"),
            newPointCount: preview.rows.length,
            previousPointCount: Number(current.point_count),
            routeId: input.routeId,
          }),
        ],
      );
      return {
        replayed: false,
        revisionId: input.revisionId,
        routeId: input.routeId,
      };
    });

    const route = await this.getRoute(input.crewId, applied.routeId);
    if (!route) {
      throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 500 });
    }
    const revision =
      route.revisions.find((candidate) => candidate.id === applied.revisionId) ?? null;
    if (!revision) {
      throw new DomainError("REVISION_NOT_FOUND", { statusCode: 500 });
    }
    return {
      errors: preview.errors,
      replayed: applied.replayed,
      revision,
      route,
    };
  }

  async publishRevision(rawInput: PublishRevisionInput): Promise<RouteDetailView> {
    const parsedInput = publishInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return invalidInput(parsedInput.error);
    }
    const input = parsedInput.data;

    await this.database.transaction(async (transaction) => {
      const membershipId = await requireCapability(
        transaction,
        input.crewId,
        input.actorUserId,
        "ROUTE_PUBLISH",
      );
      const route = await transaction.query<IdRow>(
        `SELECT id
         FROM route
         WHERE crew_id = $1 AND id = $2
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.routeId],
      );
      if (!route.rows[0]) {
        throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 404 });
      }
      const revision = await transaction.query<RevisionStateRow>(
        `SELECT status, point_count, segment_count, draft_version, area_version_id
         FROM route_revision
         WHERE crew_id = $1 AND route_id = $2 AND id = $3
         LIMIT 1
         FOR UPDATE`,
        [input.crewId, input.routeId, input.revisionId],
      );
      const current = revision.rows[0];
      if (!current) {
        throw new DomainError("REVISION_NOT_FOUND", { statusCode: 404 });
      }
      if (current.status === "PUBLISHED") {
        return;
      }
      if (current.status !== "DRAFT") {
        throw new DomainError("INVALID_REVISION_STATE", {
          details: { status: current.status },
          statusCode: 409,
        });
      }

      const points = await transaction.query<PublicationPointRow>(
        `SELECT rrp.display_order, sp.external_id, spv.latitude,
                spv.longitude, spv.street, spv.house_number,
                spv.point_type, spv.source
         FROM route_revision_point rrp
         JOIN service_point sp
           ON sp.crew_id = rrp.crew_id AND sp.id = rrp.service_point_id
         JOIN service_point_version spv
           ON spv.crew_id = rrp.crew_id
          AND spv.service_point_id = rrp.service_point_id
          AND spv.id = rrp.service_point_version_id
         WHERE rrp.crew_id = $1 AND rrp.route_revision_id = $2
         ORDER BY rrp.display_order, sp.id`,
        [input.crewId, input.revisionId],
      );
      if (points.rows.length === 0 || Number(current.point_count) !== points.rows.length) {
        throw new DomainError("REVISION_EMPTY", {
          details: {
            declaredPointCount: Number(current.point_count),
            actualPointCount: points.rows.length,
          },
          statusCode: 409,
        });
      }
      const areaResult = await transaction.query<AreaGeometryRow>(
        `SELECT area.geometry_geojson
           FROM route_revision rr
           JOIN route_revision_area_version area
             ON area.crew_id = rr.crew_id AND area.id = rr.area_version_id
           WHERE rr.crew_id = $1 AND rr.route_id = $2 AND rr.id = $3
           LIMIT 1`,
        [input.crewId, input.routeId, input.revisionId],
      );
      const segmentResult = await transaction.query<PublicationSegmentRow>(
        `SELECT rrs.display_order, segment.external_id,
                  version.name, version.geometry_geojson, version.source,
                  version.source_version, version.attribution, rrs.service_side
           FROM route_revision_segment rrs
           JOIN route_street_segment segment
             ON segment.crew_id = rrs.crew_id AND segment.id = rrs.street_segment_id
           JOIN route_street_segment_version version
             ON version.crew_id = rrs.crew_id
            AND version.street_segment_id = rrs.street_segment_id
            AND version.id = rrs.street_segment_version_id
           WHERE rrs.crew_id = $1 AND rrs.route_revision_id = $2
           ORDER BY rrs.display_order, segment.id`,
        [input.crewId, input.revisionId],
      );
      if (Number(current.segment_count) !== segmentResult.rows.length) {
        throw new DomainError("INVALID_REVISION_STATE", {
          details: {
            actualSegmentCount: segmentResult.rows.length,
            declaredSegmentCount: Number(current.segment_count),
          },
          message: "El conteo de segmentos no coincide con la revisión.",
          statusCode: 409,
        });
      }
      const area = areaResult.rows[0]
        ? parseStoredGeometry<MultiPolygonGeometry>(areaResult.rows[0].geometry_geojson)
        : null;
      const contentHash = canonicalPublicationHash({
        area,
        points: points.rows,
        segments: segmentResult.rows,
      });
      const counter = await transaction.query<CounterRow>(
        `UPDATE route
         SET published_revision_sequence = published_revision_sequence + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND id = $2
         RETURNING published_revision_sequence`,
        [input.crewId, input.routeId],
      );
      const revisionNumber = Number(counter.rows[0]?.published_revision_sequence);
      await transaction.query(
        `UPDATE route_revision
         SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1
           AND route_id = $2
           AND status = 'PUBLISHED'
           AND id <> $3`,
        [input.crewId, input.routeId, input.revisionId],
      );
      await transaction.query(
        `UPDATE route_revision
         SET status = 'PUBLISHED',
             revision_number = $4,
             content_hash = $5,
             content_schema_version = 2,
             published_by_membership_id = $6,
             published_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE crew_id = $1 AND route_id = $2 AND id = $3`,
        [input.crewId, input.routeId, input.revisionId, revisionNumber, contentHash, membershipId],
      );
      await transaction.query(
        `UPDATE route
         SET current_published_revision_id = $3
         WHERE crew_id = $1 AND id = $2`,
        [input.crewId, input.routeId, input.revisionId],
      );
      await transaction.query(
        `INSERT INTO audit_event
           (crew_id, id, actor_membership_id, action,
            aggregate_type, aggregate_id, metadata)
         VALUES ($1, $2, $3, 'ROUTE_REVISION_PUBLISHED',
                 'RouteRevision', $4, $5::jsonb)`,
        [
          input.crewId,
          randomUUID(),
          membershipId,
          input.revisionId,
          JSON.stringify({
            contentHash,
            revisionNumber,
            routeId: input.routeId,
          }),
        ],
      );
    });

    const route = await this.getRoute(input.crewId, input.routeId);
    if (!route) {
      throw new DomainError("ROUTE_NOT_FOUND", { statusCode: 500 });
    }
    return route;
  }
}

export function listRoutes(database: DomainDatabase, crewId: string): Promise<RouteSummaryView[]> {
  return new RouteService(database).listRoutes(crewId);
}

export function getRevisionFeatures(
  database: DomainDatabase,
  crewId: string,
  routeId: string,
  revisionId: string,
): Promise<RouteRevisionFeatures | null> {
  return new RouteService(database).getRevisionFeatures(crewId, routeId, revisionId);
}

export function getRoutePackage(
  database: DomainDatabase,
  crewId: string,
  routeId: string,
  revisionId: string,
): Promise<RoutePackageDto> {
  return new RouteService(database).getRoutePackage(crewId, routeId, revisionId);
}

export function applyRevisionChange(
  database: DomainDatabase,
  input: ApplyRouteRevisionChangeInput,
): Promise<ApplyRouteRevisionChangeResult> {
  return new RouteService(database).applyRevisionChange(input);
}

export function getRoute(
  database: DomainDatabase,
  crewId: string,
  routeId: string,
): Promise<RouteDetailView | null> {
  return new RouteService(database).getRoute(crewId, routeId);
}

export function importRoute(
  database: DomainDatabase,
  input: ImportRouteInput,
): Promise<ImportRouteResult> {
  return new RouteService(database).importRoute(input);
}

export function correctDraftPoints(
  database: DomainDatabase,
  input: CorrectDraftPointsInput,
): Promise<CorrectDraftPointsResult> {
  return new RouteService(database).correctDraftPoints(input);
}

export function publishRevision(
  database: DomainDatabase,
  input: PublishRevisionInput,
): Promise<RouteDetailView> {
  return new RouteService(database).publishRevision(input);
}
