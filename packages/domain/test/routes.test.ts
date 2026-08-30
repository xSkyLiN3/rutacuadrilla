import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  type DomainDatabase,
  type DomainError,
  RouteService,
} from "../src/index.js";
import { openSeededDatabase, validCsv } from "./helpers.js";

describe.sequential("route service", () => {
  let database: DomainDatabase | undefined;

  afterEach(async () => {
    if (database) {
      await closeDatabase(database);
      database = undefined;
    }
  });

  it("does not write invalid CSV and enforces the editing capability", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);

    const invalid = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv.replace("-0.4489", "-133.4489"),
      importKey: "invalid-csv",
      routeName: "Ruta inválida",
      sectorName: "Sector centro",
    });
    expect(invalid).toMatchObject({
      created: false,
      revision: null,
      route: null,
    });
    expect(invalid.errors[0]).toMatchObject({
      code: "INVALID_LATITUDE",
      row: 2,
    });
    const noWrites = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM route`,
    );
    expect(noWrites.rows[0]?.count).toBe("0");

    await expect(
      service.importRoute({
        actorUserId: seed.userIds.member,
        crewId: seed.crewIds.primary,
        csv: validCsv,
        importKey: "member-cannot-edit",
        routeName: "Ruta miembro",
        sectorName: "Sector centro",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_REQUIRED",
      statusCode: 403,
    } satisfies Partial<DomainError>);
    expect(await service.listRoutes(seed.crewIds.primary)).toHaveLength(0);
  });

  it("imports atomically, isolates crews and replays an import key once", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);
    const command = {
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "route-import-001",
      routeName: "Ruta Los Aromos",
      sectorName: "Sector centro",
    };

    const first = await service.importRoute(command);
    expect(first.created).toBe(true);
    expect(first.revision).toMatchObject({
      number: null,
      pointCount: 2,
      status: "DRAFT",
    });
    expect(first.revision).not.toHaveProperty("contentHash");
    const replay = await service.importRoute(command);
    expect(replay.created).toBe(false);
    expect(replay.revision?.id).toBe(first.revision?.id);
    expect(replay.route?.id).toBe(first.route?.id);
    const listed = await service.listRoutes(seed.crewIds.primary);
    expect(listed[0]).toMatchObject({
      id: first.route?.id,
      latestRevision: { id: first.revision?.id },
    });

    const counts = await database.query<{
      batches: string;
      points: string;
      revisions: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM import_batch)::text AS batches,
         (SELECT COUNT(*) FROM service_point)::text AS points,
         (SELECT COUNT(*) FROM route_revision)::text AS revisions`,
    );
    expect(counts.rows[0]).toEqual({
      batches: "1",
      points: "2",
      revisions: "1",
    });

    await expect(
      service.importRoute({
        ...command,
        csv: validCsv.replace("-0.4489", "-0.4488"),
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
      statusCode: 409,
    } satisfies Partial<DomainError>);
    expect(await service.listRoutes(seed.crewIds.secondary)).toEqual([]);
    expect(
      await service.getRoute(
        seed.crewIds.secondary,
        first.route?.id ?? "00000000-0000-0000-0000-000000000000",
      ),
    ).toBeNull();
  });

  it("imports initial area and segments atomically and includes them in idempotency", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);
    const area = {
      coordinates: [
        [
          [
            [-0.671, -0.451],
            [-0.668, -0.451],
            [-0.668, -0.447],
            [-0.671, -0.447],
            [-0.671, -0.451],
          ],
        ],
      ],
      type: "MultiPolygon" as const,
    };
    const segment = {
      attribution: "Datos sintéticos de prueba.",
      externalId: "synthetic/segment/001",
      geometry: {
        coordinates: [
          [
            [-0.6705, -0.449],
            [-0.6685, -0.449],
          ],
        ],
        type: "MultiLineString" as const,
      },
      name: "Calle sintética",
      serviceSide: "LEFT" as const,
      source: "GEOJSON" as const,
      sourceVersion: "synthetic-v1",
    };
    const segments = [segment];
    const command = {
      actorUserId: seed.userIds.admin,
      area,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "route-import-with-geography-001",
      routeName: "Ruta sintética completa",
      sectorName: "Sector sintético",
      segments,
    };

    const first = await service.importRoute(command);
    expect(first.created).toBe(true);
    expect(first.revision).toMatchObject({
      area,
      draftVersion: 3,
      pointCount: 2,
      segmentCount: 1,
      status: "DRAFT",
    });
    if (!first.route || !first.revision) throw new Error("Expected imported geography");
    const features = await service.getRevisionFeatures(
      seed.crewIds.primary,
      first.route.id,
      first.revision.id,
    );
    expect(features).toMatchObject({
      area,
      draftVersion: 3,
      segmentCount: 1,
      segments: {
        features: [
          {
            properties: {
              attribution: "Datos sintéticos de prueba.",
              externalId: "synthetic/segment/001",
              name: "Calle sintética",
              serviceSide: "LEFT",
              source: "GEOJSON",
              sourceVersion: "synthetic-v1",
            },
          },
        ],
      },
    });

    const replay = await service.importRoute(command);
    expect(replay.created).toBe(false);
    expect(replay.revision?.id).toBe(first.revision.id);
    const receipts = await database.query<{ changes: number; imports: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM import_batch) AS imports,
         (SELECT COUNT(*)::integer FROM route_revision_change) AS changes`,
    );
    expect(receipts.rows[0]).toEqual({ changes: 2, imports: 1 });

    await expect(
      service.importRoute({
        ...command,
        segments: [{ ...segment, serviceSide: "RIGHT" as const }],
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
      statusCode: 409,
    } satisfies Partial<DomainError>);
  });

  it("replaces a DRAFT atomically and replays an edit without duplicate effects", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);
    const imported = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "draft-edit-import-001",
      routeName: "Ruta corregible",
      sectorName: "Sector oriente",
    });
    if (!imported.route || !imported.revision) {
      throw new Error("Expected an imported draft");
    }
    const originalPoint = imported.revision.points.find((point) => point.externalId === "home-001");
    if (!originalPoint) {
      throw new Error("Expected original point");
    }
    const correctedCsv = `external_id,street,number,latitude,longitude,point_type,source
home-001,Los Aromos,101,-0.4485,-0.6691,DWELLING,CSV
home-003,Los Alerces,201,-0.4500,-0.6700,SPECIAL,CSV
home-004,Los Alerces,203,-0.4501,-0.6701,DWELLING,CSV`;
    const command = {
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: correctedCsv,
      editKey: "draft-edit-001",
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    };

    const corrected = await service.correctDraftPoints(command);
    expect(corrected).toMatchObject({
      errors: [],
      replayed: false,
      revision: { id: imported.revision.id, pointCount: 3, status: "DRAFT" },
      route: { id: imported.route.id },
    });
    expect(corrected.revision?.points.map((point) => point.externalId)).toEqual([
      "home-001",
      "home-003",
      "home-004",
    ]);
    expect(corrected.revision?.points[0]).toMatchObject({
      id: originalPoint.id,
      latitude: -0.4485,
    });
    expect(corrected.revision?.points[0]?.servicePointVersionId).not.toBe(
      originalPoint.servicePointVersionId,
    );
    const originalVersion = await database.query<{
      latitude: number;
      street: string | null;
    }>(
      `SELECT latitude, street
       FROM service_point_version
       WHERE crew_id = $1 AND id = $2`,
      [seed.crewIds.primary, originalPoint.servicePointVersionId],
    );
    expect(Number(originalVersion.rows[0]?.latitude)).toBe(-0.4489);
    expect(originalVersion.rows[0]?.street).toBe("Los Aromos");

    const replay = await service.correctDraftPoints(command);
    expect(replay.replayed).toBe(true);
    expect(replay.revision?.points).toEqual(corrected.revision?.points);
    const counts = await database.query<{
      audits: string;
      edits: string;
      links: string;
      versions: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM audit_event
          WHERE action = 'ROUTE_DRAFT_POINTS_CORRECTED')::text AS audits,
         (SELECT COUNT(*) FROM route_revision_edit)::text AS edits,
         (SELECT COUNT(*) FROM route_revision_point
          WHERE crew_id = $1 AND route_revision_id = $2)::text AS links,
         (SELECT COUNT(*) FROM service_point_version)::text AS versions`,
      [seed.crewIds.primary, imported.revision.id],
    );
    expect(counts.rows[0]).toEqual({
      audits: "1",
      edits: "1",
      links: "3",
      versions: "5",
    });

    await expect(
      service.correctDraftPoints({
        ...command,
        csv: correctedCsv.replace("-0.4485", "-0.4484"),
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
      statusCode: 409,
    } satisfies Partial<DomainError>);
    const invalid = await service.correctDraftPoints({
      ...command,
      csv: correctedCsv.replace("-0.4485", "-133.4485"),
      editKey: "draft-edit-invalid-002",
    });
    expect(invalid.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LATITUDE", row: 2 })]),
    );
    expect(invalid.revision?.points).toEqual(corrected.revision?.points);
    const afterInvalid = await database.query<{
      audits: string;
      edits: string;
      links: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM audit_event
          WHERE action = 'ROUTE_DRAFT_POINTS_CORRECTED')::text AS audits,
         (SELECT COUNT(*) FROM route_revision_edit)::text AS edits,
         (SELECT COUNT(*) FROM route_revision_point
          WHERE crew_id = $1 AND route_revision_id = $2)::text AS links`,
      [seed.crewIds.primary, imported.revision.id],
    );
    expect(afterInvalid.rows[0]).toEqual({ audits: "1", edits: "1", links: "3" });

    await expect(
      service.correctDraftPoints({
        ...command,
        actorUserId: seed.userIds.member,
        editKey: "draft-edit-member-003",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED", statusCode: 403 });
    await expect(
      service.correctDraftPoints({
        ...command,
        actorUserId: seed.userIds.outsider,
        crewId: seed.crewIds.secondary,
        editKey: "draft-edit-cross-004",
      }),
    ).rejects.toMatchObject({ code: "ROUTE_NOT_FOUND", statusCode: 404 });

    await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    await expect(
      service.correctDraftPoints({
        ...command,
        editKey: "draft-edit-published-005",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_REVISION_STATE",
      statusCode: 409,
    });
  });

  it("publishes immutable hashes and supersedes without rewriting history", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new RouteService(database);
    const imported = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv,
      importKey: "publish-001",
      routeName: "Ruta Histórica",
      sectorName: "Sector poniente",
    });
    if (!imported.route || !imported.revision) {
      throw new Error("Expected an imported route");
    }

    const firstPublished = await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    const first = firstPublished.revisions.find(
      (revision) => revision.id === imported.revision?.id,
    );
    expect(first).toMatchObject({
      number: 1,
      pointCount: 2,
      status: "PUBLISHED",
    });
    expect(first?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    const audit = await database.query<{
      action: string;
      actor_membership_id: string;
      aggregate_id: string;
      aggregate_type: string;
      crew_id: string;
      id: string;
      metadata_text: string;
      occurred_at: string;
    }>(
      `SELECT crew_id, id, actor_membership_id, action, aggregate_type,
              aggregate_id, metadata::text AS metadata_text,
              occurred_at::text
       FROM audit_event
       WHERE crew_id = $1 AND aggregate_id = $2
       ORDER BY occurred_at, id`,
      [seed.crewIds.primary, imported.revision.id],
    );
    expect(audit.rows.map((event) => event.action).sort()).toEqual([
      "ROUTE_IMPORTED",
      "ROUTE_REVISION_PUBLISHED",
    ]);
    for (const event of audit.rows) {
      expect(event).toMatchObject({
        actor_membership_id: seed.membershipIds.admin,
        aggregate_id: imported.revision.id,
        aggregate_type: "RouteRevision",
        crew_id: seed.crewIds.primary,
      });
      expect(Number.isNaN(Date.parse(event.occurred_at))).toBe(false);
      expect(event.metadata_text.toLowerCase()).not.toMatch(
        /password|token|external_id|los aromos|latitude|longitude|\bcsv\b/u,
      );
    }
    await expect(
      database.query(
        `UPDATE audit_event
         SET action = 'TAMPERED'
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, audit.rows[0]?.id],
      ),
    ).rejects.toThrow(/AUDIT_EVENT_APPEND_ONLY/u);
    await expect(
      database.query(
        `DELETE FROM audit_event
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, audit.rows[0]?.id],
      ),
    ).rejects.toThrow(/AUDIT_EVENT_APPEND_ONLY/u);
    const historicalBeforeIdentityAttack = await service.getRoute(
      seed.crewIds.primary,
      imported.route.id,
    );
    await expect(
      database.query(
        `UPDATE service_point
         SET external_id = 'rewritten-history'
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, first?.points[0]?.id],
      ),
    ).rejects.toThrow(/SERVICE_POINT_IDENTITY_IMMUTABLE/u);
    const historicalAfterIdentityAttack = await service.getRoute(
      seed.crewIds.primary,
      imported.route.id,
    );
    expect(historicalAfterIdentityAttack).toEqual(historicalBeforeIdentityAttack);

    await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    const counter = await database.query<{
      published_revision_sequence: number;
    }>(
      `SELECT published_revision_sequence
       FROM route
       WHERE crew_id = $1 AND id = $2`,
      [seed.crewIds.primary, imported.route.id],
    );
    expect(Number(counter.rows[0]?.published_revision_sequence)).toBe(1);

    const point = first?.points[0];
    expect(point).toBeDefined();
    await expect(
      database.query(
        `UPDATE service_point_version
         SET street = 'Mutación prohibida'
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, point?.servicePointVersionId],
      ),
    ).rejects.toThrow(/SERVICE_POINT_VERSION_APPEND_ONLY/u);
    await expect(
      database.query(
        `DELETE FROM service_point_version
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, point?.servicePointVersionId],
      ),
    ).rejects.toThrow(/SERVICE_POINT_VERSION_APPEND_ONLY/u);
    await expect(
      database.query(
        `UPDATE route_revision
         SET point_count = point_count + 1
         WHERE crew_id = $1 AND id = $2`,
        [seed.crewIds.primary, imported.revision.id],
      ),
    ).rejects.toThrow(/PUBLISHED_ROUTE_REVISION_CONTENT_IMMUTABLE/u);
    await expect(
      database.query(
        `INSERT INTO route_revision_point
           (crew_id, route_revision_id, service_point_id,
            service_point_version_id, display_order)
         VALUES ($1, $2, $3, $4, 99)`,
        [seed.crewIds.primary, imported.revision.id, point?.id, point?.servicePointVersionId],
      ),
    ).rejects.toThrow(/PUBLISHED_ROUTE_REVISION_POINTS_IMMUTABLE/u);

    const secondImport = await service.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv: validCsv.replace("-0.4489", "-0.4487"),
      importKey: "publish-002",
      routeName: "Ruta Histórica",
      sectorName: "Sector poniente",
    });
    if (!secondImport.revision) {
      throw new Error("Expected a second revision");
    }
    const finalRoute = await service.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: secondImport.revision.id,
      routeId: imported.route.id,
    });
    const historical = finalRoute.revisions.find(
      (revision) => revision.id === imported.revision?.id,
    );
    const current = finalRoute.revisions.find(
      (revision) => revision.id === secondImport.revision?.id,
    );
    expect(historical).toMatchObject({
      contentHash: first?.contentHash,
      number: 1,
      status: "SUPERSEDED",
    });
    expect(historical?.points[0]?.latitude).toBe(-0.4489);
    expect(current).toMatchObject({ number: 2, status: "PUBLISHED" });
    expect(current?.contentHash).not.toBe(first?.contentHash);
    expect(current?.points[0]?.latitude).toBe(-0.4487);

    const versions = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM service_point_version",
    );
    expect(versions.rows[0]?.count).toBe("3");
  });
});
