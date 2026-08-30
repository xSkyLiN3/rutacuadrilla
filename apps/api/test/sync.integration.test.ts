import { createHash } from "node:crypto";
import {
  CampaignService,
  closeDatabase,
  createDatabase,
  type DomainDatabase,
  migrateDatabase,
  RouteService,
  SyncService,
  seedDemoData,
  type TechnicalContextPackage,
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
  sessionSecret: "sync-integration-secret-with-more-than-32-characters",
  sessionTtlMinutes: 60,
  trustProxy: 0,
};

const csv = `external_id,street,number,latitude,longitude,point_type,source
sync-001,Los Aromos,120,-0.4512,-0.6621,DWELLING,CSV
sync-002,Los Aromos,126,-0.4517,-0.6614,DWELLING,CSV`;

type LoginPayload = { token: string };

describe.sequential("sync HTTP contract", () => {
  let database: DomainDatabase;
  let server: FastifyInstance;
  let syncService: SyncService;
  let crewIds: { primary: string; secondary: string };
  let userIds: { admin: string; member: string; outsider: string };
  let context: TechnicalContextPackage;
  let routeRevisionId: string;

  beforeEach(async () => {
    database = await createDatabase();
    await migrateDatabase(database);
    const seed = await seedDemoData(database, {
      adminPassword: "Admin-Demo-2026!",
      memberPassword: "Member-Demo-2026!",
      outsiderPassword: "Outsider-Demo-2026!",
    });
    crewIds = seed.crewIds;
    userIds = seed.userIds;
    const routeService = new RouteService(database);
    syncService = new SyncService(database);
    const imported = await routeService.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      csv,
      importKey: "sync-api-import-001",
      routeName: "Ruta API sync",
      sectorName: "Sector API sync",
    });
    if (!imported.route || !imported.revision) throw new Error("TEST_ROUTE_IMPORT_FAILED");
    await routeService.applyRevisionChange({
      actorUserId: seed.userIds.admin,
      baseDraftVersion: 1,
      change: {
        segments: [
          {
            externalId: "manual/api-sync-right",
            geometry: {
              coordinates: [
                [
                  [-0.6621, -0.4512],
                  [-0.6614, -0.4517],
                ],
              ],
              type: "MultiLineString",
            },
            name: "Los Aromos",
            serviceSide: "RIGHT",
            source: "MANUAL",
          },
        ],
        type: "REPLACE_SEGMENTS",
      },
      crewId: seed.crewIds.primary,
      operationId: "50000000-0000-4000-8000-000000000020",
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    await routeService.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    routeRevisionId = imported.revision.id;
    server = await buildServer({
      campaignService: new CampaignService(database),
      config,
      database,
      routeService,
      syncService,
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

  it("serves the package and converges a causal chain after a lost-response replay", async () => {
    const admin = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    const created = await server.inject({
      headers: { authorization: `Bearer ${admin.token}` },
      method: "POST",
      payload: {
        campaignName: "Contexto técnico desde API",
        routeRevisionId,
      },
      url: `/api/crews/${crewIds.primary}/sync/contexts`,
    });
    expect(created.statusCode).toBe(200);
    context = created.json<TechnicalContextPackage>();
    expect(context).toMatchObject({
      contractVersion: "p0-provisional-v3",
      context: { routeRevisionId, segmentCount: 1 },
    });
    expect(context.points).toHaveLength(2);
    expect(context.segments).toMatchObject([
      { externalId: "manual/api-sync-right", serviceSide: "RIGHT" },
    ]);
    expect(context.points[0]).toMatchObject({ displayState: "SIN_VISITAR", version: 0 });

    const replayedCreation = await server.inject({
      headers: { authorization: `Bearer ${admin.token}` },
      method: "POST",
      payload: { routeRevisionId },
      url: `/api/crews/${crewIds.primary}/sync/contexts`,
    });
    expect(replayedCreation.statusCode).toBe(200);
    expect(replayedCreation.json<TechnicalContextPackage>().context.id).toBe(context.context.id);

    const member = await login("miembro@demo.rutacuadrilla.local", "Member-Demo-2026!");
    const headers = { authorization: `Bearer ${member.token}` };
    const contexts = await server.inject({
      headers,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/contexts`,
    });
    expect(contexts.statusCode).toBe(200);
    expect(contexts.json()).toMatchObject({
      contexts: [{ id: context.context.id, pointCount: 2, segmentCount: 1 }],
    });
    const packageResponse = await server.inject({
      headers,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/contexts/${context.context.id}`,
    });
    expect(packageResponse.statusCode).toBe(200);
    expect(packageResponse.headers["content-type"]).toContain(
      "application/vnd.rutacuadrilla.field-context+json",
    );
    expect(packageResponse.headers["content-type"]).toMatch(/version="?3"?/u);
    const downloadedPackage = packageResponse.json<TechnicalContextPackage>();
    expect(downloadedPackage.contractVersion).toBe("p0-provisional-v3");
    expect(downloadedPackage.points).toHaveLength(2);
    expect(downloadedPackage.segments).toMatchObject([
      { externalId: "manual/api-sync-right", serviceSide: "RIGHT" },
    ]);
    expect(downloadedPackage.points[0]).toMatchObject({
      displayState: "SIN_VISITAR",
      version: 0,
    });
    const packageSha256 = createHash("sha256").update(packageResponse.body, "utf8").digest("hex");
    expect(packageResponse.headers["x-package-sha256"]).toBe(packageSha256);
    expect(packageResponse.headers.etag).toBe(`"sha256-${packageSha256}"`);
    expect(packageResponse.headers["content-length"]).toBe(
      String(Buffer.byteLength(packageResponse.body, "utf8")),
    );
    const notModified = await server.inject({
      headers: { ...headers, "if-none-match": `"sha256-${packageSha256}"` },
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/contexts/${context.context.id}`,
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");

    const pointId = context.points[0]?.id;
    if (!pointId) throw new Error("TEST_CONTEXT_EMPTY");
    const deviceId = "40000000-0000-4000-8000-000000000011";
    const sessionResponse = await server.inject({
      headers,
      method: "POST",
      payload: {
        deviceId,
        operationId: "50000000-0000-4000-8000-000000000031",
      },
      url: `/api/crews/${crewIds.primary}/campaign-routes/${context.context.id}/work-sessions`,
    });
    expect(sessionResponse.statusCode).toBe(201);
    const workSessionId = sessionResponse.json<{ workSession: { id: string } }>().workSession.id;
    const commands = [
      {
        baseVersion: 0,
        campaignPointId: pointId,
        deviceId,
        operationId: "50000000-0000-4000-8000-000000000011",
        payload: { state: "VOLVER" },
        type: "POINT_STATUS_CHANGED",
        workSessionId,
      },
      {
        baseVersion: 0,
        campaignPointId: pointId,
        dependsOnOperationId: "50000000-0000-4000-8000-000000000011",
        deviceId,
        operationId: "50000000-0000-4000-8000-000000000012",
        payload: { state: "APORTO" },
        type: "POINT_STATUS_CHANGED",
        workSessionId,
      },
    ];
    const pushed = await server.inject({
      headers,
      method: "POST",
      payload: { commands },
      url: `/api/crews/${crewIds.primary}/sync/commands`,
    });
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json()).toMatchObject({
      results: [
        { replayed: false, state: "VOLVER", status: "APPLIED", version: 1 },
        { replayed: false, state: "APORTO", status: "APPLIED", version: 2 },
      ],
    });

    const replay = await server.inject({
      headers,
      method: "POST",
      payload: { commands },
      url: `/api/crews/${crewIds.primary}/sync/commands`,
    });
    expect(replay.statusCode).toBe(200);
    expect(
      replay.json<{ results: { replayed: boolean }[] }>().results.every((item) => item.replayed),
    ).toBe(true);

    const clientA = await server.inject({
      headers,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/changes?limit=1`,
    });
    expect(clientA.statusCode).toBe(200);
    const pageA = clientA.json<{ changes: unknown[]; cursor: string; hasMore: boolean }>();
    expect(pageA).toMatchObject({ hasMore: true });
    expect(pageA.changes).toHaveLength(1);
    const clientANext = await server.inject({
      headers,
      method: "GET",
      url:
        `/api/crews/${crewIds.primary}/sync/changes?limit=10&after=` +
        encodeURIComponent(pageA.cursor),
    });
    expect(clientANext.statusCode).toBe(200);
    expect(clientANext.json()).toMatchObject({
      changes: [{ state: "APORTO", version: 2 }],
      hasMore: false,
    });

    const clientB = await server.inject({
      headers,
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/changes`,
    });
    expect(clientB.json<{ changes: unknown[] }>().changes).toHaveLength(2);
  });

  it("enforces tenant isolation on context, push, pull and cursor scope", async () => {
    context = await syncService.createTechnicalContext({
      actorUserId: userIds.admin,
      crewId: crewIds.primary,
      routeRevisionId,
    });
    expect(userIds.member).toBeTruthy();
    const admin = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    const outsider = await login("externo@demo.rutacuadrilla.local", "Outsider-Demo-2026!");
    const primaryPull = await server.inject({
      headers: { authorization: `Bearer ${admin.token}` },
      method: "GET",
      url: `/api/crews/${crewIds.primary}/sync/changes`,
    });
    const primaryCursor = primaryPull.json<{ cursor: string }>().cursor;

    for (const request of [
      {
        method: "GET" as const,
        url: `/api/crews/${crewIds.primary}/sync/contexts/${context.context.id}`,
      },
      {
        method: "GET" as const,
        url: `/api/crews/${crewIds.primary}/sync/changes`,
      },
    ]) {
      const response = await server.inject({
        ...request,
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "FORBIDDEN" });
    }

    const forbiddenPush = await server.inject({
      headers: { authorization: `Bearer ${outsider.token}` },
      method: "POST",
      payload: {
        commands: [
          {
            baseVersion: 0,
            campaignPointId: context.points[0]?.id,
            deviceId: "40000000-0000-4000-8000-000000000099",
            operationId: "50000000-0000-4000-8000-000000000099",
            payload: { state: "VOLVER" },
            type: "POINT_STATUS_CHANGED",
            workSessionId: "60000000-0000-4000-8000-000000000099",
          },
        ],
      },
      url: `/api/crews/${crewIds.primary}/sync/commands`,
    });
    expect(forbiddenPush.statusCode).toBe(403);
    expect(forbiddenPush.json()).toEqual({ code: "FORBIDDEN" });

    const forbiddenContextCreation = await server.inject({
      headers: { authorization: `Bearer ${outsider.token}` },
      method: "POST",
      payload: { routeRevisionId },
      url: `/api/crews/${crewIds.primary}/sync/contexts`,
    });
    expect(forbiddenContextCreation.statusCode).toBe(403);
    expect(forbiddenContextCreation.json()).toEqual({ code: "FORBIDDEN" });

    const wrongScope = await server.inject({
      headers: { authorization: `Bearer ${outsider.token}` },
      method: "GET",
      url: `/api/crews/${crewIds.secondary}/sync/changes?after=${encodeURIComponent(primaryCursor)}`,
    });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json()).toEqual({ code: "CURSOR_SCOPE_MISMATCH" });
  });
});
