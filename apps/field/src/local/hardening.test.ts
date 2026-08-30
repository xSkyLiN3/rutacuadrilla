/// <reference types="node" />

import { webcrypto } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LocalWorkSession } from "../types";
import type { LocalDatabaseRequest } from "./protocol";
import {
  abortLocalH40Run,
  applySyncChanges,
  applySyncResults,
  bindLocalAccount,
  completeLocalH40Action,
  type DatabaseHandle,
  finishLocalH40Run,
  getLatestLocalH40Run,
  getLocalH40EvidenceSource,
  getRunningLocalH40Run,
  LOCAL_SCHEMA,
  listLocalOperations,
  MIGRATE_V3_TO_V4,
  MIGRATE_V4_TO_V5,
  MIGRATE_V5_TO_V6,
  markLocalH40RunExported,
  markLocalPoint,
  recordLocalH40Metric,
  recoverInterruptedSends,
  resolveLocalConflict,
  SELECT_LOCAL_CONTEXT_SQL,
  saveLocalWorkSession,
  startLocalH40Run,
  transitionLocalOperations,
  undoLocalOperation,
} from "./sqlite.worker";

let database: DatabaseSync;
let handle: DatabaseHandle;
const TEST_DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const TEST_DEVICE_ID_B = "00000000-0000-4000-8000-000000000002";
const TEST_MEMBERSHIP_ID = "membership-a";
const TEST_MEMBERSHIP_ID_B = "membership-b";
const TEST_WORK_SESSION_ID = "work-session-a";

function workSessionFixture(
  input: {
    campaignId?: string;
    campaignRouteId?: string;
    devices?: LocalWorkSession["devices"];
    id?: string;
    participants?: LocalWorkSession["participants"];
    version?: number;
  } = {},
): LocalWorkSession {
  const membershipId = input.participants?.[0]?.membershipId ?? TEST_MEMBERSHIP_ID;
  return {
    campaignId: input.campaignId ?? "campaign-session-a",
    campaignRouteId: input.campaignRouteId ?? "session-a",
    devices: input.devices ?? [
      {
        deviceId: TEST_DEVICE_ID,
        joinedAt: "2026-08-13T10:00:00.000Z",
        membershipId,
      },
    ],
    id: input.id ?? TEST_WORK_SESSION_ID,
    participants: input.participants ?? [
      {
        displayName: "Operador de prueba",
        joinedAt: "2026-08-13T10:00:00.000Z",
        membershipId,
        profile: "DRIVER",
      },
    ],
    startedAt: "2026-08-13T10:00:00.000Z",
    startedByDeviceId: TEST_DEVICE_ID,
    startedByMembershipId: TEST_MEMBERSHIP_ID,
    status: "ACTIVE",
    version: input.version ?? 1,
  };
}

function databaseHandle(db: DatabaseSync): DatabaseHandle {
  const adapter: DatabaseHandle = {
    exec(input) {
      if (typeof input === "string") db.exec(input);
      else db.prepare(input.sql).run(...((input.bind ?? []) as SQLInputValue[]));
    },
    selectObject(sql, bind = []) {
      return db.prepare(sql).get(...(bind as SQLInputValue[])) as
        | Record<string, unknown>
        | undefined;
    },
    selectObjects(sql, bind = []) {
      return db.prepare(sql).all(...(bind as SQLInputValue[])) as Array<Record<string, unknown>>;
    },
    selectValue(sql, bind = []) {
      const row = db.prepare(sql).get(...(bind as SQLInputValue[])) as
        | Record<string, unknown>
        | undefined;
      return row ? Object.values(row)[0] : undefined;
    },
    transaction<T>(callback: (transaction: DatabaseHandle) => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = callback(adapter);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return adapter;
}

function insertFixture(input: {
  accountId: string;
  crewId: string;
  legacy?: boolean;
  membershipId?: string;
  operationId: string;
  operationState?: "CONFLICT" | "PENDING" | "SENDING";
  resultJson?: string;
  sessionId: string;
  toState?: string;
  workSessionId?: string;
}) {
  const pointId = `point-${input.operationId}`;
  const membershipId = input.membershipId ?? TEST_MEMBERSHIP_ID;
  const workSessionId = input.workSessionId ?? `work-${input.sessionId}`;
  database
    .prepare(
      `INSERT INTO local_context (
         account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
         route_name, content_hash, package_json, package_sha256, work_session_id, installed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.crewId,
      input.sessionId,
      `campaign-${input.sessionId}`,
      `route-${input.sessionId}`,
      `revision-${input.sessionId}`,
      "Ruta de prueba",
      "a".repeat(64),
      "b".repeat(64),
      input.legacy ? null : workSessionId,
      "2026-08-13T10:00:00.000Z",
    );
  if (!input.legacy) {
    const session = workSessionFixture({
      campaignId: `campaign-${input.sessionId}`,
      campaignRouteId: input.sessionId,
      id: workSessionId,
      participants: [
        {
          displayName: "Operador de prueba",
          joinedAt: "2026-08-13T10:00:00.000Z",
          membershipId,
          profile: "DRIVER",
        },
      ],
    });
    database
      .prepare(
        `INSERT INTO local_work_session (
           account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
           status, version, started_at, finished_at, session_json, saved_at
         ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?, NULL, ?, ?)`,
      )
      .run(
        input.accountId,
        input.crewId,
        input.sessionId,
        workSessionId,
        session.campaignId,
        session.startedAt,
        JSON.stringify(session),
        "2026-08-13T10:00:00.000Z",
      );
  }
  database
    .prepare(
      `INSERT INTO local_point (
         account_id, crew_id, session_id, point_id, external_id, latitude, longitude,
         display_order, point_type, state, server_state, server_version
       ) VALUES (?, ?, ?, ?, ?, -0.45, -0.67, 0, 'DWELLING', 'VOLVER', 'VOLVER', 1)`,
    )
    .run(input.accountId, input.crewId, input.sessionId, pointId, `external-${pointId}`);
  database
    .prepare(
      `INSERT INTO sync_cursor (account_id, crew_id, session_id, cursor_value)
       VALUES (?, ?, ?, 'cursor-7')`,
    )
    .run(input.accountId, input.crewId, input.sessionId);
  database
    .prepare(
      `INSERT INTO outbox (
         account_id, crew_id, session_id, operation_id, device_id, device_sequence,
         point_id, base_version, work_session_id, previous_state, to_state, state, created_at,
         result_json
       ) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, 'SIN_VISITAR', ?, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.crewId,
      input.sessionId,
      input.operationId,
      TEST_DEVICE_ID,
      pointId,
      input.legacy ? null : workSessionId,
      input.toState ?? "VOLVER",
      input.operationState ?? "PENDING",
      "2026-08-13T10:01:00.000Z",
      input.resultJson ?? null,
    );
  return pointId;
}

function conflictRequest(
  operationId: string,
  decision: "ACCEPT_SERVER" | "REAPPLY_LOCAL",
  reason: string,
): Extract<LocalDatabaseRequest, { type: "resolve-conflict" }> {
  return {
    accountId: "a".repeat(64),
    crewId: "crew-a",
    decision,
    deviceId: TEST_DEVICE_ID,
    id: 1,
    membershipId: TEST_MEMBERSHIP_ID,
    operationId,
    reason,
    sessionId: "session-a",
    type: "resolve-conflict",
    workSessionId: TEST_WORK_SESSION_ID,
  };
}

function insertCausalDescendant(input: {
  operationId: string;
  operationState: "PENDING" | "SENDING";
  parentOperationId: string;
  pointId: string;
  sequence?: number;
  toState: string;
}) {
  database
    .prepare(
      `INSERT INTO outbox (
         account_id, crew_id, session_id, operation_id, device_id, device_sequence,
         point_id, base_version, depends_on_operation_id, previous_state, to_state,
         state, created_at, work_session_id
       ) VALUES (?, 'crew-a', 'session-a', ?, '00000000-0000-4000-8000-000000000001',
                 ?, ?, 1, ?, 'APORTO', ?, ?, ?, ?)`,
    )
    .run(
      "a".repeat(64),
      input.operationId,
      input.sequence ?? 101,
      input.pointId,
      input.parentOperationId,
      input.toState,
      input.operationState,
      "2026-08-13T10:02:00.000Z",
      TEST_WORK_SESSION_ID,
    );
  database
    .prepare(
      `UPDATE local_point SET state = ?
       WHERE account_id = ? AND crew_id = 'crew-a' AND session_id = 'session-a' AND point_id = ?`,
    )
    .run(input.toState, "a".repeat(64), input.pointId);
}

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec(LOCAL_SCHEMA);
  database.exec("PRAGMA user_version = 8");
  handle = databaseHandle(database);
});

describe("field local hardening", () => {
  it("lee un contexto unido a WorkSession sin columnas SQL ambiguas", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-context",
      sessionId: "session-a",
    });

    expect(
      handle.selectObject(SELECT_LOCAL_CONTEXT_SQL, ["a".repeat(64), "crew-a", "session-a"]),
    ).toMatchObject({
      campaignId: "campaign-session-a",
      crewId: "crew-a",
      pointCount: 1,
      routeName: "Ruta de prueba",
      sessionId: "session-a",
    });
  });

  it("associates H40 actions atomically, completes latency once and records safe metrics", () => {
    const accountId = "a".repeat(64);
    const pointId = insertFixture({
      accountId,
      crewId: "crew-a",
      operationId: "operation-before-h40",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const context = {
      accountId,
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42.0.0",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "c".repeat(64),
      type: "start-h40-run",
    });

    expect(() =>
      markLocalPoint(handle, {
        ...context,
        deviceId: TEST_DEVICE_ID,
        h40RunId: run.runId,
        id: 2,
        membershipId: TEST_MEMBERSHIP_ID,
        pointId,
        toState: "VOLVER",
        type: "mark-point",
      }),
    ).toThrow("H40_ACTION_NO_STATE_CHANGE");
    expect(() =>
      markLocalPoint(handle, {
        ...context,
        deviceId: TEST_DEVICE_ID,
        h40RunId: run.runId,
        id: 3,
        membershipId: TEST_MEMBERSHIP_ID,
        pointId: "point-missing",
        toState: "APORTO",
        type: "mark-point",
      }),
    ).toThrow("LOCAL_POINT_NOT_FOUND");
    expect(database.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 0,
    });

    const operation = markLocalPoint(handle, {
      ...context,
      deviceId: TEST_DEVICE_ID,
      h40RunId: run.runId,
      id: 4,
      membershipId: TEST_MEMBERSHIP_ID,
      pointId,
      toState: "APORTO",
      type: "mark-point",
    });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 1,
    });
    expect(
      database
        .prepare("SELECT action_kind AS kind FROM h40_run_operation WHERE operation_id = ?")
        .get(operation.operationId),
    ).toEqual({ kind: "MARK" });

    const completed = completeLocalH40Action(handle, {
      ...context,
      id: 5,
      operationId: operation.operationId,
      persistMs: 14.25,
      runId: run.runId,
      type: "complete-h40-action",
      visualMs: 19.5,
    });
    expect(completed).toMatchObject({
      actionCount: 1,
      completedActionCount: 1,
      persistMs: { count: 1, p50: 14.25, p95: 14.25 },
      visualMs: { count: 1, p50: 19.5, p95: 19.5 },
    });
    expect(() =>
      completeLocalH40Action(handle, {
        ...context,
        id: 6,
        operationId: operation.operationId,
        persistMs: 15,
        runId: run.runId,
        type: "complete-h40-action",
        visualMs: 20,
      }),
    ).toThrow("H40_ACTION_ALREADY_COMPLETED");

    const boot = recordLocalH40Metric(handle, {
      ...context,
      eventKind: "BOOT",
      monotonicMs: 100.5,
      pending: 1,
      runId: run.runId,
      wallAt: "2026-08-21T10:00:00.000Z",
    });
    const sync = recordLocalH40Metric(handle, {
      ...context,
      applied: 1,
      eventKind: "SYNC_END",
      pending: 0,
      runId: run.runId,
      wallAt: "2026-08-21T10:01:00.000Z",
    });
    expect([boot.recordedSequence, sync.recordedSequence]).toEqual([1, 2]);
    expect(() =>
      recordLocalH40Metric(handle, {
        ...context,
        errorCode: "correo@ejemplo.cl",
        eventKind: "RECOVERY",
        runId: run.runId,
        wallAt: "2026-08-21T10:02:00.000Z",
      }),
    ).toThrow("H40_METRIC_ERROR_CODE_INVALID");

    expect(() => getLocalH40EvidenceSource(handle, { ...context, runId: run.runId })).toThrow(
      "H40_EVIDENCE_NOT_FINALIZED",
    );
    expect(JSON.stringify(completed)).not.toContain(operation.operationId);
    expect(JSON.stringify(completed)).not.toContain(accountId);
    expect(() => database.exec("UPDATE h40_metric SET pending = 99")).toThrow(
      "H40_METRIC_APPEND_ONLY",
    );
    expect(() => database.exec("DELETE FROM h40_metric")).toThrow("H40_METRIC_APPEND_ONLY");
    expect(() => database.exec("UPDATE h40_run_operation SET action_kind = 'UNDO'")).toThrow(
      "H40_ACTION_EVIDENCE_IMMUTABLE",
    );
    expect(() => database.exec("DELETE FROM h40_run_operation")).toThrow(
      "H40_ACTION_EVIDENCE_APPEND_ONLY",
    );
    expect(() => database.exec("UPDATE h40_run SET build_id = 'altered'")).toThrow(
      "H40_RUN_EVIDENCE_IMMUTABLE",
    );
    expect(() => database.exec("DELETE FROM h40_run")).toThrow("H40_RUNNING_RUN_CANNOT_DELETE");
    abortLocalH40Run(handle, { ...context, runId: run.runId });
    database.prepare("DELETE FROM h40_run WHERE run_id = ?").run(run.runId);
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT count(*) AS count FROM h40_metric").get()).toEqual({
      count: 0,
    });
  });

  it("rejects an H40 run from another context before mutating a point or the outbox", () => {
    const accountA = "a".repeat(64);
    const pointA = insertFixture({
      accountId: accountA,
      crewId: "crew-a",
      operationId: "operation-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const accountB = "b".repeat(64);
    insertFixture({
      accountId: accountB,
      crewId: "crew-b",
      operationId: "operation-b",
      sessionId: "session-b",
      workSessionId: "work-session-b",
    });
    const runB = startLocalH40Run(handle, {
      accountId: accountB,
      buildId: "field-42",
      crewId: "crew-b",
      deviceAlias: "B",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "d".repeat(64),
      sessionId: "session-b",
      type: "start-h40-run",
      workSessionId: "work-session-b",
    });
    const before = database.prepare("SELECT count(*) AS count FROM outbox").get();

    expect(() =>
      markLocalPoint(handle, {
        accountId: accountA,
        crewId: "crew-a",
        deviceId: TEST_DEVICE_ID,
        h40RunId: runB.runId,
        id: 2,
        membershipId: TEST_MEMBERSHIP_ID,
        pointId: pointA,
        sessionId: "session-a",
        toState: "APORTO",
        type: "mark-point",
        workSessionId: TEST_WORK_SESSION_ID,
      }),
    ).toThrow("H40_RUN_NOT_FOUND_OR_CONTEXT_MISMATCH");
    expect(database.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual(before);
    expect(
      database.prepare("SELECT state FROM local_point WHERE point_id = ?").get(pointA),
    ).toEqual({ state: "VOLVER" });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 0,
    });
  });

  it("associates an H40 undo with the newly-created outbox operation", () => {
    const accountId = "a".repeat(64);
    insertFixture({
      accountId,
      crewId: "crew-a",
      operationId: "operation-to-undo",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const context = {
      accountId,
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "2".repeat(64),
      type: "start-h40-run",
    });

    const undo = undoLocalOperation(handle, {
      ...context,
      deviceId: TEST_DEVICE_ID,
      h40RunId: run.runId,
      id: 2,
      membershipId: TEST_MEMBERSHIP_ID,
      operationId: "operation-to-undo",
      type: "undo-operation",
    });

    expect(undo).toMatchObject({
      state: "PENDING",
      toState: "SIN_VISITAR",
      undoesOperationId: "operation-to-undo",
    });
    expect(
      database
        .prepare(
          `SELECT action_kind AS kind, operation_id AS "operationId"
           FROM h40_run_operation`,
        )
        .get(),
    ).toEqual({ kind: "UNDO", operationId: undo.operationId });
  });

  it("rejects mark, undo and reapply from another joined actor on the same H40 context", () => {
    const accountId = "a".repeat(64);
    const pointId = insertFixture({
      accountId,
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
      toState: "APORTO",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const mixedSession = workSessionFixture({
      devices: [
        {
          deviceId: TEST_DEVICE_ID,
          joinedAt: "2026-08-13T10:00:00.000Z",
          membershipId: TEST_MEMBERSHIP_ID,
        },
        {
          deviceId: TEST_DEVICE_ID_B,
          joinedAt: "2026-08-13T10:01:00.000Z",
          membershipId: TEST_MEMBERSHIP_ID_B,
        },
      ],
      participants: [
        {
          displayName: "Operador A",
          joinedAt: "2026-08-13T10:00:00.000Z",
          membershipId: TEST_MEMBERSHIP_ID,
          profile: "DRIVER",
        },
        {
          displayName: "Operador B",
          joinedAt: "2026-08-13T10:01:00.000Z",
          membershipId: TEST_MEMBERSHIP_ID_B,
          profile: "ASSISTANT",
        },
      ],
    });
    database
      .prepare(
        `UPDATE local_work_session SET session_json = ?
         WHERE account_id = ? AND crew_id = 'crew-a' AND work_session_id = ?`,
      )
      .run(JSON.stringify(mixedSession), accountId, TEST_WORK_SESSION_ID);
    const context = {
      accountId,
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "3".repeat(64),
      type: "start-h40-run",
    });
    const actorB = { deviceId: TEST_DEVICE_ID_B, membershipId: TEST_MEMBERSHIP_ID_B };

    expect(() =>
      markLocalPoint(handle, {
        ...context,
        ...actorB,
        h40RunId: run.runId,
        id: 2,
        pointId,
        toState: "VOLVER",
        type: "mark-point",
      }),
    ).toThrow("H40_RUN_ACTOR_MISMATCH");
    expect(() =>
      undoLocalOperation(handle, {
        ...context,
        ...actorB,
        h40RunId: run.runId,
        id: 3,
        operationId: "operation-conflict",
        type: "undo-operation",
      }),
    ).toThrow("H40_RUN_ACTOR_MISMATCH");
    expect(() =>
      resolveLocalConflict(handle, {
        ...conflictRequest("operation-conflict", "REAPPLY_LOCAL", "Confirmado en terreno"),
        ...actorB,
        h40RunId: run.runId,
        id: 4,
      }),
    ).toThrow("H40_RUN_ACTOR_MISMATCH");
    expect(database.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 0,
    });
  });

  it("attributes recovered SENDING rows only to the associated running H40 run", () => {
    const contextA = {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const pointA = insertFixture({
      ...contextA,
      operationId: "operation-preexisting-a",
      operationState: "SENDING",
    });
    const contextB = {
      accountId: "b".repeat(64),
      crewId: "crew-b",
      sessionId: "session-b",
      workSessionId: "work-session-b",
    };
    insertFixture({
      ...contextB,
      operationId: "operation-pending-b",
      operationState: "PENDING",
    });
    const runA = startLocalH40Run(handle, {
      ...contextA,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "a".repeat(64),
      type: "start-h40-run",
    });
    const runB = startLocalH40Run(handle, {
      ...contextB,
      buildId: "field-42",
      deviceAlias: "B",
      deviceId: TEST_DEVICE_ID,
      id: 2,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "b".repeat(64),
      type: "start-h40-run",
    });
    const associated = markLocalPoint(handle, {
      ...contextA,
      deviceId: TEST_DEVICE_ID,
      h40RunId: runA.runId,
      id: 3,
      membershipId: TEST_MEMBERSHIP_ID,
      pointId: pointA,
      toState: "APORTO",
      type: "mark-point",
    });
    database
      .prepare("UPDATE outbox SET state = 'SENDING' WHERE operation_id = ?")
      .run(associated.operationId);
    database
      .prepare(
        `INSERT INTO outbox (
           account_id, crew_id, session_id, operation_id, device_id, device_sequence,
           point_id, base_version, work_session_id, previous_state, to_state, state, created_at
         ) VALUES (?, ?, ?, 'operation-other-device', ?, 1, ?, 1, ?,
                   'APORTO', 'VOLVER', 'SENDING', ?)`,
      )
      .run(
        contextA.accountId,
        contextA.crewId,
        contextA.sessionId,
        TEST_DEVICE_ID_B,
        pointA,
        contextA.workSessionId,
        "2026-08-13T10:05:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO h40_run_operation (
           run_id, account_id, crew_id, session_id, work_session_id,
           operation_id, action_kind, visual_ms, persist_ms, recorded_at
         ) VALUES (?, ?, ?, ?, ?, 'operation-other-device', 'MARK', NULL, NULL, ?)`,
      )
      .run(
        runA.runId,
        contextA.accountId,
        contextA.crewId,
        contextA.sessionId,
        contextA.workSessionId,
        "2026-08-13T10:05:00.000Z",
      );

    expect(recoverInterruptedSends(handle)).toBe(3);
    expect(
      database
        .prepare(
          `SELECT run_id AS "runId", recovered_sending AS recovered
           FROM h40_run ORDER BY run_id`,
        )
        .all(),
    ).toEqual(
      [
        { recovered: 1, runId: runA.runId },
        { recovered: 0, runId: runB.runId },
      ].sort((left, right) => left.runId.localeCompare(right.runId)),
    );
    expect(
      database.prepare("SELECT count(*) AS count FROM outbox WHERE state = 'SENDING'").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT state FROM outbox WHERE operation_id = ?")
        .get(associated.operationId),
    ).toEqual({ state: "PENDING" });
  });

  it("aborts an incomplete run idempotently without touching points or outbox", () => {
    const accountId = "a".repeat(64);
    const pointId = insertFixture({
      accountId,
      crewId: "crew-a",
      operationId: "operation-seed",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const context = {
      accountId,
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "f".repeat(64),
      type: "start-h40-run",
    });
    markLocalPoint(handle, {
      ...context,
      deviceId: TEST_DEVICE_ID,
      h40RunId: run.runId,
      id: 2,
      membershipId: TEST_MEMBERSHIP_ID,
      pointId,
      toState: "APORTO",
      type: "mark-point",
    });
    const beforeOutbox = database
      .prepare("SELECT operation_id, state FROM outbox ORDER BY device_sequence")
      .all();
    const beforePoint = database
      .prepare("SELECT state FROM local_point WHERE point_id = ?")
      .get(pointId);

    expect(abortLocalH40Run(handle, { ...context, runId: run.runId })).toMatchObject({
      actionCount: 1,
      completedActionCount: 0,
      status: "ABORTED",
    });
    expect(abortLocalH40Run(handle, { ...context, runId: run.runId })).toMatchObject({
      status: "ABORTED",
    });
    expect(
      database.prepare("SELECT operation_id, state FROM outbox ORDER BY device_sequence").all(),
    ).toEqual(beforeOutbox);
    expect(
      database.prepare("SELECT state FROM local_point WHERE point_id = ?").get(pointId),
    ).toEqual(beforePoint);
    expect(getRunningLocalH40Run(handle, context)).toBeNull();
    expect(getLatestLocalH40Run(handle, context)).toBeNull();
    expect(
      startLocalH40Run(handle, {
        ...context,
        buildId: "field-42",
        deviceAlias: "A",
        deviceId: TEST_DEVICE_ID,
        id: 3,
        membershipId: TEST_MEMBERSHIP_ID,
        salt: "1".repeat(64),
        type: "start-h40-run",
      }),
    ).toMatchObject({ status: "RUNNING" });
  });

  it("enforces 500 actions per run and typed finish gates without closing early", () => {
    const accountId = "a".repeat(64);
    const pointId = insertFixture({
      accountId,
      crewId: "crew-a",
      operationId: "operation-seed",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    });
    const context = {
      accountId,
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "e".repeat(64),
      type: "start-h40-run",
    });
    expect(() => markLocalH40RunExported(handle, { ...context, runId: run.runId })).toThrow(
      "H40_RUN_NOT_FINISHED",
    );
    for (let index = 0; index < 500; index += 1) {
      markLocalPoint(handle, {
        ...context,
        deviceId: TEST_DEVICE_ID,
        h40RunId: run.runId,
        id: index + 2,
        membershipId: TEST_MEMBERSHIP_ID,
        pointId,
        toState: index % 2 === 0 ? "APORTO" : "VOLVER",
        type: "mark-point",
      });
    }
    expect(() =>
      markLocalPoint(handle, {
        ...context,
        deviceId: TEST_DEVICE_ID,
        h40RunId: run.runId,
        id: 503,
        membershipId: TEST_MEMBERSHIP_ID,
        pointId,
        toState: "APORTO",
        type: "mark-point",
      }),
    ).toThrow("H40_ACTION_LIMIT_REACHED");
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 500,
    });

    const pending = finishLocalH40Run(handle, { ...context, runId: run.runId });
    expect(pending.finished).toBe(false);
    expect(pending.summary.status).toBe("RUNNING");
    expect(pending.blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INCOMPLETE_ACTION_METRICS", current: 0, required: 500 }),
        expect.objectContaining({ code: "OUTBOX_NOT_EMPTY" }),
      ]),
    );
    database.prepare("UPDATE outbox SET state = 'CONFIRMED'").run();
    const stillIncomplete = finishLocalH40Run(handle, { ...context, runId: run.runId });
    expect(stillIncomplete).toMatchObject({
      blocking: [
        expect.objectContaining({
          code: "INCOMPLETE_ACTION_METRICS",
          current: 0,
          required: 500,
        }),
      ],
      finished: false,
      summary: { status: "RUNNING" },
    });
    database.prepare("UPDATE h40_run_operation SET visual_ms = 1, persist_ms = 2").run();
    const finished = finishLocalH40Run(handle, { ...context, runId: run.runId });
    expect(finished).toMatchObject({
      blocking: [],
      finished: true,
      summary: { status: "FINISHED" },
    });
    expect(getLatestLocalH40Run(handle, context)).toMatchObject({
      runId: run.runId,
      status: "FINISHED",
    });
    const evidenceAtFinish = getLocalH40EvidenceSource(handle, { ...context, runId: run.runId });
    expect(evidenceAtFinish.finalOutbox).toEqual({
      conflict: 0,
      pending: 0,
      rejected: 0,
      sending: 0,
    });
    expect(evidenceAtFinish.projection).toEqual([{ id: pointId, state: "VOLVER", version: 1 }]);
    expect(() =>
      database
        .prepare("UPDATE h40_run SET final_projection_json = '[]' WHERE run_id = ?")
        .run(run.runId),
    ).toThrow("H40_RUN_EVIDENCE_IMMUTABLE");
    database
      .prepare(
        `UPDATE local_point
         SET state = 'NO_PARTICIPA', server_state = 'NO_PARTICIPA', server_version = 99
         WHERE point_id = ?`,
      )
      .run(pointId);
    database
      .prepare("UPDATE outbox SET state = 'REJECTED' WHERE operation_id = 'operation-seed'")
      .run();
    expect(getLocalH40EvidenceSource(handle, { ...context, runId: run.runId })).toEqual(
      evidenceAtFinish,
    );
    expect(markLocalH40RunExported(handle, { ...context, runId: run.runId })).toMatchObject({
      status: "FINISHED",
    });
    const exportedAt = database
      .prepare("SELECT exported_at AS value FROM h40_run WHERE run_id = ?")
      .get(run.runId);
    expect(exportedAt).toEqual({ value: expect.any(String) });
    expect(markLocalH40RunExported(handle, { ...context, runId: run.runId })).toMatchObject({
      status: "FINISHED",
    });
    expect(
      database.prepare("SELECT exported_at AS value FROM h40_run WHERE run_id = ?").get(run.runId),
    ).toEqual(exportedAt);
    expect(() =>
      database
        .prepare("UPDATE h40_run SET exported_at = ? WHERE run_id = ?")
        .run("2026-08-21T23:59:59.000Z", run.runId),
    ).toThrow("H40_RUN_EVIDENCE_IMMUTABLE");
    expect(getLatestLocalH40Run(handle, context)).toBeNull();
    expect(
      startLocalH40Run(handle, {
        ...context,
        buildId: "field-43",
        deviceAlias: "B",
        deviceId: TEST_DEVICE_ID,
        id: 504,
        membershipId: TEST_MEMBERSHIP_ID,
        salt: "2".repeat(64),
        type: "start-h40-run",
      }),
    ).toMatchObject({ status: "RUNNING" });
  });

  it("migrates v3 to v6 without attributing a legacy outbox row to a new work session", () => {
    insertFixture({
      accountId: "legacy-account",
      crewId: "crew-legacy",
      operationId: "operation-legacy",
      operationState: "SENDING",
      sessionId: "session-legacy",
    });
    database.exec(`
      DROP TRIGGER h40_run_no_delete_while_running;
      DROP TRIGGER h40_run_update_guard;
      DROP TRIGGER h40_run_operation_no_direct_delete;
      DROP TRIGGER h40_run_operation_update_guard;
      DROP TRIGGER h40_metric_no_direct_delete;
      DROP TRIGGER h40_metric_no_update;
      DROP TRIGGER h40_run_operation_complete_once;
      DROP TRIGGER h40_run_operation_limit;
      DROP TABLE h40_metric;
      DROP TABLE h40_run_operation;
      DROP TABLE h40_run;
      DROP INDEX outbox_legacy_work_session_idx;
      DROP TABLE local_work_session;
      DROP TRIGGER local_conflict_resolution_no_update;
      DROP TRIGGER local_conflict_resolution_no_delete;
      DROP TABLE local_conflict_resolution;
      DROP TABLE local_identity_binding;
      ALTER TABLE local_context DROP COLUMN work_session_id;
      ALTER TABLE outbox DROP COLUMN work_session_id;
      ALTER TABLE outbox DROP COLUMN resolves_operation_id;
      ALTER TABLE local_point DROP COLUMN server_state;
      PRAGMA user_version = 3;
    `);

    database.exec(
      `BEGIN IMMEDIATE; ${MIGRATE_V3_TO_V4} ${MIGRATE_V4_TO_V5} ${MIGRATE_V5_TO_V6}
       PRAGMA user_version = 6; COMMIT;`,
    );

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(
      database.prepare("SELECT operation_id, state, work_session_id FROM outbox").get(),
    ).toEqual({
      operation_id: "operation-legacy",
      state: "SENDING",
      work_session_id: null,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('outbox') WHERE name = 'resolves_operation_id'",
        )
        .get(),
    ).toEqual({ name: "resolves_operation_id" });
    expect(database.prepare("SELECT state, server_state FROM local_point").get()).toEqual({
      server_state: "SIN_VISITAR",
      state: "VOLVER",
    });
    expect(
      listLocalOperations(handle, "legacy-account", "crew-legacy", "session-legacy", true),
    ).toEqual([]);
  });

  it("conserva una fila legacy sin atribuirla ni marcarla para envío v3", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-legacy",
      sessionId: "session-a",
    });
    database
      .prepare("UPDATE outbox SET work_session_id = NULL WHERE operation_id = 'operation-legacy'")
      .run();
    const before = database
      .prepare(
        `SELECT operation_id AS "operationId", state, work_session_id AS "workSessionId"
         FROM outbox WHERE operation_id = 'operation-legacy'`,
      )
      .get();

    const saved = saveLocalWorkSession(handle, {
      accountId: "a".repeat(64),
      campaignRouteId: "session-a",
      crewId: "crew-a",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      session: workSessionFixture(),
      type: "save-work-session",
    });
    expect(saved).toEqual({ legacyBlocked: 1, saved: true });
    expect(listLocalOperations(handle, "a".repeat(64), "crew-a", "session-a", true)).toEqual([]);
    expect(
      transitionLocalOperations(handle, {
        accountId: "a".repeat(64),
        crewId: "crew-a",
        id: 2,
        operationIds: ["operation-legacy"],
        sessionId: "session-a",
        type: "mark-sending",
      }),
    ).toEqual({ applied: 0 });
    expect(
      database
        .prepare(
          `SELECT operation_id AS "operationId", state, work_session_id AS "workSessionId"
           FROM outbox WHERE operation_id = 'operation-legacy'`,
        )
        .get(),
    ).toEqual(before);
  });

  it("acepta el snapshot v2 posterior a join y rechaza reutilizar esa versión con otro contenido", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-a",
      sessionId: "session-a",
    });
    const participantB = {
      displayName: "Asistente Dos",
      joinedAt: "2026-08-13T10:05:00.000Z",
      membershipId: "membership-b",
      profile: "ASSISTANT" as const,
    };
    const deviceB = {
      deviceId: "00000000-0000-4000-8000-000000000002",
      joinedAt: "2026-08-13T10:05:00.000Z",
      membershipId: "membership-b",
    };
    const joined = workSessionFixture({
      devices: [...workSessionFixture().devices, deviceB],
      participants: [...workSessionFixture().participants, participantB],
      version: 2,
    });
    const request = {
      accountId: "a".repeat(64),
      campaignRouteId: "session-a",
      crewId: "crew-a",
      deviceId: deviceB.deviceId,
      id: 1,
      membershipId: participantB.membershipId,
      session: joined,
      type: "save-work-session" as const,
    };

    expect(saveLocalWorkSession(handle, request)).toMatchObject({ saved: true });
    expect(
      saveLocalWorkSession(handle, {
        ...request,
        id: 2,
        session: {
          ...joined,
          devices: [...joined.devices].reverse(),
          participants: [...joined.participants].reverse(),
        },
      }),
    ).toMatchObject({ saved: true });
    expect(() =>
      saveLocalWorkSession(handle, {
        ...request,
        id: 3,
        session: {
          ...joined,
          participants: joined.participants.map((participant) =>
            participant.membershipId === participantB.membershipId
              ? { ...participant, displayName: "Nombre alterado" }
              : participant,
          ),
        },
      }),
    ).toThrow("LOCAL_WORK_SESSION_VERSION_REUSED");
  });

  it("impide que otra membresía opere offline con el vínculo del mismo deviceId", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
    });

    expect(() =>
      resolveLocalConflict(handle, {
        ...conflictRequest("operation-conflict", "ACCEPT_SERVER", "Cambio de usuario local"),
        membershipId: "membership-b",
      }),
    ).toThrow("LOCAL_DEVICE_NOT_JOINED");
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "CONFLICT" });
    expect(
      database.prepare("SELECT count(*) AS count FROM local_conflict_resolution").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("binds accounts A and B to isolated partitions and rejects an occupied target", () => {
    insertFixture({
      accountId: "account-a",
      crewId: "crew-a",
      operationId: "operation-a",
      sessionId: "session-a",
    });
    const accountA = bindLocalAccount(handle, {
      legacyAccountId: "account-a",
      partitionId: "a".repeat(64),
      subjectBinding: "1".repeat(64),
    });
    expect(accountA).toEqual({ bound: true, migratedContexts: 1, migratedOperations: 1 });
    expect(database.prepare("SELECT DISTINCT account_id FROM outbox").all()).toEqual([
      { account_id: "a".repeat(64) },
    ]);
    expect(database.prepare("SELECT cursor_value FROM sync_cursor").get()).toEqual({
      cursor_value: "cursor-7",
    });

    insertFixture({
      accountId: "account-b",
      crewId: "crew-b",
      operationId: "operation-b",
      sessionId: "session-b",
    });
    bindLocalAccount(handle, {
      legacyAccountId: "account-b",
      partitionId: "b".repeat(64),
      subjectBinding: "2".repeat(64),
    });
    expect(
      database.prepare("SELECT DISTINCT account_id FROM local_context ORDER BY 1").all(),
    ).toEqual([{ account_id: "a".repeat(64) }, { account_id: "b".repeat(64) }]);
    insertFixture({
      accountId: "account-c",
      crewId: "crew-c",
      operationId: "operation-c",
      sessionId: "session-c",
    });
    expect(() =>
      bindLocalAccount(handle, {
        legacyAccountId: "account-c",
        partitionId: "a".repeat(64),
        subjectBinding: "3".repeat(64),
      }),
    ).toThrow("LOCAL_PARTITION_OCCUPIED_BY_ANOTHER_IDENTITY");
    expect(
      database.prepare("SELECT account_id FROM outbox WHERE operation_id = 'operation-c'").get(),
    ).toEqual({ account_id: "account-c" });
  });

  it("requeues an interrupted send exactly once and reports the recovered count", () => {
    insertFixture({
      accountId: "account-a",
      crewId: "crew-a",
      operationId: "operation-a",
      operationState: "SENDING",
      sessionId: "session-a",
    });

    expect(recoverInterruptedSends(handle)).toBe(1);
    expect(recoverInterruptedSends(handle)).toBe(0);
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "PENDING" });
  });

  it("classifies a blocked dependency without canonical state as rejected attention", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-blocked",
      operationState: "SENDING",
      sessionId: "session-a",
    });

    applySyncResults(handle, {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      id: 1,
      results: [
        {
          code: "DEPENDENCY_NOT_CONFIRMED",
          operationId: "operation-blocked",
          status: "BLOCKED_DEPENDENCY",
          workSessionId: TEST_WORK_SESSION_ID,
        },
      ],
      sessionId: "session-a",
      type: "apply-results",
    });

    expect(database.prepare("SELECT state, result_json AS resultJson FROM outbox").get()).toEqual({
      resultJson: JSON.stringify({
        code: "DEPENDENCY_NOT_CONFIRMED",
        operationId: "operation-blocked",
        status: "BLOCKED_DEPENDENCY",
        workSessionId: TEST_WORK_SESSION_ID,
      }),
      state: "REJECTED",
    });
    expect(
      database.prepare("SELECT count(*) AS count FROM local_conflict_resolution").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects an APPLIED receipt without canonical evidence and restores the marked batch", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-malformed-result",
      sessionId: "session-a",
    });
    const transition = {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationIds: ["operation-malformed-result"],
      sessionId: "session-a",
    };
    transitionLocalOperations(handle, { ...transition, id: 1, type: "mark-sending" });

    expect(() =>
      applySyncResults(handle, {
        accountId: "a".repeat(64),
        crewId: "crew-a",
        id: 2,
        results: [
          {
            operationId: "operation-malformed-result",
            status: "APPLIED",
            workSessionId: TEST_WORK_SESSION_ID,
          },
        ],
        sessionId: "session-a",
        type: "apply-results",
      }),
    ).toThrow("LOCAL_SYNC_RESULT_CANONICAL_STATE_MISSING");
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "SENDING" });

    transitionLocalOperations(handle, { ...transition, id: 3, type: "restore-pending" });
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "PENDING" });
  });

  it("accepts the canonical server state atomically with a required append-only reason", () => {
    const resultJson = JSON.stringify({
      code: "BASE_VERSION_MISMATCH",
      state: "SIN_RESPUESTA",
      status: "CONFLICT",
      version: 4,
    });
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson,
      sessionId: "session-a",
      toState: "APORTO",
    });
    const context = {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "4".repeat(64),
      type: "start-h40-run",
    });

    expect(() =>
      resolveLocalConflict(handle, conflictRequest("operation-conflict", "ACCEPT_SERVER", "   ")),
    ).toThrow("LOCAL_CONFLICT_REASON_REQUIRED");
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "CONFLICT" });

    resolveLocalConflict(handle, {
      ...conflictRequest("operation-conflict", "ACCEPT_SERVER", "Verificado con la cuadrilla"),
      h40RunId: run.runId,
    });
    expect(
      database
        .prepare("SELECT state, server_version FROM local_point WHERE point_id = ?")
        .get(pointId),
    ).toEqual({ server_version: 4, state: "SIN_RESPUESTA" });
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "SUPERSEDED" });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run_operation").get()).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT decision, reason FROM local_conflict_resolution").get(),
    ).toEqual({ decision: "ACCEPT_SERVER", reason: "Verificado con la cuadrilla" });
    expect(() => database.exec("UPDATE local_conflict_resolution SET reason = 'cambiado'")).toThrow(
      "LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY",
    );
    expect(() => database.exec("DELETE FROM local_conflict_resolution")).toThrow(
      "LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY",
    );
  });

  it("keeps the original conflict visible while a reasoned local retry is pending", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    const context = {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: TEST_WORK_SESSION_ID,
    };
    const run = startLocalH40Run(handle, {
      ...context,
      buildId: "field-42",
      deviceAlias: "A",
      deviceId: TEST_DEVICE_ID,
      id: 1,
      membershipId: TEST_MEMBERSHIP_ID,
      salt: "5".repeat(64),
      type: "start-h40-run",
    });

    const resolution = resolveLocalConflict(handle, {
      ...conflictRequest("operation-conflict", "REAPPLY_LOCAL", "La vivienda confirmó el aporte"),
      h40RunId: run.runId,
    });
    expect(resolution).toMatchObject({
      decision: "REAPPLY_LOCAL",
      operation: { state: "PENDING" },
    });
    const operations = database
      .prepare(
        `SELECT operation_id, state, base_version, depends_on_operation_id, resolves_operation_id
         FROM outbox ORDER BY device_sequence`,
      )
      .all();
    expect(operations[0]).toMatchObject({ operation_id: "operation-conflict", state: "CONFLICT" });
    expect(operations[1]).toMatchObject({
      base_version: 3,
      depends_on_operation_id: null,
      resolves_operation_id: "operation-conflict",
      state: "PENDING",
    });
    expect(
      database
        .prepare(
          `SELECT operation_id AS "operationId", action_kind AS kind
           FROM h40_run_operation`,
        )
        .get(),
    ).toEqual({ kind: "MARK", operationId: resolution.operation?.operationId });
    expect(
      database.prepare("SELECT decision, reason FROM local_conflict_resolution").get(),
    ).toEqual({ decision: "REAPPLY_LOCAL", reason: "La vivienda confirmó el aporte" });
  });

  it.each(["CONFLICT", "REJECTED"] as const)(
    "keeps the original conflict when its local retry finishes as %s",
    (status) => {
      insertFixture({
        accountId: "a".repeat(64),
        crewId: "crew-a",
        operationId: "operation-conflict",
        operationState: "CONFLICT",
        resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
        sessionId: "session-a",
        toState: "APORTO",
      });
      const resolution = resolveLocalConflict(
        handle,
        conflictRequest("operation-conflict", "REAPPLY_LOCAL", "Confirmado en terreno"),
      );
      const retryId = resolution.operation?.operationId;
      if (!retryId) throw new Error("TEST_RETRY_OPERATION_MISSING");

      applySyncResults(handle, {
        accountId: "a".repeat(64),
        crewId: "crew-a",
        id: 2,
        results: [
          {
            state: "VOLVER" as const,
            version: 4,
            code: status === "CONFLICT" ? "BASE_VERSION_MISMATCH" : "NO_STATE_CHANGE",
            operationId: retryId,
            status,
            workSessionId: TEST_WORK_SESSION_ID,
          },
        ],
        sessionId: "session-a",
        type: "apply-results",
      });

      expect(
        database
          .prepare("SELECT operation_id AS operationId, state FROM outbox ORDER BY device_sequence")
          .all(),
      ).toEqual([
        { operationId: "operation-conflict", state: "CONFLICT" },
        { operationId: retryId, state: status },
      ]);
    },
  );

  it("supersedes the original conflict only after its local retry is applied", () => {
    insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    const resolution = resolveLocalConflict(
      handle,
      conflictRequest("operation-conflict", "REAPPLY_LOCAL", "Confirmado en terreno"),
    );
    const retryId = resolution.operation?.operationId;
    if (!retryId) throw new Error("TEST_RETRY_OPERATION_MISSING");

    applySyncResults(handle, {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      id: 3,
      results: [
        {
          operationId: retryId,
          state: "APORTO",
          status: "APPLIED",
          version: 4,
          workSessionId: TEST_WORK_SESSION_ID,
        },
      ],
      sessionId: "session-a",
      type: "apply-results",
    });

    expect(
      database
        .prepare("SELECT operation_id AS operationId, state FROM outbox ORDER BY device_sequence")
        .all(),
    ).toEqual([
      { operationId: "operation-conflict", state: "SUPERSEDED" },
      { operationId: retryId, state: "CONFIRMED" },
    ]);
  });

  it("accepts a pulled v3 canonical state instead of regressing to the conflict receipt v2", () => {
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 2 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    applySyncChanges(handle, {
      accountId: "a".repeat(64),
      changes: [{ pointId, sequence: 8, state: "NO_PARTICIPA", version: 3 }],
      crewId: "crew-a",
      cursor: "cursor-8",
      id: 4,
      sessionId: "session-a",
      type: "apply-changes",
    });

    expect(
      listLocalOperations(handle, "a".repeat(64), "crew-a", "session-a", false)[0],
    ).toMatchObject({ canonicalState: "NO_PARTICIPA", canonicalVersion: 3 });

    resolveLocalConflict(
      handle,
      conflictRequest("operation-conflict", "ACCEPT_SERVER", "Se verificó el cambio remoto"),
    );

    expect(
      database
        .prepare(
          `SELECT state, server_state AS "serverState", server_version AS version
             FROM local_point WHERE point_id = ?`,
        )
        .get(pointId),
    ).toEqual({ serverState: "NO_PARTICIPA", state: "NO_PARTICIPA", version: 3 });
    expect(
      database
        .prepare(
          "SELECT canonical_state AS state, canonical_version AS version FROM local_conflict_resolution",
        )
        .get(),
    ).toEqual({ state: "NO_PARTICIPA", version: 3 });
  });

  it("reapplies the local desire on top of pulled canonical v3 without lowering its version", () => {
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 2 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    applySyncChanges(handle, {
      accountId: "a".repeat(64),
      changes: [{ pointId, sequence: 9, state: "NO_PARTICIPA", version: 3 }],
      crewId: "crew-a",
      cursor: "cursor-9",
      id: 5,
      sessionId: "session-a",
      type: "apply-changes",
    });

    const resolution = resolveLocalConflict(
      handle,
      conflictRequest("operation-conflict", "REAPPLY_LOCAL", "La vivienda ratificó el aporte"),
    );

    expect(resolution.operation).toMatchObject({ baseVersion: 3, toState: "APORTO" });
    expect(
      database
        .prepare(
          `SELECT state, server_state AS "serverState", server_version AS version
             FROM local_point WHERE point_id = ?`,
        )
        .get(pointId),
    ).toEqual({ serverState: "NO_PARTICIPA", state: "APORTO", version: 3 });
    expect(
      database
        .prepare(
          "SELECT canonical_state AS state, canonical_version AS version FROM local_conflict_resolution",
        )
        .get(),
    ).toEqual({ state: "NO_PARTICIPA", version: 3 });
  });

  it("closes a retry chain when NO_STATE_CHANGE confirms that the local desire already converged", () => {
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    const resolution = resolveLocalConflict(
      handle,
      conflictRequest("operation-conflict", "REAPPLY_LOCAL", "Confirmado por la vivienda"),
    );
    const retryId = resolution.operation?.operationId;
    if (!retryId) throw new Error("TEST_RETRY_OPERATION_MISSING");

    applySyncResults(handle, {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      id: 6,
      results: [
        {
          code: "NO_STATE_CHANGE",
          operationId: retryId,
          state: "APORTO",
          status: "REJECTED",
          version: 4,
          workSessionId: TEST_WORK_SESSION_ID,
        },
      ],
      sessionId: "session-a",
      type: "apply-results",
    });

    expect(
      database
        .prepare("SELECT operation_id AS id, state FROM outbox ORDER BY device_sequence")
        .all(),
    ).toEqual([
      { id: "operation-conflict", state: "SUPERSEDED" },
      { id: retryId, state: "SUPERSEDED" },
    ]);
    expect(
      database
        .prepare(
          `SELECT state, server_state AS "serverState", server_version AS version
           FROM local_point WHERE point_id = ?`,
        )
        .get(pointId),
    ).toEqual({ serverState: "APORTO", state: "APORTO", version: 4 });
    expect(
      database.prepare("SELECT count(*) AS count FROM local_conflict_resolution").get(),
    ).toEqual({ count: 1 });

    applySyncChanges(handle, {
      accountId: "a".repeat(64),
      changes: [{ pointId, sequence: 10, state: "NO_PARTICIPA", version: 5 }],
      crewId: "crew-a",
      cursor: "cursor-10",
      id: 7,
      sessionId: "session-a",
      type: "apply-changes",
    });
    expect(
      listLocalOperations(handle, "a".repeat(64), "crew-a", "session-a", false).find(
        (operation) => operation.operationId === retryId,
      ),
    ).toMatchObject({
      canonicalState: "NO_PARTICIPA",
      canonicalVersion: 5,
      resolutionConverged: true,
    });
  });

  it("allows a second auditable decision when a retry is rejected for another reason", () => {
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-conflict",
      operationState: "CONFLICT",
      resultJson: JSON.stringify({ state: "SIN_RESPUESTA", status: "CONFLICT", version: 3 }),
      sessionId: "session-a",
      toState: "APORTO",
    });
    const firstResolution = resolveLocalConflict(
      handle,
      conflictRequest("operation-conflict", "REAPPLY_LOCAL", "Confirmado en terreno"),
    );
    const retryId = firstResolution.operation?.operationId;
    if (!retryId) throw new Error("TEST_RETRY_OPERATION_MISSING");
    applySyncResults(handle, {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      id: 7,
      results: [
        {
          code: "INVALID_TRANSITION",
          operationId: retryId,
          state: "SIN_RESPUESTA",
          status: "REJECTED",
          version: 3,
          workSessionId: TEST_WORK_SESSION_ID,
        },
      ],
      sessionId: "session-a",
      type: "apply-results",
    });

    resolveLocalConflict(handle, {
      ...conflictRequest(retryId, "ACCEPT_SERVER", "Se descarta el reintento rechazado"),
      id: 8,
    });

    expect(
      database
        .prepare("SELECT operation_id AS id, state FROM outbox ORDER BY device_sequence")
        .all(),
    ).toEqual([
      { id: "operation-conflict", state: "SUPERSEDED" },
      { id: retryId, state: "SUPERSEDED" },
    ]);
    expect(
      database
        .prepare(
          `SELECT state, server_state AS "serverState", server_version AS version
           FROM local_point WHERE point_id = ?`,
        )
        .get(pointId),
    ).toEqual({ serverState: "SIN_RESPUESTA", state: "SIN_RESPUESTA", version: 3 });
    expect(
      database
        .prepare(
          `SELECT conflict_operation_id AS "operationId", decision
           FROM local_conflict_resolution ORDER BY rowid`,
        )
        .all(),
    ).toEqual([
      { decision: "REAPPLY_LOCAL", operationId: "operation-conflict" },
      { decision: "ACCEPT_SERVER", operationId: retryId },
    ]);
  });

  it("resolves a conflict at batch item 100 without confusing item 101 overlay for canonical state", () => {
    const pointId = insertFixture({
      accountId: "a".repeat(64),
      crewId: "crew-a",
      operationId: "operation-100",
      operationState: "SENDING",
      sessionId: "session-a",
      toState: "APORTO",
    });
    database
      .prepare(
        `UPDATE outbox SET device_id = '00000000-0000-4000-8000-000000000001',
                           device_sequence = 100
         WHERE operation_id = 'operation-100'`,
      )
      .run();
    insertCausalDescendant({
      operationId: "operation-101",
      operationState: "PENDING",
      parentOperationId: "operation-100",
      pointId,
      toState: "NO_PARTICIPA",
    });

    applySyncResults(handle, {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      id: 9,
      results: [
        {
          code: "BASE_VERSION_MISMATCH",
          operationId: "operation-100",
          state: "SIN_RESPUESTA",
          status: "CONFLICT",
          version: 2,
          workSessionId: TEST_WORK_SESSION_ID,
        },
      ],
      sessionId: "session-a",
      type: "apply-results",
    });
    expect(
      database
        .prepare(
          `SELECT state, server_state AS "serverState", server_version AS version
           FROM local_point WHERE point_id = ?`,
        )
        .get(pointId),
    ).toEqual({ serverState: "SIN_RESPUESTA", state: "NO_PARTICIPA", version: 2 });

    const resolution = resolveLocalConflict(
      handle,
      conflictRequest("operation-100", "REAPPLY_LOCAL", "Se conserva la ultima decision local"),
    );

    expect(resolution.operation).toMatchObject({
      baseVersion: 2,
      deviceSequence: 102,
      toState: "NO_PARTICIPA",
    });
    expect(
      database
        .prepare(
          `SELECT operation_id AS id, state, to_state AS "toState"
           FROM outbox ORDER BY device_sequence`,
        )
        .all(),
    ).toEqual([
      { id: "operation-100", state: "CONFLICT", toState: "APORTO" },
      { id: "operation-101", state: "SUPERSEDED", toState: "NO_PARTICIPA" },
      {
        id: resolution.operation?.operationId,
        state: "PENDING",
        toState: "NO_PARTICIPA",
      },
    ]);
  });

  it.each(["ACCEPT_SERVER", "REAPPLY_LOCAL"] as const)(
    "supersedes a causally blocked child when resolving its parent with %s",
    (decision) => {
      const pointId = insertFixture({
        accountId: "a".repeat(64),
        crewId: "crew-a",
        operationId: "operation-parent",
        operationState: "SENDING",
        sessionId: "session-a",
        toState: "APORTO",
      });
      insertCausalDescendant({
        operationId: "operation-child",
        operationState: "SENDING",
        parentOperationId: "operation-parent",
        pointId,
        sequence: 2,
        toState: "NO_PARTICIPA",
      });
      applySyncResults(handle, {
        accountId: "a".repeat(64),
        crewId: "crew-a",
        id: 10,
        results: [
          {
            code: "BASE_VERSION_MISMATCH",
            operationId: "operation-parent",
            state: "SIN_RESPUESTA",
            status: "CONFLICT",
            version: 2,
            workSessionId: TEST_WORK_SESSION_ID,
          },
          {
            code: "DEPENDENCY_NOT_CONFIRMED",
            operationId: "operation-child",
            status: "BLOCKED_DEPENDENCY",
            workSessionId: TEST_WORK_SESSION_ID,
          },
        ],
        sessionId: "session-a",
        type: "apply-results",
      });

      const resolution = resolveLocalConflict(
        handle,
        conflictRequest("operation-parent", decision, "Se reviso la cadena causal"),
      );

      expect(
        database.prepare("SELECT state FROM outbox WHERE operation_id = 'operation-child'").get(),
      ).toEqual({ state: "SUPERSEDED" });
      expect(
        database
          .prepare(
            `SELECT json_extract(result_json, '$.status') AS status,
                    json_extract(result_json, '$.localDisposition') AS disposition
             FROM outbox WHERE operation_id = 'operation-child'`,
          )
          .get(),
      ).toEqual({
        disposition: "SUPERSEDED_BY_CONFLICT_RESOLUTION",
        status: "BLOCKED_DEPENDENCY",
      });
      if (decision === "REAPPLY_LOCAL") {
        expect(resolution.operation).toMatchObject({ toState: "NO_PARTICIPA" });
      } else {
        expect(
          database
            .prepare("SELECT state FROM outbox WHERE operation_id = 'operation-parent'")
            .get(),
        ).toEqual({ state: "SUPERSEDED" });
      }
    },
  );
});
