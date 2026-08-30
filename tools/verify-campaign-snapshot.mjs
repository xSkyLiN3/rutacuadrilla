import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  CampaignService,
  closeDatabase,
  createDatabase,
  migrateDatabase,
  RouteService,
  SyncService,
  seedDemoData,
  WorkSessionService,
} from "@rutacuadrilla/domain";
import { createSnapshot, restoreSnapshot } from "./database-snapshot.mjs";

async function createPublishedRoute(routeService, seed, input) {
  const csv = [
    "external_id,street,number,latitude,longitude,point_type,source",
    `${input.prefix}-001,Los Aromos,101,-0.4489,-0.6693,DWELLING,CSV`,
    `${input.prefix}-002,Los Aromos,103,-0.4490,-0.6694,BUILDING_ENTRANCE,CSV`,
  ].join("\n");
  const imported = await routeService.importRoute({
    actorUserId: seed.userIds.admin,
    crewId: seed.crewIds.primary,
    csv,
    importKey: `snapshot-${input.prefix}-${randomUUID()}`,
    routeName: input.name,
    sectorName: "Sector snapshot representativo",
  });
  if (!imported.route || !imported.revision)
    throw new Error("SNAPSHOT_FIXTURE_ROUTE_IMPORT_FAILED");
  await routeService.applyRevisionChange({
    actorUserId: seed.userIds.admin,
    baseDraftVersion: 1,
    change: {
      segments: [
        {
          externalId: "snapshot/shared-street",
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
  return imported.revision.id;
}

async function buildRepresentativeDatabase(databaseDir) {
  const database = await createDatabase({ dataDir: databaseDir });
  try {
    await migrateDatabase(database);
    const password =
      process.env.RUTACUADRILLA_FIXTURE_PASSWORD ??
      `Fixture-${randomBytes(18).toString("base64url")}!`;
    const seed = await seedDemoData(database, {
      adminPassword: password,
      memberPassword: password,
      outsiderPassword: password,
    });
    const routeService = new RouteService(database);
    const campaignService = new CampaignService(database);
    const leftRevisionId = await createPublishedRoute(routeService, seed, {
      name: "Ruta snapshot izquierda",
      prefix: "snapshot-left",
      serviceSide: "LEFT",
    });
    const rightRevisionId = await createPublishedRoute(routeService, seed, {
      name: "Ruta snapshot derecha",
      prefix: "snapshot-right",
      serviceSide: "RIGHT",
    });
    const vehicleA = await campaignService.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión snapshot A",
    });
    const vehicleB = await campaignService.createVehicle({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Camión snapshot B",
    });
    const campaign = await campaignService.createCampaign({
      actorUserId: seed.userIds.admin,
      crewId: seed.crewIds.primary,
      name: "Campaña snapshot multirruta",
    });
    const leftAssignment = await campaignService.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: leftRevisionId,
      vehicleId: vehicleA.id,
    });
    await campaignService.assignRoute({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
      routeRevisionId: rightRevisionId,
      vehicleId: vehicleB.id,
    });
    await campaignService.activateCampaign({
      actorUserId: seed.userIds.admin,
      campaignId: campaign.id,
      crewId: seed.crewIds.primary,
    });
    const deviceId = randomUUID();
    const workSession = await new WorkSessionService(database).start({
      actorUserId: seed.userIds.admin,
      campaignRouteId: leftAssignment.assignment.id,
      crewId: seed.crewIds.primary,
      deviceId,
      operationId: randomUUID(),
    });
    const campaignPoint = (
      await database.query(
        `SELECT id FROM campaign_point
         WHERE crew_id = $1 AND campaign_id = $2 AND campaign_route_id = $3
         ORDER BY display_order, id
         LIMIT 1`,
        [seed.crewIds.primary, campaign.id, leftAssignment.assignment.id],
      )
    ).rows[0];
    if (!campaignPoint) throw new Error("SNAPSHOT_FIXTURE_CAMPAIGN_POINT_MISSING");
    await new SyncService(database).pushCommands({
      actorUserId: seed.userIds.admin,
      commands: [
        {
          baseVersion: 0,
          campaignPointId: campaignPoint.id,
          deviceId,
          operationId: randomUUID(),
          payload: { state: "VOLVER" },
          type: "POINT_STATUS_CHANGED",
          workSessionId: workSession.workSession.id,
        },
      ],
      crewId: seed.crewIds.primary,
    });
  } finally {
    await closeDatabase(database);
  }
}

async function verifyRestoredCampaign(targetDir) {
  const database = new PGlite(targetDir);
  await database.waitReady;
  try {
    const result = await database.query(`
      SELECT
        (SELECT count(*)::int FROM schema_migration) AS migrations,
        (SELECT count(*)::int FROM campaign WHERE status = 'ACTIVE' AND technical_fixture = false) AS active_campaigns,
        (SELECT count(*)::int FROM campaign_route) AS campaign_routes,
        (SELECT count(*)::int FROM vehicle WHERE status = 'ACTIVE') AS active_vehicles,
        (SELECT count(*)::int FROM campaign_route_segment_side) AS side_claims,
        (SELECT count(*)::int FROM audit_event) AS audit_events,
        (SELECT count(*)::int FROM point_event) AS point_events,
        (SELECT count(*)::int FROM sync_operation_receipt) AS sync_receipts,
        (SELECT count(*)::int FROM sync_change) AS sync_changes,
        (SELECT count(*)::int FROM work_session WHERE status = 'ACTIVE') AS active_work_sessions,
        (SELECT count(*)::int FROM session_participant) AS session_participants,
        (SELECT count(*)::int FROM session_device) AS session_devices,
        (SELECT count(*)::int FROM work_session_operation_receipt) AS work_session_receipts,
        (SELECT count(*)::int FROM point_event WHERE work_session_id IS NOT NULL) AS session_point_events,
        (SELECT count(*)::int FROM sync_operation_receipt
          WHERE work_session_id IS NOT NULL AND actor_membership_id IS NOT NULL) AS session_sync_receipts,
        (SELECT count(*)::int FROM campaign_point
          WHERE display_state = 'VOLVER' AND version = 1) AS changed_points
    `);
    const counts = result.rows[0];
    if (
      !counts ||
      counts.migrations < 9 ||
      counts.active_campaigns !== 1 ||
      counts.campaign_routes !== 2 ||
      counts.active_vehicles !== 2 ||
      counts.side_claims !== 2 ||
      counts.audit_events < 9 ||
      counts.point_events !== 1 ||
      counts.sync_receipts !== 1 ||
      counts.sync_changes !== 1 ||
      counts.active_work_sessions !== 1 ||
      counts.session_participants !== 1 ||
      counts.session_devices !== 1 ||
      counts.work_session_receipts !== 1 ||
      counts.session_point_events !== 1 ||
      counts.session_sync_receipts !== 1 ||
      counts.changed_points !== 1
    ) {
      throw new Error(`SNAPSHOT_REPRESENTATIVE_INVARIANTS_FAILED:${JSON.stringify(counts)}`);
    }
    return counts;
  } finally {
    await database.close();
  }
}

const verificationDir = await mkdtemp(join(tmpdir(), "rutacuadrilla-snapshot-verification-"));
const databaseDir = join(verificationDir, "source-db");
const archivePath = join(verificationDir, "campaign.snapshot.gz");
const restoredDir = join(verificationDir, "restored-db");
await buildRepresentativeDatabase(databaseDir);
const snapshot = await createSnapshot({ archivePath, databaseDir });
await restoreSnapshot({ archivePath, targetDir: restoredDir });
const counts = await verifyRestoredCampaign(restoredDir);
process.stdout.write(
  `${JSON.stringify({
    archiveSha256: snapshot.manifest.archiveSha256,
    counts,
    status: "REPRESENTATIVE_CAMPAIGN_SNAPSHOT_VERIFIED",
    verificationDir,
  })}\n`,
);
