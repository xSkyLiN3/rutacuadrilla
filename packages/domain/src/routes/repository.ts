import type { PointSource, PointType, RevisionStatus } from "../constants.js";
import type { SqlExecutor } from "../database/types.js";
import {
  geometryBounds,
  type MultiLineStringGeometry,
  type MultiPolygonGeometry,
  type PointGeometry,
  parseStoredGeometry,
} from "./geometry.js";
import type {
  RouteDetailView,
  RoutePointView,
  RouteRevisionFeatures,
  RouteRevisionView,
  RouteSegmentFeature,
  RouteSummaryView,
  SegmentSource,
  ServiceSide,
} from "./types.js";

type Temporal = Date | string;

type RouteRow = {
  crew_id: string;
  id: string;
  name: string;
  sector_name: string;
  updated_at: Temporal;
};

type RevisionRow = {
  area_geometry: unknown | null;
  content_hash: string | null;
  content_schema_version: 2 | null;
  created_at: Temporal;
  draft_version: number;
  id: string;
  point_count: number;
  published_at: Temporal | null;
  revision_number: number | null;
  segment_count: number;
  status: RevisionStatus;
};

type PointRow = {
  display_order: number;
  external_id: string;
  latitude: number;
  longitude: number;
  house_number: string | null;
  point_type: PointType;
  route_revision_id: string;
  service_point_id: string;
  service_point_version_id: string;
  source: PointSource;
  street: string | null;
};

type SegmentRow = {
  attribution: string | null;
  display_order: number;
  external_id: string;
  geometry_geojson: unknown;
  name: string | null;
  route_revision_id: string;
  service_side: ServiceSide;
  source: SegmentSource;
  source_version: string | null;
  street_segment_id: string;
  street_segment_version_id: string;
};

type RevisionFeatureStateRow = RevisionRow & { route_id: string };

type SummaryRow = Omit<RouteRow, "id"> &
  Omit<RevisionRow, "id"> & {
    revision_id: string;
    route_id: string;
  };

function toIso(value: Temporal): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

function toPoint(row: PointRow): RoutePointView {
  return {
    externalId: row.external_id,
    id: row.service_point_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    pointType: row.point_type,
    servicePointVersionId: row.service_point_version_id,
    source: row.source,
    ...(row.house_number === null ? {} : { number: row.house_number }),
    ...(row.street === null ? {} : { street: row.street }),
  };
}

function toRevision(row: RevisionRow, points: RoutePointView[]): RouteRevisionView {
  return {
    area:
      row.area_geometry === null
        ? null
        : parseStoredGeometry<MultiPolygonGeometry>(row.area_geometry),
    createdAt: toIso(row.created_at),
    draftVersion: Number(row.draft_version),
    id: row.id,
    number: row.revision_number === null ? null : Number(row.revision_number),
    pointCount: Number(row.point_count),
    points,
    segmentCount: Number(row.segment_count),
    status: row.status,
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    ...(row.content_schema_version === null
      ? {}
      : { contentSchemaVersion: row.content_schema_version }),
    ...(row.published_at === null ? {} : { publishedAt: toIso(row.published_at) }),
  };
}

function toSegmentFeature(row: SegmentRow): RouteSegmentFeature {
  return {
    geometry: parseStoredGeometry<MultiLineStringGeometry>(row.geometry_geojson),
    id: row.street_segment_id,
    properties: {
      displayOrder: Number(row.display_order),
      externalId: row.external_id,
      serviceSide: row.service_side,
      source: row.source,
      streetSegmentVersionId: row.street_segment_version_id,
      ...(row.attribution === null ? {} : { attribution: row.attribution }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.source_version === null ? {} : { sourceVersion: row.source_version }),
    },
    type: "Feature",
  };
}

export class RouteRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async listRoutes(crewId: string): Promise<RouteSummaryView[]> {
    const result = await this.executor.query<SummaryRow>(
      `SELECT r.crew_id, r.id AS route_id, r.name,
              s.name AS sector_name, r.updated_at,
              rr.id AS revision_id, rr.revision_number, rr.status, rr.content_hash,
              rr.content_schema_version,
              rr.point_count, rr.segment_count, rr.draft_version,
              NULL::jsonb AS area_geometry, rr.created_at, rr.published_at
       FROM route r
       JOIN sector s
         ON s.crew_id = r.crew_id AND s.id = r.sector_id
       JOIN LATERAL (
         SELECT candidate.id, candidate.revision_number, candidate.status,
                candidate.content_hash, candidate.content_schema_version,
                candidate.point_count, candidate.segment_count,
                candidate.draft_version,
                candidate.created_at, candidate.published_at
         FROM route_revision candidate
         WHERE candidate.crew_id = r.crew_id AND candidate.route_id = r.id
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       ) rr ON TRUE
       WHERE r.crew_id = $1
       ORDER BY r.updated_at DESC, r.id`,
      [crewId],
    );

    return result.rows.map((row) => {
      const revision = toRevision({ ...row, id: row.revision_id }, []);
      return {
        id: row.route_id,
        latestRevision: {
          createdAt: revision.createdAt,
          id: revision.id,
          number: revision.number,
          pointCount: revision.pointCount,
          status: revision.status,
          ...(revision.publishedAt ? { publishedAt: revision.publishedAt } : {}),
        },
        name: row.name,
        sectorName: row.sector_name,
        updatedAt: toIso(row.updated_at),
      };
    });
  }

  async getRoute(crewId: string, routeId: string): Promise<RouteDetailView | null> {
    const routeResult = await this.executor.query<RouteRow>(
      `SELECT r.crew_id, r.id, r.name, s.name AS sector_name, r.updated_at
       FROM route r
       JOIN sector s
         ON s.crew_id = r.crew_id AND s.id = r.sector_id
       WHERE r.crew_id = $1 AND r.id = $2
       LIMIT 1`,
      [crewId, routeId],
    );
    const route = routeResult.rows[0];
    if (!route) {
      return null;
    }

    const [revisionResult, pointResult] = await Promise.all([
      this.executor.query<RevisionRow>(
        `SELECT rr.id, rr.revision_number, rr.status, rr.content_hash,
                rr.content_schema_version,
                rr.point_count, rr.segment_count, rr.draft_version,
                area.geometry_geojson AS area_geometry,
                rr.created_at, rr.published_at
         FROM route_revision rr
         LEFT JOIN route_revision_area_version area
           ON area.crew_id = rr.crew_id AND area.id = rr.area_version_id
         WHERE rr.crew_id = $1 AND rr.route_id = $2
         ORDER BY rr.created_at DESC, rr.id DESC`,
        [crewId, routeId],
      ),
      this.executor.query<PointRow>(
        `SELECT rrp.route_revision_id, rrp.display_order, sp.id AS service_point_id,
                sp.external_id, spv.id AS service_point_version_id,
                spv.latitude, spv.longitude, spv.street,
                spv.house_number, spv.point_type, spv.source
         FROM route_revision_point rrp
         JOIN route_revision rr
           ON rr.crew_id = rrp.crew_id
          AND rr.id = rrp.route_revision_id
          AND rr.route_id = $2
         JOIN service_point sp
           ON sp.crew_id = rrp.crew_id AND sp.id = rrp.service_point_id
         JOIN service_point_version spv
           ON spv.crew_id = rrp.crew_id
          AND spv.service_point_id = rrp.service_point_id
          AND spv.id = rrp.service_point_version_id
         WHERE rrp.crew_id = $1
         ORDER BY rrp.route_revision_id, rrp.display_order`,
        [crewId, routeId],
      ),
    ]);

    const pointsByRevision = new Map<string, RoutePointView[]>();
    for (const point of pointResult.rows) {
      const points = pointsByRevision.get(point.route_revision_id) ?? [];
      points.push(toPoint(point));
      pointsByRevision.set(point.route_revision_id, points);
    }

    return {
      crewId: route.crew_id,
      id: route.id,
      name: route.name,
      revisions: revisionResult.rows.map((revision) =>
        toRevision(revision, pointsByRevision.get(revision.id) ?? []),
      ),
      sectorName: route.sector_name,
      updatedAt: toIso(route.updated_at),
    };
  }

  async getRevisionFeatures(
    crewId: string,
    routeId: string,
    revisionId: string,
  ): Promise<RouteRevisionFeatures | null> {
    const revisionResult = await this.executor.query<RevisionFeatureStateRow>(
      `SELECT rr.route_id, rr.id, rr.revision_number, rr.status, rr.content_hash,
              rr.content_schema_version,
              rr.point_count, rr.segment_count, rr.draft_version,
              area.geometry_geojson AS area_geometry,
              rr.created_at, rr.published_at
       FROM route_revision rr
       LEFT JOIN route_revision_area_version area
         ON area.crew_id = rr.crew_id AND area.id = rr.area_version_id
       WHERE rr.crew_id = $1 AND rr.route_id = $2 AND rr.id = $3
       LIMIT 1`,
      [crewId, routeId, revisionId],
    );
    const revision = revisionResult.rows[0];
    if (!revision) return null;

    const [pointResult, segmentResult] = await Promise.all([
      this.executor.query<PointRow>(
        `SELECT rrp.route_revision_id, rrp.display_order,
                sp.id AS service_point_id, sp.external_id,
                spv.id AS service_point_version_id, spv.latitude, spv.longitude,
                spv.street, spv.house_number, spv.point_type, spv.source
         FROM route_revision_point rrp
         JOIN service_point sp
           ON sp.crew_id = rrp.crew_id AND sp.id = rrp.service_point_id
         JOIN service_point_version spv
           ON spv.crew_id = rrp.crew_id
          AND spv.service_point_id = rrp.service_point_id
          AND spv.id = rrp.service_point_version_id
         WHERE rrp.crew_id = $1 AND rrp.route_revision_id = $2
         ORDER BY rrp.display_order, sp.id`,
        [crewId, revisionId],
      ),
      this.executor.query<SegmentRow>(
        `SELECT rrs.route_revision_id, rrs.display_order,
                segment.id AS street_segment_id, segment.external_id,
                version.id AS street_segment_version_id, version.name,
                version.geometry_geojson, version.source, version.source_version,
                version.attribution, rrs.service_side
         FROM route_revision_segment rrs
         JOIN route_street_segment segment
           ON segment.crew_id = rrs.crew_id AND segment.id = rrs.street_segment_id
         JOIN route_street_segment_version version
           ON version.crew_id = rrs.crew_id
          AND version.street_segment_id = rrs.street_segment_id
          AND version.id = rrs.street_segment_version_id
         WHERE rrs.crew_id = $1 AND rrs.route_revision_id = $2
         ORDER BY rrs.display_order, segment.id`,
        [crewId, revisionId],
      ),
    ]);

    const area =
      revision.area_geometry === null
        ? null
        : parseStoredGeometry<MultiPolygonGeometry>(revision.area_geometry);
    const points = pointResult.rows.map((row) => ({
      geometry: {
        coordinates: [Number(row.longitude), Number(row.latitude)],
        type: "Point",
      } satisfies PointGeometry,
      id: row.service_point_id,
      properties: {
        displayOrder: Number(row.display_order),
        externalId: row.external_id,
        pointType: row.point_type,
        servicePointVersionId: row.service_point_version_id,
        source: row.source,
        ...(row.house_number === null ? {} : { number: row.house_number }),
        ...(row.street === null ? {} : { street: row.street }),
      },
      type: "Feature" as const,
    }));
    const segments = segmentResult.rows.map(toSegmentFeature);
    return {
      area,
      bounds: geometryBounds([
        area,
        ...segments.map((feature) => feature.geometry),
        ...points.map((feature) => feature.geometry),
      ]),
      draftVersion: Number(revision.draft_version),
      pointCount: Number(revision.point_count),
      points: { features: points, type: "FeatureCollection" },
      revisionId,
      routeId,
      schemaVersion: 1,
      segmentCount: Number(revision.segment_count),
      segments: { features: segments, type: "FeatureCollection" },
      status: revision.status,
      ...(revision.content_hash === null ? {} : { contentHash: revision.content_hash }),
    };
  }
}
