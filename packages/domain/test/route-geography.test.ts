import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalHash,
  closeDatabase,
  type DomainDatabase,
  DomainError,
  type MultiLineStringGeometry,
  normalizeAreaGeometry,
  previewOsmExport,
  RouteService,
  serializeRoutePackage,
} from "../src/index.js";
import { openSeededDatabase, validCsv } from "./helpers.js";

const area = {
  coordinates: [
    [
      [-0.671, -0.451],
      [-0.66, -0.451],
      [-0.66, -0.44],
      [-0.671, -0.44],
      [-0.671, -0.451],
    ],
  ],
  type: "Polygon" as const,
};

describe.sequential("route geography and individual draft changes", () => {
  let database: DomainDatabase | undefined;

  afterEach(async () => {
    if (database) {
      await closeDatabase(database);
      database = undefined;
    }
  });

  it("normalizes WGS84 geometry and parses pasted Overpass candidates without network", () => {
    expect(normalizeAreaGeometry(area)).toEqual({
      coordinates: [area.coordinates],
      type: "MultiPolygon",
    });
    expect(() =>
      normalizeAreaGeometry({
        ...area,
        coordinates: [
          [
            [-190, -33],
            [-70, -33],
            [-70, -34],
            [-190, -33],
          ],
        ],
      }),
    ).toThrowError(DomainError);

    const preview = previewOsmExport({
      elements: [
        {
          geometry: [
            { lat: -0.448, lon: -0.669 },
            { lat: -0.449, lon: -0.668 },
          ],
          id: 44,
          tags: { highway: "residential", name: "Los Aromos" },
          type: "way",
          version: 3,
        },
        {
          id: 55,
          lat: -0.4485,
          lon: -0.6685,
          tags: { "addr:housenumber": "120A", "addr:street": "Los Aromos" },
          type: "node",
        },
      ],
    });
    expect(preview).toMatchObject({
      points: [{ externalId: "node/55", number: "120A", source: "OSM" }],
      segments: [
        {
          externalId: "way/44",
          name: "Los Aromos",
          serviceSide: "BOTH",
          source: "OSM",
          sourceVersion: "3",
        },
      ],
      summary: { candidatePoints: 1, candidateSegments: 1, sourceElements: 2 },
    });
    expect(preview.attribution).toContain("OpenStreetMap");
  });

  it("accepts address candidates mapped on ways and relations", () => {
    const preview = previewOsmExport({
      elements: [
        {
          center: { lat: -0.45, lon: -0.66 },
          id: 21,
          tags: { "addr:housenumber": "140", "addr:street": "Los Aromos" },
          type: "way",
        },
        {
          geometry: [
            { lat: -0.451, lon: -0.661 },
            { lat: -0.4512, lon: -0.6612 },
          ],
          id: 22,
          tags: { "addr:housenumber": "142", "addr:street": "Los Aromos" },
          type: "relation",
        },
      ],
    });

    expect(preview.points).toHaveLength(2);
    expect(preview.points.map((point) => point.externalId)).toEqual(["way/21", "relation/22"]);
    expect(preview.points[0]).toMatchObject({ latitude: -0.45, longitude: -0.66 });
  });

  it("versions area, segments and points with optimistic/idempotent draft changes", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);
    const imported = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "geo-import-001",
      routeName: "Ruta geográfica",
      sectorName: "Sector geográfico",
    });
    if (!imported.route || !imported.revision) throw new Error("Expected route draft");
    expect(imported.revision).toMatchObject({
      area: null,
      draftVersion: 1,
      segmentCount: 0,
    });

    const areaOperationId = randomUUID();
    const areaResult = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 1,
      change: { geometry: normalizeAreaGeometry(area), type: "SET_AREA" },
      crewId: seed.crewIds.primary,
      operationId: areaOperationId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(areaResult).toMatchObject({ draftVersion: 2, pointCount: 2, replayed: false });
    const areaReplay = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 1,
      change: { geometry: normalizeAreaGeometry(area), type: "SET_AREA" },
      crewId: seed.crewIds.primary,
      operationId: areaOperationId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(areaReplay).toMatchObject({ draftVersion: 2, replayed: true });
    await expect(
      service.applyRevisionChange({
        actorUserId: seed.userIds.admin,
        baseDraftVersion: 2,
        change: { geometry: normalizeAreaGeometry(area), type: "SET_AREA" },
        crewId: seed.crewIds.primary,
        operationId: areaOperationId,
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE", statusCode: 409 });
    await expect(
      service.applyRevisionChange({
        actorUserId: seed.userIds.admin,
        baseDraftVersion: 1,
        change: { geometry: null, type: "SET_AREA" },
        crewId: seed.crewIds.primary,
        operationId: areaOperationId,
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE", statusCode: 409 });
    await expect(
      service.applyRevisionChange({
        actorUserId: seed.userIds.admin,
        baseDraftVersion: 1,
        change: { geometry: null, type: "SET_AREA" },
        crewId: seed.crewIds.primary,
        operationId: randomUUID(),
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_VERSION_CONFLICT", statusCode: 409 });

    const segmentResult = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 2,
      change: {
        segments: [
          {
            attribution: "OpenStreetMap contributors ODbL 1.0",
            externalId: "way/44",
            geometry: {
              coordinates: [
                [
                  [-0.669, -0.448],
                  [-0.668, -0.449],
                ],
              ],
              type: "MultiLineString",
            },
            name: "Los Aromos",
            serviceSide: "LEFT",
            source: "OSM",
            sourceVersion: "3",
          },
        ],
        type: "REPLACE_SEGMENTS",
      },
      crewId: seed.crewIds.primary,
      operationId: randomUUID(),
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(segmentResult).toMatchObject({ draftVersion: 3, segmentCount: 1 });

    const added = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 3,
      change: {
        point: {
          externalId: "manual-001",
          latitude: -0.4482,
          longitude: -0.6682,
          number: "201",
          pointType: "SPECIAL",
          source: "MANUAL",
          street: "Pasaje local",
        },
        type: "ADD_POINT",
      },
      crewId: seed.crewIds.primary,
      operationId: randomUUID(),
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(added).toMatchObject({ draftVersion: 4, pointCount: 3 });
    const afterAdd = await service.getRevisionFeatures(
      seed.crewIds.primary,
      imported.route.id,
      imported.revision.id,
    );
    const manual = afterAdd?.points.features.find(
      (feature) => feature.properties.externalId === "manual-001",
    );
    expect(manual).toBeDefined();

    const updated = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 4,
      change: {
        point: { latitude: -0.4483, longitude: -0.6683, number: "201B" },
        servicePointId: manual?.id ?? randomUUID(),
        type: "UPDATE_POINT",
        ...(manual?.properties.servicePointVersionId
          ? { expectedServicePointVersionId: manual.properties.servicePointVersionId }
          : {}),
      },
      crewId: seed.crewIds.primary,
      operationId: randomUUID(),
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(updated.draftVersion).toBe(5);
    const afterUpdate = await service.getRevisionFeatures(
      seed.crewIds.primary,
      imported.route.id,
      imported.revision.id,
    );
    const moved = afterUpdate?.points.features.find((feature) => feature.id === manual?.id);
    expect(moved).toMatchObject({
      geometry: { coordinates: [-0.6683, -0.4483] },
      properties: { number: "201B" },
    });
    expect(moved?.properties.servicePointVersionId).not.toBe(
      manual?.properties.servicePointVersionId,
    );

    const removed = await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 5,
      change: { servicePointId: manual?.id ?? randomUUID(), type: "REMOVE_POINT" },
      crewId: seed.crewIds.primary,
      operationId: randomUUID(),
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    expect(removed).toMatchObject({ draftVersion: 6, pointCount: 2 });

    const published = await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    const revision = published.revisions.find(
      (candidate) => candidate.id === imported.revision?.id,
    );
    expect(revision).toMatchObject({
      area: { type: "MultiPolygon" },
      contentSchemaVersion: 2,
      draftVersion: 6,
      segmentCount: 1,
      status: "PUBLISHED",
    });
    expect(revision?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    const routePackage = await service.getRoutePackage(
      seed.crewIds.primary,
      imported.route.id,
      imported.revision.id,
    );
    expect(routePackage).toMatchObject({
      kind: "ROUTE_REVISION_PACKAGE",
      revision: {
        contentHash: revision?.contentHash,
        number: 1,
        pointCount: 2,
      },
      schemaVersion: 1,
      segments: [{ externalId: "way/44", serviceSide: "LEFT", source: "OSM" }],
    });
    expect(routePackage.attributions[0]?.label).toContain("OpenStreetMap");
    const serialized = serializeRoutePackage(routePackage);
    expect(serialized.byteLength).toBe(Buffer.byteLength(serialized.body, "utf8"));
    expect(serialized.etag).toBe(`"sha256-${serialized.sha256}"`);
    expect(serialized.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const plainImport = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "geo-import-without-shapes-002",
      routeName: "Ruta sin geometría",
      sectorName: "Sector geográfico",
    });
    if (!plainImport.route || !plainImport.revision) throw new Error("Expected second draft");
    await service.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 1,
      change: {
        segments: [
          {
            attribution: "OpenStreetMap contributors ODbL 1.0",
            externalId: "way/44",
            geometry: {
              coordinates: [
                [
                  [-0.669, -0.448],
                  [-0.668, -0.449],
                ],
              ],
              type: "MultiLineString",
            },
            name: "Los Aromos",
            serviceSide: "RIGHT",
            source: "OSM",
            sourceVersion: "3",
          },
        ],
        type: "REPLACE_SEGMENTS",
      },
      crewId: seed.crewIds.primary,
      operationId: randomUUID(),
      revisionId: plainImport.revision.id,
      routeId: plainImport.route.id,
    });
    const plainPublished = await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: plainImport.revision.id,
      routeId: plainImport.route.id,
    });
    expect(plainPublished.revisions[0]?.contentHash).not.toBe(revision?.contentHash);
    const sharedAssignments = await database.query<{
      service_side: string;
      street_segment_id: string;
      street_segment_version_id: string;
    }>(
      `SELECT service_side, street_segment_id, street_segment_version_id
       FROM route_revision_segment
       WHERE crew_id = $1 AND route_revision_id IN ($2, $3)
       ORDER BY service_side`,
      [seed.crewIds.primary, imported.revision.id, plainImport.revision.id],
    );
    expect(sharedAssignments.rows.map((row) => row.service_side)).toEqual(["LEFT", "RIGHT"]);
    expect(new Set(sharedAssignments.rows.map((row) => row.street_segment_id)).size).toBe(1);
    expect(new Set(sharedAssignments.rows.map((row) => row.street_segment_version_id)).size).toBe(
      1,
    );

    await expect(
      service.applyRevisionChange({
        actorUserId: seed.userIds.admin,
        baseDraftVersion: 6,
        change: { geometry: null, type: "SET_AREA" },
        crewId: seed.crewIds.primary,
        operationId: randomUUID(),
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REVISION_STATE", statusCode: 409 });
    await expect(
      database.query(
        `UPDATE route_revision_area_version SET content_hash = repeat('0', 64)
         WHERE crew_id = $1 AND route_revision_id = $2`,
        [seed.crewIds.primary, imported.revision.id],
      ),
    ).rejects.toThrow(/ROUTE_GEOGRAPHY_VERSION_APPEND_ONLY/u);
    await expect(
      database.query(
        `UPDATE route_revision_segment SET service_side = 'RIGHT'
         WHERE crew_id = $1 AND route_revision_id = $2`,
        [seed.crewIds.primary, imported.revision.id],
      ),
    ).rejects.toThrow(/PUBLISHED_ROUTE_REVISION_POINTS_IMMUTABLE/u);
    await expect(
      database.query(
        `DELETE FROM route_revision_segment
         WHERE crew_id = $1 AND route_revision_id = $2`,
        [seed.crewIds.primary, imported.revision.id],
      ),
    ).rejects.toThrow(/PUBLISHED_ROUTE_REVISION_POINTS_IMMUTABLE/u);
  });

  it("rejects ambiguous side orientation across disconnected line components", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const service = new RouteService(database);
    const imported = await service.importRoute({
      actorUserId: opened.seed.userIds.admin,
      crewId: opened.seed.crewIds.primary,
      csv: validCsv,
      importKey: "side-orientation-import-001",
      routeName: "Ruta orientación",
      sectorName: "Sector orientación",
    });
    if (!imported.route || !imported.revision) throw new Error("Expected route draft");

    await expect(
      service.applyRevisionChange({
        actorUserId: opened.seed.userIds.admin,
        baseDraftVersion: 1,
        change: {
          segments: [
            {
              externalId: "manual/disconnected",
              geometry: {
                coordinates: [
                  [
                    [-0.669, -0.448],
                    [-0.668, -0.449],
                  ],
                  [
                    [-0.667, -0.45],
                    [-0.666, -0.451],
                  ],
                ],
                type: "MultiLineString",
              },
              serviceSide: "LEFT",
              source: "MANUAL",
            },
          ],
          type: "REPLACE_SEGMENTS",
        },
        crewId: opened.seed.crewIds.primary,
        operationId: randomUUID(),
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      }),
    ).rejects.toMatchObject({ code: "SEGMENT_SIDE_ORIENTATION_INVALID", statusCode: 422 });
  });

  it("backfills legacy published segments as BOTH without changing their package or hash", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const service = new RouteService(database);
    const geometry: MultiLineStringGeometry = {
      coordinates: [
        [
          [-0.669, -0.448],
          [-0.668, -0.449],
        ],
      ],
      type: "MultiLineString",
    };

    async function publishWithSide(key: string, serviceSide: "BOTH" | "LEFT" | "RIGHT") {
      const imported = await service.importRoute({
        actorUserId: opened.seed.userIds.admin,
        crewId: opened.seed.crewIds.primary,
        csv: validCsv,
        importKey: `legacy-side-${key}`,
        routeName: `Ruta ${key}`,
        sectorName: "Sector compatibilidad",
      });
      if (!imported.route || !imported.revision) throw new Error("Expected route draft");
      const operationId = randomUUID();
      await service.applyRevisionChange({
        actorUserId: opened.seed.userIds.admin,
        baseDraftVersion: 1,
        change: {
          segments: [
            {
              externalId: "manual/shared-hash-segment",
              geometry,
              name: "Los Aromos",
              serviceSide,
              source: "MANUAL",
            },
          ],
          type: "REPLACE_SEGMENTS",
        },
        crewId: opened.seed.crewIds.primary,
        operationId,
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      });
      if (serviceSide === "BOTH") {
        const receipt = await database?.query<{ payload_hash: string }>(
          `SELECT payload_hash FROM route_revision_change
           WHERE crew_id = $1 AND id = $2`,
          [opened.seed.crewIds.primary, operationId],
        );
        expect(receipt?.rows[0]?.payload_hash).toBe(
          canonicalHash({
            baseDraftVersion: 1,
            change: {
              segments: [
                {
                  externalId: "manual/shared-hash-segment",
                  geometry,
                  name: "Los Aromos",
                  source: "MANUAL",
                },
              ],
              type: "REPLACE_SEGMENTS",
            },
            revisionId: imported.revision.id,
            routeId: imported.route.id,
          }),
        );
      }
      const published = await service.publishRevision({
        actorUserId: opened.seed.userIds.admin,
        crewId: opened.seed.crewIds.primary,
        revisionId: imported.revision.id,
        routeId: imported.route.id,
      });
      const revision = published.revisions.find(
        (candidate) => candidate.id === imported.revision?.id,
      );
      if (!revision?.contentHash) throw new Error("Expected published content hash");
      return {
        contentHash: revision.contentHash,
        package: await service.getRoutePackage(
          opened.seed.crewIds.primary,
          imported.route.id,
          imported.revision.id,
        ),
      };
    }

    const legacyBoth = await publishWithSide("both", "BOTH");
    await database.exec(`
      ALTER TABLE route_revision_segment DROP COLUMN service_side;
    `);
    const migration = await readFile(
      fileURLToPath(
        new URL("../../../database/migrations/006_route_segment_service_side.sql", import.meta.url),
      ),
      "utf8",
    );
    await database.exec(migration);

    const restoredPackage = await service.getRoutePackage(
      opened.seed.crewIds.primary,
      legacyBoth.package.route.id,
      legacyBoth.package.revision.id,
    );
    expect(restoredPackage).toEqual(legacyBoth.package);
    expect(restoredPackage.revision.contentHash).toBe(legacyBoth.contentHash);
    expect(restoredPackage.segments[0]?.serviceSide).toBe("BOTH");

    const left = await publishWithSide("left", "LEFT");
    const right = await publishWithSide("right", "RIGHT");
    expect(left.contentHash).not.toBe(legacyBoth.contentHash);
    expect(right.contentHash).not.toBe(legacyBoth.contentHash);
    expect(left.contentHash).not.toBe(right.contentHash);
  });
});
