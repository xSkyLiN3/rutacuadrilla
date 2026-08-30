import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CampaignService,
  closeDatabase,
  type DomainDatabase,
  RouteService,
  type SyncCommand,
  SyncService,
  type TechnicalContextPackage,
  WorkSessionService,
} from "../src/index.js";
import { openSeededDatabase, validCsv } from "./helpers.js";

const deviceId = "40000000-0000-4000-8000-000000000001";
const operationIds = {
  aportar: "50000000-0000-4000-8000-000000000002",
  undo: "50000000-0000-4000-8000-000000000003",
  volver: "50000000-0000-4000-8000-000000000001",
} as const;

describe.sequential("integrated causal sync", () => {
  let database: DomainDatabase;
  let routeService: RouteService;
  let syncService: SyncService;
  let actorUserId: string;
  let crewId: string;
  let outsiderUserId: string;
  let secondaryCrewId: string;
  let context: TechnicalContextPackage;
  let workSessionId: string;

  beforeEach(async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    actorUserId = opened.seed.userIds.admin;
    outsiderUserId = opened.seed.userIds.outsider;
    crewId = opened.seed.crewIds.primary;
    secondaryCrewId = opened.seed.crewIds.secondary;
    routeService = new RouteService(database);
    syncService = new SyncService(database);

    const imported = await routeService.importRoute({
      actorUserId,
      crewId,
      csv: validCsv,
      importKey: "sync-context-import-001",
      routeName: "Ruta sync sintética",
      sectorName: "Sector sync sintético",
    });
    if (!imported.route || !imported.revision) throw new Error("TEST_ROUTE_IMPORT_FAILED");
    await routeService.applyRevisionChange({
      actorUserId,
      baseDraftVersion: 1,
      change: {
        segments: [
          {
            externalId: "manual/sync-left",
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
            serviceSide: "LEFT",
            source: "MANUAL",
          },
        ],
        type: "REPLACE_SEGMENTS",
      },
      crewId,
      operationId: "50000000-0000-4000-8000-000000000010",
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    await routeService.publishRevision({
      actorUserId,
      crewId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    context = await syncService.createTechnicalContext({
      actorUserId,
      campaignName: "Contexto de sincronización",
      crewId,
      routeRevisionId: imported.revision.id,
    });
    const started = await new WorkSessionService(database).start({
      actorUserId,
      campaignRouteId: context.context.id,
      crewId,
      deviceId,
      operationId: "50000000-0000-4000-8000-000000000030",
    });
    workSessionId = started.workSession.id;
  });

  afterEach(async () => {
    await closeDatabase(database);
  });

  function causalCommands(): SyncCommand[] {
    const campaignPointId = context.points[0]?.id;
    if (!campaignPointId) throw new Error("TEST_CONTEXT_EMPTY");
    return [
      {
        baseVersion: 0,
        campaignPointId,
        deviceId,
        operationId: operationIds.volver,
        payload: { state: "VOLVER" },
        type: "POINT_STATUS_CHANGED",
        workSessionId,
      },
      {
        baseVersion: 0,
        campaignPointId,
        dependsOnOperationId: operationIds.volver,
        deviceId,
        operationId: operationIds.aportar,
        payload: { state: "APORTO" },
        type: "POINT_STATUS_CHANGED",
        workSessionId,
      },
      {
        baseVersion: 0,
        campaignPointId,
        dependsOnOperationId: operationIds.aportar,
        deviceId,
        operationId: operationIds.undo,
        payload: { revertsOperationId: operationIds.aportar },
        type: "POINT_STATUS_REVERTED",
        workSessionId,
      },
    ];
  }

  it("materializes an immutable published revision into an isolated technical package", async () => {
    expect(context.contractVersion).toBe("p0-provisional-v3");
    expect(context.points).toHaveLength(2);
    expect(context.context.segmentCount).toBe(1);
    expect(context.segments).toMatchObject([
      { externalId: "manual/sync-left", serviceSide: "LEFT" },
    ]);
    expect(context.points.every((point) => point.displayState === "SIN_VISITAR")).toBe(true);
    expect(context.context.contentHash).toMatch(/^[0-9a-f]{64}$/u);

    const replay = await syncService.createTechnicalContext({
      actorUserId,
      crewId,
      routeRevisionId: context.context.routeRevisionId,
    });
    expect(replay.context.id).toBe(context.context.id);

    const published = await database.query<{ status: string }>(
      "SELECT status FROM route_revision WHERE crew_id = $1 AND id = $2",
      [crewId, context.context.routeRevisionId],
    );
    expect(published.rows[0]?.status).toBe("PUBLISHED");
  });

  it("rejects commands for draft or closed campaigns without writing sync artifacts", async () => {
    const campaigns = new CampaignService(database);
    const vehicle = await campaigns.createVehicle({
      actorUserId,
      crewId,
      name: "Camión campaña no activa",
    });
    const campaign = await campaigns.createCampaign({
      actorUserId,
      crewId,
      name: "Campaña todavía borrador",
    });
    const assignment = await campaigns.assignRoute({
      actorUserId,
      campaignId: campaign.id,
      crewId,
      routeRevisionId: context.context.routeRevisionId,
      vehicleId: vehicle.id,
    });
    const point = (
      await database.query<{ id: string }>(
        `SELECT id FROM campaign_point
         WHERE crew_id = $1 AND campaign_route_id = $2
         ORDER BY display_order LIMIT 1`,
        [crewId, assignment.assignment.id],
      )
    ).rows[0];
    if (!point) throw new Error("TEST_CAMPAIGN_POINT_EMPTY");
    const draftOperationId = "50000000-0000-4000-8000-000000000020";
    const closedOperationId = "50000000-0000-4000-8000-000000000021";
    const command = (operationId: string): SyncCommand => ({
      baseVersion: 0,
      campaignPointId: point.id,
      deviceId,
      operationId,
      payload: { state: "VOLVER" },
      type: "POINT_STATUS_CHANGED",
      workSessionId,
    });

    await expect(
      syncService.pushCommands({
        actorUserId,
        commands: [command(draftOperationId)],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", statusCode: 409 });
    const cycleA = "50000000-0000-4000-8000-000000000023";
    const cycleB = "50000000-0000-4000-8000-000000000024";
    await expect(
      syncService.pushCommands({
        actorUserId,
        commands: [
          { ...command(cycleA), dependsOnOperationId: cycleB },
          { ...command(cycleB), dependsOnOperationId: cycleA },
        ],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", statusCode: 409 });
    const cycleReceipts = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sync_operation_receipt
       WHERE operation_id IN ($1, $2)`,
      [cycleA, cycleB],
    );
    expect(cycleReceipts.rows[0]?.count).toBe("0");

    await campaigns.activateCampaign({ actorUserId, campaignId: campaign.id, crewId });
    await database.query(`UPDATE campaign SET status = 'CLOSED' WHERE crew_id = $1 AND id = $2`, [
      crewId,
      campaign.id,
    ]);
    await expect(
      syncService.pushCommands({
        actorUserId,
        commands: [command(closedOperationId)],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", statusCode: 409 });

    const artifacts = await database.query<{ changes: string; events: string; receipts: string }>(
      `SELECT
         (SELECT COUNT(*) FROM point_event WHERE operation_id IN ($1, $2))::text AS events,
         (SELECT COUNT(*) FROM sync_operation_receipt WHERE operation_id IN ($1, $2))::text AS receipts,
         (SELECT COUNT(*)
            FROM sync_change AS change
            JOIN point_event AS event
              ON event.crew_id = change.crew_id AND event.id = change.event_id
           WHERE event.operation_id IN ($1, $2))::text AS changes`,
      [draftOperationId, closedOperationId],
    );
    expect(artifacts.rows[0]).toEqual({ changes: "0", events: "0", receipts: "0" });

    const routeInactiveCampaign = await campaigns.createCampaign({
      actorUserId,
      crewId,
      name: "Campaña con asignación cerrada",
    });
    const routeInactiveAssignment = await campaigns.assignRoute({
      actorUserId,
      campaignId: routeInactiveCampaign.id,
      crewId,
      routeRevisionId: context.context.routeRevisionId,
      vehicleId: vehicle.id,
    });
    await database.query(
      `UPDATE campaign_route SET status = 'CLOSED' WHERE crew_id = $1 AND id = $2`,
      [crewId, routeInactiveAssignment.assignment.id],
    );
    await database.query(`UPDATE campaign SET status = 'ACTIVE' WHERE crew_id = $1 AND id = $2`, [
      crewId,
      routeInactiveCampaign.id,
    ]);
    const inactivePoint = (
      await database.query<{ id: string }>(
        `SELECT id FROM campaign_point
         WHERE crew_id = $1 AND campaign_route_id = $2
         ORDER BY display_order LIMIT 1`,
        [crewId, routeInactiveAssignment.assignment.id],
      )
    ).rows[0];
    if (!inactivePoint) throw new Error("TEST_INACTIVE_ROUTE_POINT_EMPTY");
    const routeInactiveOperationId = "50000000-0000-4000-8000-000000000022";
    await expect(
      syncService.pushCommands({
        actorUserId,
        commands: [{ ...command(routeInactiveOperationId), campaignPointId: inactivePoint.id }],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", statusCode: 409 });
    const visibleContexts = await syncService.listContexts({ actorUserId, crewId });
    expect(visibleContexts.some((item) => item.id === routeInactiveAssignment.assignment.id)).toBe(
      false,
    );
    const inactiveArtifacts = await database.query<{ count: string }>(
      `SELECT (
         (SELECT COUNT(*) FROM point_event WHERE operation_id = $1) +
         (SELECT COUNT(*) FROM sync_operation_receipt WHERE operation_id = $1) +
         (SELECT COUNT(*)
            FROM sync_change AS change
            JOIN point_event AS event
              ON event.crew_id = change.crew_id AND event.id = change.event_id
           WHERE event.operation_id = $1)
       )::text AS count`,
      [routeInactiveOperationId],
    );
    expect(inactiveArtifacts.rows[0]?.count).toBe("0");
  });

  it("applies a stale-base causal chain, undo, replay and paginated pull without duplicate effects", async () => {
    const commands = causalCommands();
    const first = await syncService.pushCommands({ actorUserId, commands, crewId });
    expect(first.results).toMatchObject([
      { replayed: false, state: "VOLVER", status: "APPLIED", version: 1 },
      { replayed: false, state: "APORTO", status: "APPLIED", version: 2 },
      { replayed: false, state: "VOLVER", status: "APPLIED", version: 3 },
    ]);
    expect(first.results.map((result) => result.changeSequence)).toEqual([1, 2, 3]);

    // Simulates a response lost after commit: the complete request is retried.
    const retry = await syncService.pushCommands({ actorUserId, commands, crewId });
    expect(retry.results.every((result) => result.replayed)).toBe(true);
    expect(retry.results.map((result) => result.eventId)).toEqual(
      first.results.map((result) => result.eventId),
    );

    const counts = await database.query<{
      changes: string;
      events: string;
      receipts: string;
      state: string;
      version: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM point_event WHERE crew_id = $1)::text AS events,
         (SELECT COUNT(*) FROM sync_change WHERE crew_id = $1)::text AS changes,
         (SELECT COUNT(*) FROM sync_operation_receipt WHERE crew_id = $1)::text AS receipts,
         cp.display_state AS state,
         cp.version::text AS version
       FROM campaign_point cp
       WHERE cp.crew_id = $1 AND cp.id = $2`,
      [crewId, context.points[0]?.id],
    );
    expect(counts.rows[0]).toEqual({
      changes: "3",
      events: "3",
      receipts: "3",
      state: "VOLVER",
      version: "3",
    });
    const refreshedPackage = await syncService.getContextPackage({
      actorUserId,
      contextId: context.context.id,
      crewId,
    });
    expect(refreshedPackage?.points[0]).toMatchObject({
      displayState: "VOLVER",
      version: 3,
    });

    const clientAFirstPage = await syncService.pullChanges({
      actorUserId,
      crewId,
      limit: 2,
    });
    expect(clientAFirstPage).toMatchObject({ hasMore: true });
    expect(clientAFirstPage.changes.map((change) => change.version)).toEqual([1, 2]);
    const clientASecondPage = await syncService.pullChanges({
      actorUserId,
      crewId,
      cursor: clientAFirstPage.cursor,
      limit: 2,
    });
    expect(clientASecondPage).toMatchObject({ hasMore: false });
    expect(clientASecondPage.changes).toHaveLength(1);
    expect(clientASecondPage.changes[0]).toMatchObject({ state: "VOLVER", version: 3 });

    // A fresh second client receives the same canonical convergence from cursor zero.
    const clientB = await syncService.pullChanges({ actorUserId, crewId });
    expect(clientB.changes).toEqual([...clientAFirstPage.changes, ...clientASecondPage.changes]);
  });

  it("rejects payload reuse, stale independent commands and cross-tenant access", async () => {
    const [firstCommand] = causalCommands();
    if (firstCommand?.type !== "POINT_STATUS_CHANGED") {
      throw new Error("TEST_COMMAND_MISSING");
    }
    await syncService.pushCommands({ actorUserId, commands: [firstCommand], crewId });

    await expect(
      syncService.pushCommands({
        actorUserId,
        commands: [{ ...firstCommand, payload: { state: "APORTO" } }],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE", statusCode: 409 });

    const stale = await syncService.pushCommands({
      actorUserId,
      commands: [
        {
          ...firstCommand,
          operationId: "50000000-0000-4000-8000-000000000009",
          payload: { state: "SIN_RESPUESTA" },
        },
      ],
      crewId,
    });
    expect(stale.results[0]).toMatchObject({
      code: "BASE_VERSION_MISMATCH",
      state: "VOLVER",
      status: "CONFLICT",
      version: 1,
    });

    await expect(
      syncService.listContexts({ actorUserId: outsiderUserId, crewId }),
    ).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED", statusCode: 403 });

    const primaryCursor = (await syncService.pullChanges({ actorUserId, crewId })).cursor;
    await expect(
      syncService.pullChanges({
        actorUserId: outsiderUserId,
        crewId: secondaryCrewId,
        cursor: primaryCursor,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_SCOPE_MISMATCH", statusCode: 400 });
  });

  it("blocks an unresolved dependency without creating an event", async () => {
    const campaignPointId = context.points[0]?.id;
    if (!campaignPointId) throw new Error("TEST_CONTEXT_EMPTY");
    const result = await syncService.pushCommands({
      actorUserId,
      commands: [
        {
          baseVersion: 0,
          campaignPointId,
          dependsOnOperationId: "50000000-0000-4000-8000-000000000099",
          deviceId,
          operationId: "50000000-0000-4000-8000-000000000098",
          payload: { state: "VOLVER" },
          type: "POINT_STATUS_CHANGED",
          workSessionId,
        },
      ],
      crewId,
    });
    expect(result.results[0]).toMatchObject({
      code: "DEPENDENCY_NOT_CONFIRMED",
      status: "BLOCKED_DEPENDENCY",
    });
    const events = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM point_event WHERE crew_id = $1",
      [crewId],
    );
    expect(events.rows[0]?.count).toBe("0");
  });
});
