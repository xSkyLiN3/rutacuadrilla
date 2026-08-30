import { randomUUID } from "node:crypto";
import {
  CampaignService,
  closeDatabase,
  createDatabase,
  type DomainDatabase,
  migrateDatabase,
  RouteService,
  type ServiceSide,
  SyncService,
  seedDemoData,
  WorkSessionService,
} from "@rutacuadrilla/domain";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const config: ApiConfig = {
  appProfile: "simple",
  apiHost: "127.0.0.1",
  apiPort: 4310,
  corsOrigins: ["http://127.0.0.1:4311", "http://127.0.0.1:4312"],
  databaseDir: ".local/test-not-used",
  environment: "test",
  sessionSecret: "simple-integration-secret-with-more-than-32-characters",
  sessionTtlMinutes: 60,
  trustProxy: 0,
};

const pointStates = [
  "SIN_VISITAR",
  "SOBRE_ENTREGADO",
  "VOLVER",
  "SIN_RESPUESTA",
  "APORTO",
  "NO_PARTICIPA",
] as const;

function csv(prefix: string, count: number): string {
  return [
    "external_id,street,number,latitude,longitude,point_type,source",
    ...Array.from({ length: count }, (_, index) =>
      [
        `${prefix}-${index + 1}`,
        `Calle ${prefix}`,
        String(101 + index * 2),
        String(-0.4489 - index * 0.0001),
        String(-0.6693 - index * 0.0001),
        "DWELLING",
        "CSV",
      ].join(","),
    ),
  ].join("\n");
}

describe("simple online application API", () => {
  let database: DomainDatabase;
  let server: FastifyInstance;
  let crewId: string;
  let adminHeaders: { authorization: string };
  let adminUserId: string;

  beforeEach(async () => {
    database = await createDatabase();
    await migrateDatabase(database);
    const seed = await seedDemoData(database, {
      adminPassword: "Admin-Demo-2026!",
      memberPassword: "Member-Demo-2026!",
      outsiderPassword: "Outsider-Demo-2026!",
    });
    crewId = seed.crewIds.primary;
    adminUserId = seed.userIds.admin;
    server = await buildServer({
      campaignService: new CampaignService(database),
      config,
      database,
      routeService: new RouteService(database),
      syncService: new SyncService(database),
      workSessionService: new WorkSessionService(database),
    });
    adminHeaders = await login("admin@demo.rutacuadrilla.local", "Admin-Demo-2026!");
  });

  afterEach(async () => {
    await server.close();
    await closeDatabase(database);
  });

  async function login(email: string, password: string) {
    const response = await server.inject({
      method: "POST",
      payload: { email, password },
      url: "/api/auth/login",
    });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json<{ token: string }>().token}` };
  }

  async function createUser(name: string, email: string) {
    const response = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: { displayName: name, email, password: "Usuario-Seguro-2026!" },
      url: `/api/simple/admin/crews/${crewId}/users`,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>();
  }

  async function importRoute(routeName: string, prefix: string, count: number) {
    const response = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        csv: csv(prefix, count),
        operationId: randomUUID(),
        routeName,
        sectorName: "Sector simple",
      },
      url: `/api/simple/admin/crews/${crewId}/routes/import`,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      route: { id: string; revisions: Array<{ id: string; status: string }> };
    }>();
    expect(body.route.revisions[0]?.status).toBe("PUBLISHED");
    return body.route;
  }

  async function assign(userId: string, routeId: string, expectedStatus = 200) {
    const response = await server.inject({
      headers: adminHeaders,
      method: "PUT",
      payload: { routeId },
      url: `/api/simple/admin/crews/${crewId}/users/${userId}/assignment`,
    });
    expect(response.statusCode).toBe(expectedStatus);
    return response;
  }

  async function publishedSegmentRoute(input: {
    geometryOffset?: number;
    prefix: string;
    routeName: string;
    segmentExternalId: string;
    serviceSide: ServiceSide;
    sharedPoint?: string;
  }) {
    const routeService = new RouteService(database);
    const imported = await routeService.importRoute({
      actorUserId: adminUserId,
      crewId,
      csv: csv(input.sharedPoint ?? input.prefix, 2).replace(
        `${input.sharedPoint ?? input.prefix}-1`,
        input.sharedPoint ?? `${input.prefix}-1`,
      ),
      importKey: `simple-side-${input.prefix}-${randomUUID()}`,
      routeName: input.routeName,
      sectorName: "Sector lados",
    });
    if (!imported.route || !imported.revision) throw new Error("Expected route draft");
    await routeService.applyRevisionChange({
      actorUserId: adminUserId,
      baseDraftVersion: 1,
      change: {
        segments: [
          {
            externalId: input.segmentExternalId,
            geometry: {
              coordinates: [
                [
                  [-0.669, -0.448],
                  [-0.668 + (input.geometryOffset ?? 0), -0.449],
                ],
              ],
              type: "MultiLineString",
            },
            serviceSide: input.serviceSide,
            source: "MANUAL",
          },
        ],
        type: "REPLACE_SEGMENTS",
      },
      crewId,
      operationId: randomUUID(),
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    await routeService.publishRevision({
      actorUserId: adminUserId,
      crewId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    return imported.route.id;
  }

  it("keeps only the simple surface enabled in the default product profile", async () => {
    const simpleOverview = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: `/api/simple/admin/crews/${crewId}/overview`,
    });
    expect(simpleOverview.statusCode).toBe(200);

    const legacyUrls = [
      `/api/crews/${crewId}/routes`,
      `/api/crews/${crewId}/campaigns`,
      `/api/crews/${crewId}/sync/contexts`,
      `/api/crews/${crewId}/campaign-routes/${randomUUID()}/work-sessions/current`,
    ];
    for (const url of legacyUrls) {
      const response = await server.inject({ headers: adminHeaders, method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("publishes optional initial geography and delivers its segments to Campo", async () => {
    const user = await createUser("Persona geográfica", "geo@example.test");
    const fieldHeaders = await login("geo@example.test", "Usuario-Seguro-2026!");
    const operationId = randomUUID();
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
      type: "MultiPolygon",
    };
    const segments = [
      {
        attribution: "Datos sintéticos de prueba.",
        externalId: "synthetic/segment/001",
        geometry: {
          coordinates: [
            [
              [-0.6705, -0.449],
              [-0.6685, -0.449],
            ],
          ],
          type: "MultiLineString",
        },
        name: "Calle sintética",
        serviceSide: "RIGHT",
        source: "GEOJSON",
        sourceVersion: "synthetic-v1",
      },
    ];
    const payload = {
      area,
      csv: csv("geo", 2),
      operationId,
      routeName: "Ruta simple con geografía",
      sectorName: "Sector sintético",
      segments,
    };

    const imported = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload,
      url: `/api/simple/admin/crews/${crewId}/routes/import`,
    });
    expect(imported.statusCode).toBe(201);
    const route = imported.json<{
      route: {
        id: string;
        revisions: Array<{
          area: unknown;
          draftVersion: number;
          segmentCount: number;
          status: string;
        }>;
      };
    }>().route;
    expect(route.revisions[0]).toMatchObject({
      area,
      draftVersion: 3,
      segmentCount: 1,
      status: "PUBLISHED",
    });

    const replay = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload,
      url: `/api/simple/admin/crews/${crewId}/routes/import`,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ route: { id: string } }>().route.id).toBe(route.id);

    const changedGeography = await server.inject({
      headers: adminHeaders,
      method: "POST",
      payload: {
        ...payload,
        segments: [{ ...segments[0], serviceSide: "LEFT" }],
      },
      url: `/api/simple/admin/crews/${crewId}/routes/import`,
    });
    expect(changedGeography.statusCode).toBe(409);
    expect(changedGeography.json()).toEqual({ code: "IDEMPOTENCY_KEY_REUSE" });

    await assign(user.id, route.id);
    const field = await server.inject({
      headers: fieldHeaders,
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(field.statusCode).toBe(200);
    expect(
      field.json<{
        assignment: {
          points: unknown[];
          segments: Array<{
            attribution?: string;
            displayOrder: number;
            externalId: string;
            geometry: unknown;
            name?: string;
            serviceSide: string;
            source: string;
            sourceVersion?: string;
          }>;
        };
      }>().assignment,
    ).toMatchObject({
      points: [{ externalId: "geo-1" }, { externalId: "geo-2" }],
      segments: [
        {
          ...segments[0],
          displayOrder: 0,
        },
      ],
    });
  });

  it("runs users, assignments, six states, progress, isolation and conflicts end to end", async () => {
    const userA = await createUser("Persona A", "persona-a@example.test");
    const userB = await createUser("Persona B", "persona-b@example.test");
    const headersA = await login("persona-a@example.test", "Usuario-Seguro-2026!");
    const headersB = await login("persona-b@example.test", "Usuario-Seguro-2026!");

    const beforeAssignment = await server.inject({
      headers: headersA,
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(beforeAssignment.statusCode).toBe(200);
    expect(beforeAssignment.json()).toEqual({ assignment: null });

    const routeA = await importRoute("A Ruta", "ruta-a", 6);
    const routeB = await importRoute("Z Ruta", "ruta-b", 2);
    await assign(userA.id, routeA.id);
    await assign(userB.id, routeB.id);

    const fieldA = await server.inject({
      headers: headersA,
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(fieldA.statusCode).toBe(200);
    const assignmentA = fieldA.json<{
      assignment: {
        points: Array<{ id: string; state: string; version: number }>;
        progress: { states: Record<string, number>; total: number; visited: number };
        route: { id: string };
      };
    }>().assignment;
    expect(assignmentA.route.id).toBe(routeA.id);
    expect(assignmentA.points).toHaveLength(6);
    expect(assignmentA.points.every((point) => point.state === "SIN_VISITAR")).toBe(true);
    const initialAssignmentEtag = fieldA.headers.etag;
    if (typeof initialAssignmentEtag !== "string") throw new Error("Expected assignment ETag");
    expect(initialAssignmentEtag).toMatch(/^"sha256-[a-f0-9]{64}"$/u);
    expect(fieldA.headers["cache-control"]).toBe("private, no-store");

    const unchangedAssignment = await server.inject({
      headers: { ...headersA, "if-none-match": initialAssignmentEtag },
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(unchangedAssignment.statusCode).toBe(304);
    expect(unchangedAssignment.body).toBe("");
    expect(unchangedAssignment.headers.etag).toBe(initialAssignmentEtag);

    const operations: string[] = [];
    for (const [index, state] of pointStates.entries()) {
      const point = assignmentA.points[index];
      if (!point) throw new Error("Expected field point");
      const operationId = randomUUID();
      operations.push(operationId);
      const changed = await server.inject({
        headers: headersA,
        method: "PUT",
        payload: { expectedVersion: 0, operationId, state },
        url: `/api/simple/field/assignment/points/${point.id}`,
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({
        point: { id: point.id, state, version: 1 },
        replayed: false,
      });
    }

    const afterChanges = await server.inject({
      headers: { ...headersA, "if-none-match": initialAssignmentEtag },
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(afterChanges.statusCode).toBe(200);
    expect(afterChanges.headers.etag).not.toBe(initialAssignmentEtag);
    const progress = afterChanges.json<{
      assignment: { progress: { states: Record<string, number>; total: number; visited: number } };
    }>().assignment.progress;
    expect(progress).toMatchObject({ total: 6, visited: 5 });
    expect(progress.states).toEqual(Object.fromEntries(pointStates.map((state) => [state, 1])));

    const firstPoint = assignmentA.points[0];
    const secondPoint = assignmentA.points[1];
    if (!firstPoint || !secondPoint || !operations[0])
      throw new Error("Expected points and operation");
    const replay = await server.inject({
      headers: headersA,
      method: "PUT",
      payload: { expectedVersion: 0, operationId: operations[0], state: "SIN_VISITAR" },
      url: `/api/simple/field/assignment/points/${firstPoint.id}`,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, point: { version: 1 } });

    const reusedOperation = await server.inject({
      headers: headersA,
      method: "PUT",
      payload: { expectedVersion: 0, operationId: operations[0], state: "SIN_VISITAR" },
      url: `/api/simple/field/assignment/points/${secondPoint.id}`,
    });
    expect(reusedOperation.statusCode).toBe(409);
    expect(reusedOperation.json()).toEqual({ code: "IDEMPOTENCY_KEY_REUSE" });

    const stale = await server.inject({
      headers: headersA,
      method: "PUT",
      payload: { expectedVersion: 0, operationId: randomUUID(), state: "APORTO" },
      url: `/api/simple/field/assignment/points/${firstPoint.id}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "POINT_VERSION_CONFLICT",
      details: { state: "SIN_VISITAR", version: 1 },
    });

    const fieldB = await server.inject({
      headers: headersB,
      method: "GET",
      url: "/api/simple/field/assignment",
    });
    expect(fieldB.statusCode).toBe(200);
    expect(fieldB.json<{ assignment: { route: { id: string } } }>().assignment.route.id).toBe(
      routeB.id,
    );

    const crossRouteWrite = await server.inject({
      headers: headersB,
      method: "PUT",
      payload: { expectedVersion: 1, operationId: randomUUID(), state: "APORTO" },
      url: `/api/simple/field/assignment/points/${firstPoint.id}`,
    });
    expect(crossRouteWrite.statusCode).toBe(404);
    expect(crossRouteWrite.json()).toEqual({ code: "ASSIGNMENT_POINT_NOT_FOUND" });

    const occupied = await assign(userB.id, routeA.id, 409);
    expect(occupied.json()).toEqual({ code: "ROUTE_ALREADY_ASSIGNED" });

    const forbiddenOverview = await server.inject({
      headers: headersA,
      method: "GET",
      url: `/api/simple/admin/crews/${crewId}/overview`,
    });
    expect(forbiddenOverview.statusCode).toBe(403);

    const overview = await server.inject({
      headers: adminHeaders,
      method: "GET",
      url: `/api/simple/admin/crews/${crewId}/overview`,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ progress: unknown[] }>().progress).toHaveLength(2);

    const events = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM simple_route_point_event",
    );
    expect(Number(events.rows[0]?.count)).toBe(6);
  });

  it("allows opposite street sides and rejects repeated houses, sides or geometry versions", async () => {
    const leftUser = await createUser("Lado izquierdo", "lado-izquierdo@example.test");
    const rightUser = await createUser("Lado derecho", "lado-derecho@example.test");
    const candidateUser = await createUser("Ruta candidata", "ruta-candidata@example.test");

    const leftRoute = await publishedSegmentRoute({
      prefix: "left",
      routeName: "Ruta lado izquierdo",
      segmentExternalId: "calle-compartida",
      serviceSide: "LEFT",
      sharedPoint: "vivienda-compartida",
    });
    const rightRoute = await publishedSegmentRoute({
      prefix: "right",
      routeName: "Ruta lado derecho",
      segmentExternalId: "calle-compartida",
      serviceSide: "RIGHT",
    });
    await assign(leftUser.id, leftRoute);
    await assign(rightUser.id, rightRoute);

    const repeatedSideRoute = await publishedSegmentRoute({
      prefix: "repeat-side",
      routeName: "Ruta lado repetido",
      segmentExternalId: "calle-compartida",
      serviceSide: "LEFT",
    });
    const repeatedSide = await assign(candidateUser.id, repeatedSideRoute, 409);
    expect(repeatedSide.json()).toMatchObject({ code: "ROUTE_SEGMENT_SIDE_OVERLAP" });

    const bothSidesRoute = await publishedSegmentRoute({
      prefix: "both",
      routeName: "Ruta ambos lados",
      segmentExternalId: "calle-compartida",
      serviceSide: "BOTH",
    });
    const bothSides = await assign(candidateUser.id, bothSidesRoute, 409);
    expect(bothSides.json()).toMatchObject({ code: "ROUTE_SEGMENT_SIDE_OVERLAP" });

    const ambiguousRoute = await publishedSegmentRoute({
      geometryOffset: 0.0002,
      prefix: "ambiguous",
      routeName: "Ruta versión distinta",
      segmentExternalId: "calle-compartida",
      serviceSide: "RIGHT",
    });
    const ambiguous = await assign(candidateUser.id, ambiguousRoute, 409);
    expect(ambiguous.json()).toMatchObject({ code: "ROUTE_SEGMENT_VERSION_AMBIGUOUS" });

    const duplicatePointRoute = await publishedSegmentRoute({
      prefix: "duplicate-home",
      routeName: "Ruta vivienda repetida",
      segmentExternalId: "otra-calle",
      serviceSide: "BOTH",
      sharedPoint: "vivienda-compartida",
    });
    const duplicatePoint = await assign(candidateUser.id, duplicatePointRoute, 409);
    expect(duplicatePoint.json()).toMatchObject({ code: "ROUTE_POINT_OVERLAP" });
  });
});
