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
  appProfile: "full",
  apiHost: "127.0.0.1",
  apiPort: 4310,
  corsOrigins: ["http://127.0.0.1:4311", "http://127.0.0.1:4312"],
  databaseDir: ".local/test-not-used",
  environment: "test",
  sessionSecret: "campaign-integration-secret-with-more-than-32-characters",
  sessionTtlMinutes: 60,
  trustProxy: 0,
};

function csv(prefix: string, sharedPoint?: string): string {
  return [
    "external_id,street,number,latitude,longitude,point_type,source",
    `${sharedPoint ?? `${prefix}-1`},Los Aromos,101,-0.4489,-0.6693,DWELLING,CSV`,
    `${prefix}-2,Los Aromos,103,-0.4490,-0.6694,DWELLING,CSV`,
  ].join("\n");
}

describe("campaign HTTP API", () => {
  let database: DomainDatabase;
  let server: FastifyInstance;
  let crewId: string;
  let userId: string;

  beforeEach(async () => {
    database = await createDatabase();
    await migrateDatabase(database);
    const seed = await seedDemoData(database, {
      adminPassword: "Admin-Demo-2026!",
      memberPassword: "Member-Demo-2026!",
      outsiderPassword: "Outsider-Demo-2026!",
    });
    crewId = seed.crewIds.primary;
    userId = seed.userIds.admin;
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
    if (server) await server.close();
    if (database) await closeDatabase(database);
  });

  async function authorization(): Promise<{ authorization: string }> {
    const login = await server.inject({
      method: "POST",
      payload: { email: "admin@demo.rutacuadrilla.local", password: "Admin-Demo-2026!" },
      url: "/api/auth/login",
    });
    expect(login.statusCode).toBe(200);
    return { authorization: `Bearer ${login.json<{ token: string }>().token}` };
  }

  async function publishedRoute(input: {
    geometryOffset?: number;
    prefix: string;
    routeName: string;
    segmentExternalId: string;
    serviceSide: ServiceSide;
    sharedPoint?: string;
  }): Promise<{ revisionId: string; routeId: string }> {
    const routeService = new RouteService(database);
    const imported = await routeService.importRoute({
      actorUserId: userId,
      crewId,
      csv: csv(input.prefix, input.sharedPoint),
      importKey: `api-campaign-${input.prefix}-${randomUUID()}`,
      routeName: input.routeName,
      sectorName: "Sector API multirruta",
    });
    if (!imported.route || !imported.revision) throw new Error("Expected route draft");
    await routeService.applyRevisionChange({
      actorUserId: userId,
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
      actorUserId: userId,
      crewId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    return { revisionId: imported.revision.id, routeId: imported.route.id };
  }

  it("manages a draft composition, exposes safe 409 details and allows DELETE through CORS", async () => {
    const headers = await authorization();
    const preflight = await server.inject({
      headers: {
        origin: "http://127.0.0.1:4311",
        "access-control-request-method": "DELETE",
      },
      method: "OPTIONS",
      url: `/api/crews/${crewId}/campaigns/${randomUUID()}/routes/${randomUUID()}`,
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("DELETE");

    const vehicleAResponse = await server.inject({
      headers,
      method: "POST",
      payload: { name: "Camión API A", registration: "api-a-1" },
      url: `/api/crews/${crewId}/vehicles`,
    });
    const vehicleBResponse = await server.inject({
      headers,
      method: "POST",
      payload: { name: "Camión API B" },
      url: `/api/crews/${crewId}/vehicles`,
    });
    expect(vehicleAResponse.statusCode).toBe(201);
    expect(vehicleBResponse.statusCode).toBe(201);
    const vehicleA = vehicleAResponse.json<{ id: string }>();
    const vehicleB = vehicleBResponse.json<{ id: string }>();

    const campaignResponse = await server.inject({
      headers,
      method: "POST",
      payload: {
        currency: "clp",
        endsOn: "2026-12-31",
        name: "Campaña API 2026",
        startsOn: "2026-11-01",
        timezone: "America/Santiago",
      },
      url: `/api/crews/${crewId}/campaigns`,
    });
    expect(campaignResponse.statusCode).toBe(201);
    const campaign = campaignResponse.json<{ id: string }>();

    const original = await publishedRoute({
      prefix: "original",
      routeName: "Ruta API original",
      segmentExternalId: "api/shared-street",
      serviceSide: "LEFT",
      sharedPoint: "api/shared-home",
    });
    const independent = await publishedRoute({
      prefix: "independent",
      routeName: "Ruta API independiente",
      segmentExternalId: "api/independent-street",
      serviceSide: "RIGHT",
    });
    const duplicatePoint = await publishedRoute({
      prefix: "duplicate-point",
      routeName: "Ruta API punto duplicado",
      segmentExternalId: "api/other-street",
      serviceSide: "RIGHT",
      sharedPoint: "api/shared-home",
    });
    const duplicateSide = await publishedRoute({
      prefix: "duplicate-side",
      routeName: "Ruta API lado duplicado",
      segmentExternalId: "API/SHARED-STREET",
      serviceSide: "BOTH",
    });
    const ambiguousSide = await publishedRoute({
      geometryOffset: 0.0001,
      prefix: "ambiguous-side",
      routeName: "Ruta API versión ambigua",
      segmentExternalId: "api/shared-street",
      serviceSide: "RIGHT",
    });

    const assignmentUrl = `/api/crews/${crewId}/campaigns/${campaign.id}/routes`;
    const assigned = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: original.revisionId, vehicleId: vehicleA.id },
      url: assignmentUrl,
    });
    expect(assigned.statusCode).toBe(201);
    const assignedPayload = assigned.json<{
      assignment: { id: string; vehicle: { name: string } };
      created: boolean;
    }>();
    expect(assignedPayload).toMatchObject({
      assignment: { vehicle: { name: "Camión API A" } },
      created: true,
    });
    const replay = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: original.revisionId, vehicleId: vehicleA.id },
      url: assignmentUrl,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ created: false });

    const routeConflict = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: original.revisionId, vehicleId: vehicleB.id },
      url: assignmentUrl,
    });
    expect(routeConflict.statusCode).toBe(409);
    expect(routeConflict.json()).toMatchObject({
      code: "CAMPAIGN_ROUTE_DUPLICATE",
      details: { conflict: { route: { id: original.routeId, name: "Ruta API original" } } },
    });

    const vehicleConflict = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: independent.revisionId, vehicleId: vehicleA.id },
      url: assignmentUrl,
    });
    expect(vehicleConflict.statusCode).toBe(409);
    expect(vehicleConflict.json()).toMatchObject({
      code: "CAMPAIGN_VEHICLE_DUPLICATE",
      details: { conflict: { vehicle: { id: vehicleA.id, name: "Camión API A" } } },
    });

    const pointConflict = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: duplicatePoint.revisionId, vehicleId: vehicleB.id },
      url: assignmentUrl,
    });
    expect(pointConflict.statusCode).toBe(409);
    expect(pointConflict.json()).toMatchObject({
      code: "CAMPAIGN_POINT_DUPLICATE",
      details: {
        conflictCount: 1,
        conflicts: [{ servicePointExternalId: "api/shared-home" }],
      },
    });

    const sideConflict = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: duplicateSide.revisionId, vehicleId: vehicleB.id },
      url: assignmentUrl,
    });
    expect(sideConflict.statusCode).toBe(409);
    expect(sideConflict.json()).toMatchObject({
      code: "CAMPAIGN_SEGMENT_SIDE_DUPLICATE",
      details: {
        conflictCount: 1,
        conflicts: [{ externalId: "api/shared-street", physicalSide: "LEFT" }],
        spatialInferenceUsed: false,
      },
    });

    const versionConflict = await server.inject({
      headers,
      method: "POST",
      payload: { routeRevisionId: ambiguousSide.revisionId, vehicleId: vehicleB.id },
      url: assignmentUrl,
    });
    expect(versionConflict.statusCode).toBe(409);
    expect(versionConflict.json()).toMatchObject({
      code: "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS",
      details: {
        conflictCount: 1,
        conflicts: [
          {
            existingPhysicalSide: "LEFT",
            externalId: "api/shared-street",
            requestedPhysicalSide: "RIGHT",
          },
        ],
        spatialInferenceUsed: false,
      },
    });

    const removed = await server.inject({
      headers,
      method: "DELETE",
      url: `${assignmentUrl}/${assignedPayload.assignment.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ pointCount: 0, routeCount: 0, routes: [] });
  });
});
