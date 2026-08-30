import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  type DomainDatabase,
  RouteService,
  SyncService,
  WorkSessionService,
} from "../src/index.js";
import { openSeededDatabase, validCsv } from "./helpers.js";

const adminDeviceId = "40000000-0000-4000-8000-000000000041";
const memberDeviceId = "40000000-0000-4000-8000-000000000042";

describe.sequential("work session MVS", () => {
  let actorUserId: string;
  let campaignPointId: string;
  let campaignRouteId: string;
  let crewId: string;
  let database: DomainDatabase;
  let memberUserId: string;
  let service: WorkSessionService;

  beforeEach(async () => {
    const opened = await openSeededDatabase();
    database = opened.database;
    actorUserId = opened.seed.userIds.admin;
    memberUserId = opened.seed.userIds.member;
    crewId = opened.seed.crewIds.primary;
    service = new WorkSessionService(database);

    const routes = new RouteService(database);
    const imported = await routes.importRoute({
      actorUserId,
      crewId,
      csv: validCsv,
      importKey: `work-session-${randomUUID()}`,
      routeName: "Ruta jornada sintética",
      sectorName: "Sector jornada sintética",
    });
    if (!imported.route || !imported.revision) throw new Error("TEST_ROUTE_IMPORT_FAILED");
    await routes.publishRevision({
      actorUserId,
      crewId,
      revisionId: imported.revision.id,
      routeId: imported.route.id,
    });
    const context = await new SyncService(database).createTechnicalContext({
      actorUserId,
      crewId,
      routeRevisionId: imported.revision.id,
    });
    campaignRouteId = context.context.id;
    const point = context.points[0];
    if (!point) throw new Error("TEST_CONTEXT_EMPTY");
    campaignPointId = point.id;
  });

  afterEach(async () => {
    await closeDatabase(database);
  });

  it("starts atomically, autojoins the initiator/device and replays the same operation", async () => {
    const operationId = randomUUID();
    const input = {
      actorUserId,
      campaignRouteId,
      crewId,
      deviceId: adminDeviceId,
      operationId,
    };
    const started = await service.start(input);
    expect(started).toMatchObject({
      created: true,
      replayed: false,
      workSession: {
        campaignRouteId,
        devices: [{ deviceId: adminDeviceId }],
        participants: [{ displayName: "Admin Demo", profile: "OTHER" }],
        status: "ACTIVE",
        version: 1,
      },
    });

    const replay = await service.start(input);
    expect(replay).toMatchObject({
      created: true,
      replayed: true,
      workSession: { id: started.workSession.id },
    });
    await expect(service.start({ ...input, deviceId: memberDeviceId })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
      statusCode: 409,
    });
    await expect(service.start({ ...input, operationId: randomUUID() })).rejects.toMatchObject({
      code: "WORK_SESSION_ALREADY_OPEN",
      statusCode: 409,
    });
    await expect(
      service.getCurrent({ actorUserId, campaignRouteId, crewId }),
    ).resolves.toMatchObject({ id: started.workSession.id, status: "ACTIVE" });
  });

  it("serializes concurrent starts so exactly one open session exists", async () => {
    const attempts = await Promise.allSettled([
      service.start({
        actorUserId,
        campaignRouteId,
        crewId,
        deviceId: adminDeviceId,
        operationId: randomUUID(),
      }),
      service.start({
        actorUserId,
        campaignRouteId,
        crewId,
        deviceId: adminDeviceId,
        operationId: randomUUID(),
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const count = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM work_session
         WHERE crew_id = $1 AND campaign_route_id = $2
           AND status IN ('ACTIVE', 'FINISHED')`,
      [crewId, campaignRouteId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("refuses to start when the campaign is no longer ACTIVE", async () => {
    await database.query(
      `UPDATE campaign
       SET status = 'CLOSED'
       WHERE crew_id = $1
         AND id = (SELECT campaign_id FROM campaign_route WHERE crew_id = $1 AND id = $2)`,
      [crewId, campaignRouteId],
    );
    await expect(
      service.start({
        actorUserId,
        campaignRouteId,
        crewId,
        deviceId: adminDeviceId,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", statusCode: 409 });
  });

  it("joins a participant/device idempotently and freezes the identity snapshot", async () => {
    const started = await service.start({
      actorUserId,
      campaignRouteId,
      crewId,
      deviceId: adminDeviceId,
      operationId: randomUUID(),
    });
    const operationId = randomUUID();
    const input = {
      actorUserId: memberUserId,
      crewId,
      deviceId: memberDeviceId,
      operationId,
      workSessionId: started.workSession.id,
    };
    const joined = await service.join(input);
    expect(joined).toMatchObject({
      deviceJoined: true,
      participantJoined: true,
      replayed: false,
      workSession: {
        devices: expect.arrayContaining([expect.objectContaining({ deviceId: memberDeviceId })]),
        participants: expect.arrayContaining([
          expect.objectContaining({ displayName: "Miembro Demo", profile: "OTHER" }),
        ]),
        version: 2,
      },
    });
    await expect(service.join(input)).resolves.toMatchObject({
      deviceJoined: true,
      participantJoined: true,
      replayed: true,
    });
    await expect(service.join({ ...input, deviceId: randomUUID() })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
    });
    await expect(
      service.join({
        actorUserId,
        crewId,
        deviceId: memberDeviceId,
        operationId: randomUUID(),
        workSessionId: started.workSession.id,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_DEVICE_CONFLICT" });

    await database.query(`UPDATE app_user SET display_name = 'Nombre cambiado' WHERE id = $1`, [
      memberUserId,
    ]);
    const detail = await service.get({
      actorUserId,
      crewId,
      workSessionId: started.workSession.id,
    });
    expect(detail?.participants).toEqual(
      expect.arrayContaining([expect.objectContaining({ displayName: "Miembro Demo" })]),
    );
  });

  it("requires a joined actor/device for point commands and rejects writes after FINISHED", async () => {
    const started = await service.start({
      actorUserId,
      campaignRouteId,
      crewId,
      deviceId: adminDeviceId,
      operationId: randomUUID(),
    });
    const sync = new SyncService(database);
    const command = {
      baseVersion: 0,
      campaignPointId,
      deviceId: memberDeviceId,
      operationId: randomUUID(),
      payload: { state: "VOLVER" as const },
      type: "POINT_STATUS_CHANGED" as const,
      workSessionId: started.workSession.id,
    };
    await expect(
      sync.pushCommands({ actorUserId: memberUserId, commands: [command], crewId }),
    ).rejects.toMatchObject({
      code: "WORK_SESSION_PARTICIPATION_REQUIRED",
      statusCode: 403,
    });
    await service.join({
      actorUserId: memberUserId,
      crewId,
      deviceId: memberDeviceId,
      operationId: randomUUID(),
      workSessionId: started.workSession.id,
    });
    await expect(
      sync.pushCommands({ actorUserId: memberUserId, commands: [command], crewId }),
    ).resolves.toMatchObject({
      results: [{ status: "APPLIED", workSessionId: started.workSession.id }],
    });

    const finished = await service.finish({
      actorUserId,
      crewId,
      expectedVersion: 2,
      operationId: randomUUID(),
      workSessionId: started.workSession.id,
    });
    expect(finished).toMatchObject({
      replayed: false,
      workSession: { status: "FINISHED", version: 3 },
    });
    const rejectedOperationId = randomUUID();
    await expect(
      sync.pushCommands({
        actorUserId: memberUserId,
        commands: [
          {
            ...command,
            baseVersion: 1,
            operationId: rejectedOperationId,
            payload: { state: "APORTO" },
          },
        ],
        crewId,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_NOT_ACTIVE", statusCode: 409 });
    const receipt = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM sync_operation_receipt
         WHERE crew_id = $1 AND operation_id = $2`,
      [crewId, rejectedOperationId],
    );
    expect(receipt.rows[0]?.count).toBe("0");
  });

  it("finishes with optimistic versioning and idempotent FINISH receipts", async () => {
    const started = await service.start({
      actorUserId,
      campaignRouteId,
      crewId,
      deviceId: adminDeviceId,
      operationId: randomUUID(),
    });
    const operationId = randomUUID();
    const finishInput = {
      actorUserId,
      crewId,
      expectedVersion: 1,
      operationId,
      workSessionId: started.workSession.id,
    };
    const finished = await service.finish(finishInput);
    expect(finished).toMatchObject({
      replayed: false,
      workSession: { status: "FINISHED", version: 2 },
    });
    await expect(service.finish(finishInput)).resolves.toMatchObject({
      replayed: true,
      workSession: { id: started.workSession.id, version: 2 },
    });
    await expect(service.finish({ ...finishInput, expectedVersion: 2 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSE",
      statusCode: 409,
    });
    await expect(
      service.finish({ ...finishInput, operationId: randomUUID() }),
    ).rejects.toMatchObject({
      code: "WORK_SESSION_VERSION_CONFLICT",
      details: { actualVersion: 2, expectedVersion: 1 },
    });
    await expect(
      service.getCurrent({ actorUserId, campaignRouteId, crewId }),
    ).resolves.toMatchObject({ status: "FINISHED", version: 2 });
  });
});
