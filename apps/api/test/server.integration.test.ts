import { randomUUID } from "node:crypto";
import {
  CampaignService,
  closeDatabase,
  createDatabase,
  type DomainDatabase,
  migrateDatabase,
  RouteService,
  SyncService,
  seedDemoData,
  WorkSessionService,
} from "@rutacuadrilla/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const config: ApiConfig = {
  appProfile: "full",
  apiHost: "127.0.0.1",
  apiPort: 4310,
  corsOrigins: ["http://127.0.0.1:4311", "http://127.0.0.1:4312"],
  databaseDir: ".local/test-not-used",
  environment: "test",
  sessionSecret: "integration-test-secret-with-more-than-32-characters",
  sessionTtlMinutes: 60,
  trustProxy: 1,
};

const canonicalCsv = [
  "external_id,street,number,latitude,longitude,point_type,source",
  "casa-001,Los Aromos,120,-0.45120,-0.66210,DWELLING,CSV",
  "casa-002,Los Aromos,126,-0.45170,-0.66140,DWELLING,CSV",
].join("\n");

type LoginPayload = {
  memberships: { crewId: string }[];
  token: string;
};

describe("HTTP API integrated with the PostgreSQL contract", () => {
  let database: DomainDatabase;
  let server: FastifyInstance;
  let crewIds: { primary: string; secondary: string };

  beforeEach(async () => {
    database = await createDatabase();
    await migrateDatabase(database);
    const seed = await seedDemoData(database, {
      adminPassword: "Admin-Demo-2026!",
      memberPassword: "Member-Demo-2026!",
      outsiderPassword: "Outsider-Demo-2026!",
    });
    crewIds = seed.crewIds;
    server = await buildServer({
      campaignService: new CampaignService(database),
      config,
      database,
      routeService: new RouteService(database),
      syncService: new SyncService(database),
      workSessionService: new WorkSessionService(database),
    });
  });

  afterEach(async () => {
    await server.close();
    await closeDatabase(database);
  });

  async function login(email: string, password: string): Promise<LoginPayload> {
    const response = await server.inject({
      method: "POST",
      payload: { email, password },
      url: "/api/auth/login",
    });
    expect(response.statusCode).toBe(200);
    return response.json<LoginPayload>();
  }

  it("separates liveness from database and migration readiness", async () => {
    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["cache-control"]).toBe("no-store");
    expect(health.json()).toEqual({ service: "rutacuadrilla-api", status: "ok" });

    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(ready.json()).toEqual({ service: "rutacuadrilla-api", status: "ready" });

    await database.query("DELETE FROM schema_migration WHERE name = $1", ["010_simple_online.sql"]);
    const migrationMissing = await server.inject({ method: "GET", url: "/ready" });
    expect(migrationMissing.statusCode).toBe(503);
    expect(migrationMissing.headers["cache-control"]).toBe("no-store");
    expect(migrationMissing.json()).toEqual({
      service: "rutacuadrilla-api",
      status: "not_ready",
    });

    const stillLive = await server.inject({ method: "GET", url: "/health" });
    expect(stillLive.statusCode).toBe(200);
  });

  it("returns not-ready without leaking a database probe failure", async () => {
    await database.exec("DROP TABLE schema_migration");
    const response = await server.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ service: "rutacuadrilla-api", status: "not_ready" });
  });

  it("uses the configured trusted proxy hop for the client address", async () => {
    server.get("/__test/client-ip", async (request) => ({ ip: request.ip }));
    const response = await server.inject({
      headers: { "x-forwarded-for": "198.51.100.42" },
      method: "GET",
      url: "/__test/client-ip",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: "198.51.100.42" });
  });

  it("runs login, import, publication, idempotent replay and logout end to end", async () => {
    const session = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    expect(session.memberships.map((membership) => membership.crewId)).toContain(crewIds.primary);
    const authorization = { authorization: `Bearer ${session.token}` };

    const emptyList = await server.inject({
      headers: authorization,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/routes`,
    });
    expect(emptyList.statusCode).toBe(200);
    expect(emptyList.json()).toEqual([]);

    const input = {
      csv: canonicalCsv,
      importKey: "integration-import-001",
      routeName: "Ruta Norte",
      sectorName: "Sector Norte",
    };
    const imported = await server.inject({
      headers: authorization,
      method: "POST",
      payload: input,
      url: `/api/crews/${crewIds.primary}/routes/import`,
    });
    expect(imported.statusCode).toBe(201);
    const importedPayload = imported.json<{
      revision: { id: string; number: null; status: string };
      route: { id: string };
    }>();
    expect(importedPayload.revision).toMatchObject({ number: null, status: "DRAFT" });

    const correctedCsv = `${canonicalCsv.replace("-0.45120", "-0.45110")}
casa-003,Los Aromos,130,-0.45200,-0.66100,SPECIAL,CSV`;
    const editInput = {
      csv: correctedCsv,
      editKey: "integration-edit-001",
    };
    const invalidEdit = await server.inject({
      headers: authorization,
      method: "PUT",
      payload: {
        csv: correctedCsv.replace("-0.45110", "-133.45110"),
        editKey: "integration-edit-invalid",
      },
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/points`,
    });
    expect(invalidEdit.statusCode).toBe(422);
    expect(invalidEdit.json<{ revision: { pointCount: number } }>().revision.pointCount).toBe(2);

    const corrected = await server.inject({
      headers: authorization,
      method: "PUT",
      payload: editInput,
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/points`,
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      errors: [],
      replayed: false,
      revision: { id: importedPayload.revision.id, pointCount: 3, status: "DRAFT" },
      route: { id: importedPayload.route.id },
    });
    const editReplay = await server.inject({
      headers: authorization,
      method: "PUT",
      payload: editInput,
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/points`,
    });
    expect(editReplay.statusCode).toBe(200);
    expect(editReplay.json()).toMatchObject({ replayed: true });
    const editKeyConflict = await server.inject({
      headers: authorization,
      method: "PUT",
      payload: {
        ...editInput,
        csv: correctedCsv.replace("-0.45110", "-0.45100"),
      },
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/points`,
    });
    expect(editKeyConflict.statusCode).toBe(409);
    expect(editKeyConflict.json()).toEqual({ code: "IDEMPOTENCY_KEY_REUSE" });

    const published = await server.inject({
      headers: authorization,
      method: "POST",
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/publish`,
    });
    expect(published.statusCode).toBe(200);
    const publishedPayload = published.json<{
      revisions: {
        contentHash?: string;
        id: string;
        number: number;
        pointCount: number;
        status: string;
      }[];
    }>();
    expect(publishedPayload.revisions[0]).toMatchObject({
      id: importedPayload.revision.id,
      number: 1,
      pointCount: 3,
      status: "PUBLISHED",
    });
    expect(publishedPayload.revisions[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    const editPublished = await server.inject({
      headers: authorization,
      method: "PUT",
      payload: { ...editInput, editKey: "integration-edit-after-publish" },
      url:
        `/api/crews/${crewIds.primary}/routes/${importedPayload.route.id}` +
        `/revisions/${importedPayload.revision.id}/points`,
    });
    expect(editPublished.statusCode).toBe(409);
    expect(editPublished.json()).toEqual({ code: "INVALID_REVISION_STATE" });

    const replay = await server.inject({
      headers: authorization,
      method: "POST",
      payload: input,
      url: `/api/crews/${crewIds.primary}/routes/import`,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ revision: { id: string } }>().revision.id).toBe(
      importedPayload.revision.id,
    );

    const logout = await server.inject({
      headers: authorization,
      method: "POST",
      url: "/api/auth/logout",
    });
    expect(logout.statusCode).toBe(204);
    const revoked = await server.inject({
      headers: authorization,
      method: "GET",
      url: "/api/me",
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toEqual({ code: "SESSION_REVOKED_OR_EXPIRED" });
  });

  it("rejects cross-crew UUID access and editing without a capability", async () => {
    const outsider = await login("externo@demo.rutacuadrilla.local", "Outsider-Demo-2026!");
    const crossCrew = await server.inject({
      headers: { authorization: `Bearer ${outsider.token}` },
      method: "GET",
      url: `/api/crews/${crewIds.primary}/routes`,
    });
    expect(crossCrew.statusCode).toBe(403);
    expect(crossCrew.json()).toEqual({ code: "FORBIDDEN" });

    const member = await login("miembro@demo.rutacuadrilla.local", "Member-Demo-2026!");
    const forbiddenImport = await server.inject({
      headers: { authorization: `Bearer ${member.token}` },
      method: "POST",
      payload: {
        csv: canonicalCsv,
        importKey: "member-forbidden-001",
        routeName: "Ruta no autorizada",
        sectorName: "Sector Norte",
      },
      url: `/api/crews/${crewIds.primary}/routes/import`,
    });
    expect(forbiddenImport.statusCode).toBe(403);
    expect(forbiddenImport.json()).toEqual({ code: "FORBIDDEN" });

    const forbiddenEdit = await server.inject({
      headers: { authorization: `Bearer ${member.token}` },
      method: "PUT",
      payload: { csv: canonicalCsv, editKey: "member-edit-forbidden-001" },
      url:
        `/api/crews/${crewIds.primary}/routes/00000000-0000-4000-8000-000000000001` +
        `/revisions/00000000-0000-4000-8000-000000000002/points`,
    });
    expect(forbiddenEdit.statusCode).toBe(403);
    expect(forbiddenEdit.json()).toEqual({ code: "FORBIDDEN" });
  });

  it("returns row errors and leaves no route after an invalid CSV", async () => {
    const session = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    const authorization = { authorization: `Bearer ${session.token}` };
    const invalid = await server.inject({
      headers: authorization,
      method: "POST",
      payload: {
        csv: canonicalCsv.replace("-0.45120", "-133.45120"),
        importKey: "invalid-import-001",
        routeName: "Ruta inválida",
        sectorName: "Sector Norte",
      },
      url: `/api/crews/${crewIds.primary}/routes/import`,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ errors: { row: number }[] }>().errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 2 })]),
    );

    const routes = await server.inject({
      headers: authorization,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/routes`,
    });
    expect(routes.json()).toEqual([]);
  });

  it("serves isolated revision features and applies idempotent geography changes", async () => {
    const session = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    const authorization = { authorization: `Bearer ${session.token}` };
    const imported = await server.inject({
      headers: authorization,
      method: "POST",
      payload: {
        csv: canonicalCsv,
        importKey: "geography-api-import-001",
        routeName: "Ruta mapa API",
        sectorName: "Sector mapa API",
      },
      url: `/api/crews/${crewIds.primary}/routes/import`,
    });
    const draft = imported.json<{
      revision: { draftVersion: number; id: string };
      route: { id: string };
    }>();
    const featuresUrl =
      `/api/crews/${crewIds.primary}/routes/${draft.route.id}` +
      `/revisions/${draft.revision.id}/features`;
    const initial = await server.inject({
      headers: authorization,
      method: "GET",
      url: featuresUrl,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers.etag).toBe(`W/"${draft.revision.id}-1"`);
    expect(initial.json()).toMatchObject({
      area: null,
      draftVersion: 1,
      pointCount: 2,
      schemaVersion: 1,
      segmentCount: 0,
    });

    const operationId = randomUUID();
    const changeUrl =
      `/api/crews/${crewIds.primary}/routes/${draft.route.id}` +
      `/revisions/${draft.revision.id}/changes`;
    const payload = {
      baseDraftVersion: 1,
      change: {
        geometry: {
          coordinates: [
            [
              [
                [-0.67, -0.45],
                [-0.66, -0.45],
                [-0.66, -0.44],
                [-0.67, -0.45],
              ],
            ],
          ],
          type: "MultiPolygon",
        },
        type: "SET_AREA",
      },
      operationId,
    };
    const changed = await server.inject({
      headers: authorization,
      method: "POST",
      payload,
      url: changeUrl,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ draftVersion: 2, replayed: false });
    const replay = await server.inject({
      headers: authorization,
      method: "POST",
      payload,
      url: changeUrl,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ draftVersion: 2, replayed: true });

    const invalidSide = await server.inject({
      headers: authorization,
      method: "POST",
      payload: {
        baseDraftVersion: 2,
        change: {
          segments: [
            {
              externalId: "manual/api-side",
              geometry: {
                coordinates: [
                  [
                    [-0.669, -0.448],
                    [-0.668, -0.449],
                  ],
                ],
                type: "MultiLineString",
              },
              serviceSide: "NORTH",
              source: "MANUAL",
            },
          ],
          type: "REPLACE_SEGMENTS",
        },
        operationId: randomUUID(),
      },
      url: changeUrl,
    });
    expect(invalidSide.statusCode).toBe(400);
    expect(invalidSide.json()).toEqual({ code: "ROUTE_REVISION_CHANGE_INVALID" });

    const assignedSide = await server.inject({
      headers: authorization,
      method: "POST",
      payload: {
        baseDraftVersion: 2,
        change: {
          segments: [
            {
              externalId: "manual/api-side",
              geometry: {
                coordinates: [
                  [
                    [-0.669, -0.448],
                    [-0.668, -0.449],
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
        operationId: randomUUID(),
      },
      url: changeUrl,
    });
    expect(assignedSide.statusCode).toBe(200);
    expect(assignedSide.json()).toMatchObject({ draftVersion: 3, segmentCount: 1 });
    const featuresWithSide = await server.inject({
      headers: authorization,
      method: "GET",
      url: featuresUrl,
    });
    expect(featuresWithSide.json()).toMatchObject({
      segments: { features: [{ properties: { serviceSide: "LEFT" } }] },
    });

    const osmPreview = await server.inject({
      headers: authorization,
      method: "POST",
      payload: {
        export: {
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
          ],
        },
      },
      url:
        `/api/crews/${crewIds.primary}/routes/${draft.route.id}` +
        `/revisions/${draft.revision.id}/osm-preview`,
    });
    expect(osmPreview.statusCode).toBe(200);
    expect(osmPreview.json()).toMatchObject({
      segments: [{ externalId: "way/44", serviceSide: "BOTH", source: "OSM" }],
      summary: { candidateSegments: 1, sourceElements: 1 },
    });

    const outsider = await login("externo@demo.rutacuadrilla.local", "Outsider-Demo-2026!");
    const crossCrewRead = await server.inject({
      headers: { authorization: `Bearer ${outsider.token}` },
      method: "GET",
      url: featuresUrl,
    });
    expect(crossCrewRead.statusCode).toBe(403);
    expect(crossCrewRead.json()).toEqual({ code: "FORBIDDEN" });
  });

  it("rejects a session whose persisted expiry has elapsed", async () => {
    const session = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    await database.query(
      `UPDATE auth_session
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
       WHERE revoked_at IS NULL`,
    );

    const expired = await server.inject({
      headers: { authorization: `Bearer ${session.token}` },
      method: "GET",
      url: "/api/me",
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ code: "SESSION_REVOKED_OR_EXPIRED" });
  });

  it("limits repeated logins and sends defensive API headers", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalid = await server.inject({
        method: "POST",
        payload: {
          email: "admin@demo.rutacuadrilla.local",
          password: `invalid-${attempt}`,
        },
        url: "/api/auth/login",
      });
      expect(invalid.statusCode).toBe(401);
    }

    const limited = await server.inject({
      method: "POST",
      payload: {
        email: "admin@demo.rutacuadrilla.local",
        password: "Admin-Demo-2026!",
      },
      url: "/api/auth/login",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: "LOGIN_RATE_LIMITED" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers["x-content-type-options"]).toBe("nosniff");
    expect(limited.headers["x-frame-options"]).toBe("DENY");
    expect(limited.headers["referrer-policy"]).toBe("no-referrer");
    expect(limited.headers["permissions-policy"]).toContain("geolocation=()");

    const isolatedAccount = await server.inject({
      method: "POST",
      payload: {
        email: "miembro@demo.rutacuadrilla.local",
        password: "Member-Demo-2026!",
      },
      url: "/api/auth/login",
    });
    expect(isolatedAccount.statusCode).toBe(200);
  });

  it("reserves login capacity before concurrent password checks complete", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        server.inject({
          method: "POST",
          payload: {
            email: "admin@demo.rutacuadrilla.local",
            password: `concurrent-invalid-${index}`,
          },
          url: "/api/auth/login",
        }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(7);
  });
});
