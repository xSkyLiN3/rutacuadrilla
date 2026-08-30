import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CampaignService,
  closeDatabase,
  type DemoSeedResult,
  type DomainDatabase,
  RouteService,
  type ServiceSide,
  SyncService,
} from "../src/index.js";
import { openSeededDatabase } from "./helpers.js";

function routeCsv(prefix: string, sharedExternalId?: string): string {
  const first = sharedExternalId ?? `${prefix}-001`;
  return [
    "external_id,street,number,latitude,longitude,point_type,source",
    `${first},Los Aromos,101,-0.4489,-0.6693,DWELLING,CSV`,
    `${prefix}-002,Los Aromos,103,-0.4490,-0.6694,BUILDING_ENTRANCE,CSV`,
  ].join("\n");
}

async function publishedRoute(
  routeService: RouteService,
  seed: DemoSeedResult,
  input: {
    pointPrefix: string;
    geometryOffset?: number;
    routeName: string;
    segmentExternalId: string;
    serviceSide: ServiceSide;
    sharedPointExternalId?: string;
  },
): Promise<{ revisionId: string; routeId: string }> {
  const imported = await routeService.importRoute({
    actorUserId: seed.userIds.admin,
    crewId: seed.crewIds.primary,
    csv: routeCsv(input.pointPrefix, input.sharedPointExternalId),
    importKey: `campaign-${input.pointPrefix}-${randomUUID()}`,
    routeName: input.routeName,
    sectorName: "Sector multirruta",
  });
  if (!imported.route || !imported.revision) throw new Error("Expected route draft");
  await routeService.applyRevisionChange({
    actorUserId: seed.userIds.admin,
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
          name: "Los Aromos",
          serviceSide: input.serviceSide,
          source: "MANUAL",
        },
      ],
      type: "REPLACE_SEGMENTS",
    },
    crewId: seed.crewIds.primary,
    operationId: randomUUID(),
    revisionId: imported.revision.id,
    routeId: imported.route.id,
  });
  await routeService.publishRevision({
    actorUserId: seed.userIds.admin,
    crewId: seed.crewIds.primary,
    revisionId: imported.revision.id,
    routeId: imported.route.id,
  });
  return { revisionId: imported.revision.id, routeId: imported.route.id };
}

describe.sequential("campaign composition", () => {
  let database: DomainDatabase | undefined;

  afterEach(async () => {
    if (database) {
      await closeDatabase(database);
      database = undefined;
    }
  });

  it("freezes two routes, complementary street sides and one active vehicle per route", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const routeService = new RouteService(database);
    const service = new CampaignService(database);
    const left = await publishedRoute(routeService, seed, {
      pointPrefix: "left",
      routeName: "Ruta camión A",
      segmentExternalId: "shared/street-1",
      serviceSide: "LEFT",
    });
    const right = await publishedRoute(routeService, seed, {
      pointPrefix: "right",
      routeName: "Ruta camión B",
      segmentExternalId: "shared/street-1",
      serviceSide: "RIGHT",
    });
    const both = await publishedRoute(routeService, seed, {
      pointPrefix: "both",
      routeName: "Ruta conflictiva",
      segmentExternalId: "SHARED/STREET-1",
      serviceSide: "BOTH",
    });
    const ambiguous = await publishedRoute(routeService, seed, {
      geometryOffset: 0.0001,
      pointPrefix: "ambiguous",
      routeName: "Ruta con versión ambigua",
      segmentExternalId: "shared/street-1",
      serviceSide: "RIGHT",
    });
    const truckA = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión A",
      registration: "aa-bb-11",
    });
    const truckB = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión B",
    });
    const truckC = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión C",
    });
    expect(truckA.registration).toBe("AA-BB-11");

    const campaign = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      currency: "clp",
      endsOn: "2026-12-31",
      name: "Fiestas 2026",
      startsOn: "2026-11-15",
      timezone: "America/Santiago",
    });
    expect(campaign).toMatchObject({
      currency: "CLP",
      endsOn: "2026-12-31",
      routeCount: 0,
      startsOn: "2026-11-15",
      status: "DRAFT",
    });

    const first = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: left.revisionId,
      vehicleId: truckA.id,
    });
    expect(first).toMatchObject({
      assignment: { pointCount: 2, segmentSideClaimCount: 1, vehicle: { id: truckA.id } },
      created: true,
    });
    const replay = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: left.revisionId,
      vehicleId: truckA.id,
    });
    expect(replay).toMatchObject({ assignment: { id: first.assignment.id }, created: false });

    await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: right.revisionId,
      vehicleId: truckB.id,
    });
    await expect(
      service.assignRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
        routeRevisionId: both.revisionId,
        vehicleId: truckC.id,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_SEGMENT_SIDE_DUPLICATE",
      details: {
        conflictCount: 2,
        matchingRule: "source+normalizedExternalId+physicalSide",
        spatialInferenceUsed: false,
      },
      statusCode: 409,
    });
    await expect(
      service.assignRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
        routeRevisionId: ambiguous.revisionId,
        vehicleId: truckC.id,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_SEGMENT_VERSION_AMBIGUOUS",
      details: {
        conflictCount: 1,
        conflicts: [
          expect.objectContaining({
            existingPhysicalSide: "LEFT",
            externalId: "shared/street-1",
            requestedPhysicalSide: "RIGHT",
          }),
        ],
        spatialInferenceUsed: false,
      },
      statusCode: 409,
    });

    const activated = await service.activateCampaign({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
    });
    expect(activated).toMatchObject({ pointCount: 4, routeCount: 2, status: "ACTIVE" });
    expect(activated.routes.map((assignment) => assignment.vehicle.name)).toEqual([
      "Camión A",
      "Camión B",
    ]);

    const contexts = await new SyncService(database).listContexts({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
    });
    expect(contexts.map((context) => context.id)).toEqual(
      expect.arrayContaining(activated.routes.map((assignment) => assignment.id)),
    );
    expect(contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vehicleId: truckA.id, vehicleName: "Camión A" }),
        expect.objectContaining({ vehicleId: truckB.id, vehicleName: "Camión B" }),
      ]),
    );
    await expect(
      database.query(
        `DELETE FROM campaign_route_segment_side
         WHERE crew_id = $1 AND campaign_id = $2`,
        [seed.crewIds.primary, campaign.id],
      ),
    ).rejects.toThrow(/CAMPAIGN_COMPOSITION_IMMUTABLE/u);
  });

  it("rejects duplicated points, routes and vehicles with safe structured conflicts", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const routeService = new RouteService(database);
    const service = new CampaignService(database);
    const firstRoute = await publishedRoute(routeService, seed, {
      pointPrefix: "first",
      routeName: "Ruta original",
      segmentExternalId: "street/original",
      serviceSide: "LEFT",
      sharedPointExternalId: "shared-home",
    });
    const duplicatePointRoute = await publishedRoute(routeService, seed, {
      pointPrefix: "second",
      routeName: "Ruta punto repetido",
      segmentExternalId: "street/second",
      serviceSide: "RIGHT",
      sharedPointExternalId: "shared-home",
    });
    const independentRoute = await publishedRoute(routeService, seed, {
      pointPrefix: "third",
      routeName: "Ruta independiente",
      segmentExternalId: "street/third",
      serviceSide: "BOTH",
    });
    const truckA = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión 1",
    });
    const truckB = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión 2",
    });
    const campaign = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Composición validada",
    });
    await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: firstRoute.revisionId,
      vehicleId: truckA.id,
    });

    await expect(
      service.assignRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
        routeRevisionId: duplicatePointRoute.revisionId,
        vehicleId: truckB.id,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_POINT_DUPLICATE",
      details: {
        conflictCount: 1,
        conflicts: [expect.objectContaining({ servicePointExternalId: "shared-home" })],
      },
      statusCode: 409,
    });
    await expect(
      service.assignRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
        routeRevisionId: firstRoute.revisionId,
        vehicleId: truckB.id,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_ROUTE_DUPLICATE",
      details: { conflict: { route: { id: firstRoute.routeId, name: "Ruta original" } } },
      statusCode: 409,
    });
    await expect(
      service.assignRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
        routeRevisionId: independentRoute.revisionId,
        vehicleId: truckA.id,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_VEHICLE_DUPLICATE",
      details: { conflict: { vehicle: { id: truckA.id, name: "Camión 1" } } },
      statusCode: 409,
    });
    await expect(
      service.createCampaign({
        actorUserId: seed.userIds.admin,
        crewId: seed.crewIds.primary,
        endsOn: "2026-01-01",
        name: "Fechas inválidas",
        startsOn: "2026-02-01",
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_INVALID_INPUT", statusCode: 400 });
  });

  it("rechecks that every assigned vehicle is still active when activating", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const routeService = new RouteService(database);
    const service = new CampaignService(database);
    const route = await publishedRoute(routeService, seed, {
      pointPrefix: "archived-truck",
      routeName: "Ruta con camión archivado",
      segmentExternalId: "street/archived-truck",
      serviceSide: "BOTH",
    });
    const truck = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión que será archivado",
    });
    const campaign = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Campaña que revalida camiones",
    });
    await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: route.revisionId,
      vehicleId: truck.id,
    });
    await database.query(
      `UPDATE campaign_route SET status = 'CLOSED' WHERE crew_id = $1 AND campaign_id = $2`,
      [seed.crewIds.primary, campaign.id],
    );
    await expect(
      service.activateCampaign({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_ROUTE_NOT_ACTIVE",
      details: { invalidRouteCount: 1 },
      statusCode: 409,
    });
    await database.query(
      `UPDATE campaign_route SET status = 'ACTIVE' WHERE crew_id = $1 AND campaign_id = $2`,
      [seed.crewIds.primary, campaign.id],
    );
    await database.query(`UPDATE vehicle SET status = 'ARCHIVED' WHERE crew_id = $1 AND id = $2`, [
      seed.crewIds.primary,
      truck.id,
    ]);

    await expect(
      service.activateCampaign({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        crewId: seed.crewIds.primary,
      }),
    ).rejects.toMatchObject({
      code: "CAMPAIGN_VEHICLE_REQUIRED",
      details: { invalidVehicleCount: 1 },
      statusCode: 409,
    });
  });

  it("serializes concurrent vehicle creation and returns one safe duplicate conflict", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const service = new CampaignService(database);

    const attempts = await Promise.allSettled([
      service.createVehicle({
        actorUserId: seed.userIds.admin,
        crewId: seed.crewIds.primary,
        name: "Camión simultáneo",
        registration: "SYNC-01",
      }),
      service.createVehicle({
        actorUserId: seed.userIds.admin,
        crewId: seed.crewIds.primary,
        name: "camión simultáneo",
        registration: "sync-01",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "VEHICLE_DUPLICATE",
      statusCode: 409,
    });
  });

  it("enforces campaign identity across points, assignments and side claims", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const routeService = new RouteService(database);
    const service = new CampaignService(database);
    const routeA = await publishedRoute(routeService, seed, {
      pointPrefix: "integrity-a",
      routeName: "Ruta integridad A",
      segmentExternalId: "street/integrity-a",
      serviceSide: "LEFT",
    });
    const routeB = await publishedRoute(routeService, seed, {
      pointPrefix: "integrity-b",
      routeName: "Ruta integridad B",
      segmentExternalId: "street/integrity-b",
      serviceSide: "RIGHT",
    });
    const unassignedRoute = await publishedRoute(routeService, seed, {
      pointPrefix: "integrity-free",
      routeName: "Ruta punto no asignado",
      segmentExternalId: "street/integrity-free",
      serviceSide: "BOTH",
    });
    const vehicleA = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión integridad A",
    });
    const vehicleB = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión integridad B",
    });
    const campaignA = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Campaña integridad A",
    });
    const campaignB = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Campaña integridad B",
    });
    const assignmentA = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaignA.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: routeA.revisionId,
      vehicleId: vehicleA.id,
    });
    const assignmentB = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaignB.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: routeB.revisionId,
      vehicleId: vehicleB.id,
    });
    const freePoint = (
      await database.query<{
        service_point_id: string;
        service_point_version_id: string;
      }>(
        `SELECT service_point_id, service_point_version_id
         FROM route_revision_point
         WHERE crew_id = $1 AND route_revision_id = $2
         ORDER BY display_order LIMIT 1`,
        [seed.crewIds.primary, unassignedRoute.revisionId],
      )
    ).rows[0];
    if (!freePoint) throw new Error("Expected unassigned point");

    await expect(
      database.query(
        `INSERT INTO campaign_point
           (crew_id, id, campaign_id, campaign_route_id, service_point_id,
            service_point_version_id, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, 999)`,
        [
          seed.crewIds.primary,
          randomUUID(),
          campaignA.id,
          assignmentB.assignment.id,
          freePoint.service_point_id,
          freePoint.service_point_version_id,
        ],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await service.activateCampaign({
      actorUserId: seed.userIds.admin,
      campaignId: campaignA.id,
      crewId: seed.crewIds.primary,
    });
    await expect(
      database.query(
        `UPDATE campaign_route_segment_side
         SET campaign_id = $3, campaign_route_id = $4
         WHERE crew_id = $1 AND campaign_id = $2`,
        [seed.crewIds.primary, campaignB.id, campaignA.id, assignmentA.assignment.id],
      ),
    ).rejects.toThrow(/CAMPAIGN_COMPOSITION_IMMUTABLE/u);
  });

  it("removes only draft assignments, audits the deletion and freezes active composition", async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    const { seed } = opened;
    const routeService = new RouteService(database);
    const service = new CampaignService(database);
    const route = await publishedRoute(routeService, seed, {
      pointPrefix: "remove",
      routeName: "Ruta removible",
      segmentExternalId: "street/remove",
      serviceSide: "BOTH",
    });
    const truck = await service.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión removible",
    });
    const campaign = await service.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Borrador removible",
    });
    const first = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: route.revisionId,
      vehicleId: truck.id,
    });
    const emptied = await service.removeRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      campaignRouteId: first.assignment.id,
      crewId: seed.crewIds.primary,
    });
    expect(emptied).toMatchObject({ pointCount: 0, routeCount: 0, routes: [] });
    const removalAudit = await database.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_event
       WHERE crew_id = $1 AND action = 'CAMPAIGN_ROUTE_REMOVED'`,
      [seed.crewIds.primary],
    );
    expect(removalAudit.rows).toHaveLength(1);

    const assigned = await service.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: route.revisionId,
      vehicleId: truck.id,
    });
    await service.activateCampaign({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
    });
    await expect(
      service.removeRoute({
        actorUserId: seed.userIds.admin,
        campaignId: campaign.id,
        campaignRouteId: assigned.assignment.id,
        crewId: seed.crewIds.primary,
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_INVALID_STATE", statusCode: 409 });
  });
});
