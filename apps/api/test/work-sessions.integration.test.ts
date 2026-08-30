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
  sessionSecret: "work-session-test-secret-with-more-than-32-characters",
  sessionTtlMinutes: 60,
  trustProxy: 0,
};

const csv = `external_id,street,number,latitude,longitude,point_type,source
session-001,Los Aromos,120,-0.4512,-0.6621,DWELLING,CSV
session-002,Los Aromos,126,-0.4517,-0.6614,DWELLING,CSV`;

type LoginPayload = {
  memberships: { membershipId: string }[];
  token: string;
};

describe.sequential("work session HTTP contract", () => {
  let context: TechnicalContextPackage;
  let crewIds: { primary: string; secondary: string };
  let database: DomainDatabase;
  let server: FastifyInstance;

  beforeEach(async () => {
    database = await createDatabase();
    await migrateDatabase(database);
    const seed = await seedDemoData(database, {
      adminPassword: "Admin-Demo-2026!",
      memberPassword: "Member-Demo-2026!",
      outsiderPassword: "Outsider-Demo-2026!",
    });
    crewIds = seed.crewIds;
    const routeService = new RouteService(database);
    const syncService = new SyncService(database);
    const imported = await routeService.importRoute({
      actorUserId: seed.userIds.admin,
      crewId: crewIds.primary,
      csv,
      importKey: "work-session-api-import-001",
      routeName: "Ruta API jornadas",
      sectorName: "Sector API jornadas",
    });
    if (!imported.route || !imported.revision) throw new Error("TEST_ROUTE_IMPORT_FAILED");
    await routeService.publishRevision({
      actorUserId: seed.userIds.admin,
      crewId: crewIds.primary,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    context = await syncService.createTechnicalContext({
      actorUserId: seed.userIds.admin,
      crewId: crewIds.primary,
      routeRevisionId: imported.revision.id,
    });
    server = await buildServer({
      campaignService: new CampaignService(database),
      config,
      database,
      routeService,
      syncService,
      workSessionService: new WorkSessionService(database),
    });
  }, 30_000);

  afterEach(async () => {
    if (server) await server.close();
    if (database) await closeDatabase(database);
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

  it("serves current=null then start/get/join/finish with idempotent status codes", async () => {
    const member = await login("miembro@demo.rutacuadrilla.local", "Member-Demo-2026!");
    expect(member.memberships[0]?.membershipId).toMatch(/^[0-9a-f-]{36}$/u);
    const memberHeaders = { authorization: `Bearer ${member.token}` };
    const currentUrl =
      `/api/crews/${crewIds.primary}/campaign-routes/${context.context.id}` +
      "/work-sessions/current";
    const emptyCurrent = await server.inject({
      headers: memberHeaders,
      method: "GET",
      url: currentUrl,
    });
    expect(emptyCurrent.statusCode).toBe(200);
    expect(emptyCurrent.json()).toEqual({ workSession: null });

    const startUrl = `/api/crews/${crewIds.primary}/campaign-routes/${context.context.id}/work-sessions`;
    const deviceId = "40000000-0000-4000-8000-000000000051";
    const operationId = randomUUID();
    const started = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: { deviceId, operationId },
      url: startUrl,
    });
    expect(started.statusCode).toBe(201);
    const startedPayload = started.json<{
      created: boolean;
      replayed: boolean;
      workSession: { id: string; status: string; version: number };
    }>();
    expect(startedPayload).toMatchObject({
      created: true,
      replayed: false,
      workSession: { status: "ACTIVE", version: 1 },
    });
    const startReplay = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: { deviceId, operationId },
      url: startUrl,
    });
    expect(startReplay.statusCode).toBe(200);
    expect(startReplay.json()).toMatchObject({ created: true, replayed: true });

    const current = await server.inject({
      headers: memberHeaders,
      method: "GET",
      url: currentUrl,
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      workSession: { id: startedPayload.workSession.id, status: "ACTIVE" },
    });
    const detailUrl = `/api/crews/${crewIds.primary}/work-sessions/${startedPayload.workSession.id}`;
    const detail = await server.inject({
      headers: memberHeaders,
      method: "GET",
      url: detailUrl,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: startedPayload.workSession.id, status: "ACTIVE" });

    const admin = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
    const adminHeaders = { authorization: `Bearer ${admin.token}` };
    const joinPayload = {
      deviceId: "40000000-0000-4000-8000-000000000052",
      operationId: randomUUID(),
    };
    const joined = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: joinPayload,
      url: `${detailUrl}/join`,
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      deviceJoined: true,
      participantJoined: true,
      replayed: false,
      workSession: { version: 2 },
    });
    const joinReplay = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: joinPayload,
      url: `${detailUrl}/join`,
    });
    expect(joinReplay.statusCode).toBe(200);
    expect(joinReplay.json()).toMatchObject({ replayed: true });

    const versionConflict = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: { expectedVersion: 3, operationId: randomUUID() },
      url: `${detailUrl}/finish`,
    });
    expect(versionConflict.statusCode).toBe(409);
    expect(versionConflict.json()).toMatchObject({
      code: "WORK_SESSION_VERSION_CONFLICT",
      details: { actualVersion: 2, expectedVersion: 3 },
    });

    const finishPayload = { expectedVersion: 2, operationId: randomUUID() };
    const finished = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: finishPayload,
      url: `${detailUrl}/finish`,
    });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({
      replayed: false,
      workSession: { status: "FINISHED", version: 3 },
    });
    const finishReplay = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: finishPayload,
      url: `${detailUrl}/finish`,
    });
    expect(finishReplay.statusCode).toBe(200);
    expect(finishReplay.json()).toMatchObject({
      replayed: true,
      workSession: { status: "FINISHED", version: 3 },
    });
  });

  it("enforces tenant isolation, capabilities, strict bodies and detail 404", async () => {
    const outsider = await login("externo@demo.rutacuadrilla.local", "Outsider-Demo-2026!");
    const outsiderHeaders = { authorization: `Bearer ${outsider.token}` };
    const crossCrewStart = await server.inject({
      headers: outsiderHeaders,
      method: "POST",
      payload: { deviceId: randomUUID(), operationId: randomUUID() },
      url: `/api/crews/${crewIds.primary}/campaign-routes/${context.context.id}/work-sessions`,
    });
    expect(crossCrewStart.statusCode).toBe(403);
    expect(crossCrewStart.json()).toEqual({ code: "FORBIDDEN" });

    const member = await login("miembro@demo.rutacuadrilla.local", "Member-Demo-2026!");
    const memberHeaders = { authorization: `Bearer ${member.token}` };
    await database.query(
      `DELETE FROM membership_capability
       WHERE crew_id = $1
         AND membership_id = $2
         AND capability_code = 'SESSION_START'`,
      [crewIds.primary, member.memberships[0]?.membershipId],
    );
    const forbiddenStart = await server.inject({
      headers: memberHeaders,
      method: "POST",
      payload: { deviceId: randomUUID(), operationId: randomUUID() },
      url: `/api/crews/${crewIds.primary}/campaign-routes/${context.context.id}/work-sessions`,
    });
    expect(forbiddenStart.statusCode).toBe(403);
    expect(forbiddenStart.json()).toEqual({ code: "FORBIDDEN" });

    const invalidBody = await server.inject({
      headers: outsiderHeaders,
      method: "POST",
      payload: { deviceId: randomUUID(), extra: true, operationId: randomUUID() },
      url: `/api/crews/${crewIds.secondary}/campaign-routes/${randomUUID()}/work-sessions`,
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json<{ code: string }>().code).toBe("INVALID_REQUEST");

    const missing = await server.inject({
      headers: outsiderHeaders,
      method: "GET",
      url: `/api/crews/${crewIds.secondary}/work-sessions/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "WORK_SESSION_NOT_FOUND" });
  });
});
