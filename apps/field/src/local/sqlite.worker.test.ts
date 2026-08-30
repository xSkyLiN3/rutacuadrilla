/// <reference types="node" />

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "./sqlite.worker";

let migrationSql: string;
let migrationV3ToV4Sql: string;
let migrationV4ToV5Sql: string;
let migrationV5ToV6Sql: string;
let migrationV6ToV8Sql: string;
let migrationV7ToV8Sql: string;
let repairSameVersionH40SchemaV8: typeof import("./sqlite.worker").repairSameVersionH40SchemaV8;
let planPackageMigrations: typeof import("./sqlite.worker").planLocalPackageV3Migrations;
let recoverSends: typeof import("./sqlite.worker").recoverInterruptedSends;
let finishH40Run: typeof import("./sqlite.worker").finishLocalH40Run;
let getH40Evidence: typeof import("./sqlite.worker").getLocalH40EvidenceSource;
let getLatestH40Run: typeof import("./sqlite.worker").getLatestLocalH40Run;
let markH40RunExported: typeof import("./sqlite.worker").markLocalH40RunExported;
let localSchema: string;
let database: DatabaseSync | undefined;
let temporaryDirectory: string | undefined;

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

const V1_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE local_context (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    route_revision_id TEXT NOT NULL,
    route_name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    package_json TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, session_id)
  ) STRICT;

  CREATE TABLE local_point (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    point_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    street TEXT,
    house_number TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    point_type TEXT NOT NULL,
    state TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    PRIMARY KEY (account_id, crew_id, session_id, point_id),
    FOREIGN KEY (account_id, crew_id, session_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE outbox (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_sequence INTEGER NOT NULL CHECK (device_sequence > 0),
    point_id TEXT NOT NULL,
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    depends_on_operation_id TEXT,
    previous_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING','SENDING','CONFIRMED','CONFLICT','REJECTED')),
    created_at TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (account_id, crew_id, operation_id),
    UNIQUE (account_id, crew_id, device_id, device_sequence),
    FOREIGN KEY (account_id, crew_id, session_id, point_id)
      REFERENCES local_point(account_id, crew_id, session_id, point_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX outbox_pending_idx
    ON outbox (account_id, crew_id, session_id, state, device_sequence);

  PRAGMA user_version = 1;
`;

beforeAll(async () => {
  ({
    MIGRATE_V1_TO_V2: migrationSql,
    MIGRATE_V3_TO_V4: migrationV3ToV4Sql,
    MIGRATE_V4_TO_V5: migrationV4ToV5Sql,
    MIGRATE_V5_TO_V6: migrationV5ToV6Sql,
    MIGRATE_V6_TO_V8: migrationV6ToV8Sql,
    MIGRATE_V7_TO_V8: migrationV7ToV8Sql,
    LOCAL_SCHEMA: localSchema,
    finishLocalH40Run: finishH40Run,
    getLatestLocalH40Run: getLatestH40Run,
    getLocalH40EvidenceSource: getH40Evidence,
    markLocalH40RunExported: markH40RunExported,
    repairSameVersionH40SchemaV8,
    planLocalPackageV3Migrations: planPackageMigrations,
    recoverInterruptedSends: recoverSends,
  } = await import("./sqlite.worker"));
});

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true });
  temporaryDirectory = undefined;
});

describe("SQLite field schema migration", () => {
  it("reabre un contexto v1 como v8 sin perder ni atribuir la operación heredada", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "rutacuadrilla-field-v1-"));
    const databasePath = join(temporaryDirectory, "field.sqlite3");
    database = new DatabaseSync(databasePath);
    database.exec(V1_SCHEMA);
    const legacyPackage = JSON.stringify({
      contractVersion: "p0-provisional-v1",
      context: {
        campaignId: "campaign-legacy",
        campaignName: "Campaña heredada",
        contentHash: "c".repeat(64),
        id: "session-legacy",
        pointCount: 1,
        routeId: "route-legacy",
        routeName: "Ruta heredada",
        routeRevisionId: "revision-legacy",
      },
      points: [
        {
          displayOrder: 0,
          displayState: "VOLVER",
          externalId: "point-external-legacy",
          id: "point-legacy",
          latitude: -0.45,
          longitude: -0.67,
          pointType: "DWELLING",
          version: 0,
        },
      ],
    });
    database
      .prepare(
        `INSERT INTO local_context (
           account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
           route_name, content_hash, package_json, installed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "account-legacy",
        "crew-legacy",
        "session-legacy",
        "campaign-legacy",
        "route-legacy",
        "revision-legacy",
        "Ruta heredada",
        "c".repeat(64),
        legacyPackage,
        "2026-08-10T09:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO local_point (
           account_id, crew_id, session_id, point_id, external_id, street, house_number,
           latitude, longitude, point_type, state, server_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "account-legacy",
        "crew-legacy",
        "session-legacy",
        "point-legacy",
        "point-external-legacy",
        "Los Aromos",
        "120",
        -0.45,
        -0.67,
        "DWELLING",
        "VOLVER",
        0,
      );
    database
      .prepare(
        `INSERT INTO outbox (
           account_id, crew_id, session_id, operation_id, device_id, device_sequence,
           point_id, base_version, depends_on_operation_id, previous_state, to_state,
           state, created_at, result_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)`,
      )
      .run(
        "account-legacy",
        "crew-legacy",
        "session-legacy",
        "operation-pending",
        "device-legacy",
        1,
        "point-legacy",
        0,
        null,
        "SIN_VISITAR",
        "VOLVER",
        "2026-08-10T09:01:00.000Z",
      );

    const migrations = await planPackageMigrations(
      database
        .prepare(`SELECT rowid AS "rowId", package_json AS "packageJson" FROM local_context`)
        .all() as Array<Record<string, unknown>>,
      true,
    );
    database.exec(migrationSql);
    const updatePackage = database.prepare(
      `UPDATE local_context SET package_json = ?, package_sha256 = ? WHERE rowid = ?`,
    );
    for (const migration of migrations) {
      updatePackage.run(migration.packageJson, migration.packageSha256, migration.rowId);
    }
    database.exec(migrationV3ToV4Sql);
    database.exec(migrationV4ToV5Sql);
    database.exec(migrationV5ToV6Sql);
    database.exec("PRAGMA user_version = 6");
    expect(database.prepare("SELECT operation_id AS id, state FROM outbox").get()).toEqual({
      id: "operation-pending",
      state: "PENDING",
    });
    database.exec(migrationV6ToV8Sql);
    database.exec("PRAGMA user_version = 8");
    database.close();
    database = new DatabaseSync(databasePath);

    const reopenedContext = database
      .prepare(
        `SELECT package_json AS "packageJson", package_sha256 AS "packageSha256"
         FROM local_context WHERE session_id = 'session-legacy'`,
      )
      .get() as { packageJson: string; packageSha256: string };
    const normalizedPackage = JSON.parse(reopenedContext.packageJson) as {
      context: { segmentCount: number };
      contractVersion: string;
      segments: unknown[];
    };
    expect(normalizedPackage).toMatchObject({
      contractVersion: "p0-provisional-v2",
      context: { segmentCount: 0 },
      segments: [],
    });
    expect(reopenedContext.packageSha256).toBe(migrations[0]?.packageSha256);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(
      database
        .prepare(
          `SELECT point_id AS "pointId", state, server_state AS "serverState" FROM local_point
           WHERE session_id = 'session-legacy'`,
        )
        .get(),
    ).toEqual({ pointId: "point-legacy", serverState: "SIN_VISITAR", state: "VOLVER" });
    expect(
      database
        .prepare(
          `SELECT operation_id AS "operationId", point_id AS "pointId", state,
                  work_session_id AS "workSessionId"
           FROM outbox WHERE session_id = 'session-legacy'`,
        )
        .get(),
    ).toEqual({
      operationId: "operation-pending",
      pointId: "point-legacy",
      state: "PENDING",
      workSessionId: null,
    });
    expect(database.prepare("SELECT count(*) AS count FROM local_work_session").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT count(*) AS count FROM h40_run").get()).toEqual({ count: 0 });
  });

  it("fails closed when migrating unaccredited v7 H40 runs to v8", () => {
    database = new DatabaseSync(":memory:");
    database.exec(localSchema);
    database
      .prepare(
        `INSERT INTO local_context (
           account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
           route_name, content_hash, package_json, package_sha256, work_session_id, installed_at
         ) VALUES (?, 'crew-a', 'session-a', 'campaign-a', 'route-a', 'revision-a',
                   'Ruta', ?, '{}', ?, 'work-a', ?)`,
      )
      .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_work_session (
           account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
           status, version, started_at, finished_at, session_json, saved_at
         ) VALUES (?, 'crew-a', 'session-a', 'work-a', 'campaign-a', 'ACTIVE', 1,
                   ?, NULL, '{}', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:00:00.000Z", "2026-08-21T10:00:00.000Z");
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
      CREATE TABLE h40_run (
        run_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        crew_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_session_id TEXT NOT NULL,
        device_alias TEXT NOT NULL CHECK (device_alias IN ('A','B')),
        build_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('RUNNING','FINISHED','ABORTED')),
        recovered_sending INTEGER NOT NULL DEFAULT 0,
        salt TEXT NOT NULL,
        UNIQUE (run_id, account_id, crew_id, session_id, work_session_id),
        FOREIGN KEY (account_id, crew_id, session_id)
          REFERENCES local_context(account_id, crew_id, session_id),
        FOREIGN KEY (account_id, crew_id, work_session_id)
          REFERENCES local_work_session(account_id, crew_id, work_session_id)
      ) STRICT;
      PRAGMA user_version = 7;
    `);
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id, device_alias,
           build_id, started_at, ended_at, status, recovered_sending, salt
         ) VALUES ('run-v7', ?, 'crew-a', 'session-a', 'work-a', 'A', 'field-41',
                   ?, NULL, 'RUNNING', 2, ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:01:00.000Z", "d".repeat(64));
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id, device_alias,
           build_id, started_at, ended_at, status, recovered_sending, salt
         ) VALUES ('finished-v7', ?, 'crew-a', 'session-a', 'work-a', 'B', 'field-41',
                   ?, ?, 'FINISHED', 0, ?)`,
      )
      .run("a".repeat(64), "2026-08-21T09:00:00.000Z", "2026-08-21T09:30:00.000Z", "e".repeat(64));

    database.exec(`BEGIN IMMEDIATE; ${migrationV7ToV8Sql} PRAGMA user_version = 8; COMMIT;`);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(
      database
        .prepare(
          `SELECT run_id AS "runId", recovered_sending AS recovered,
                  device_id AS "deviceId", membership_id AS "membershipId",
                  exported_at AS "exportedAt", final_projection_json AS projection,
                  final_outbox_json AS outbox,
                  status, ended_at AS "endedAt"
           FROM h40_run ORDER BY run_id`,
        )
        .all(),
    ).toEqual([
      {
        deviceId: null,
        endedAt: "2026-08-21T09:30:00.000Z",
        exportedAt: null,
        membershipId: null,
        outbox: null,
        projection: null,
        recovered: 0,
        runId: "finished-v7",
        status: "ABORTED",
      },
      {
        deviceId: null,
        endedAt: "2026-08-21T10:01:00.000Z",
        exportedAt: null,
        membershipId: null,
        outbox: null,
        projection: null,
        recovered: 2,
        runId: "run-v7",
        status: "ABORTED",
      },
    ]);
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id,
           device_id, membership_id, device_alias, build_id, started_at,
           ended_at, status, recovered_sending, salt,
           final_projection_json, final_outbox_json
         ) VALUES (?, ?, 'crew-a', 'session-a', 'work-a', ?, ?, 'A', 'field-42',
                   ?, ?, ?, 0, ?, NULL, NULL)`,
      )
      .run(
        "finished-without-snapshot",
        "a".repeat(64),
        "device-a",
        "membership-a",
        "2026-08-21T11:00:00.000Z",
        "2026-08-21T11:30:00.000Z",
        "FINISHED",
        "f".repeat(64),
      );
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id,
           device_id, membership_id, device_alias, build_id, started_at,
           ended_at, status, recovered_sending, salt,
           final_projection_json, final_outbox_json
         ) VALUES (?, ?, 'crew-a', 'session-a', 'work-a', NULL, NULL, 'A', 'field-42',
                   ?, NULL, 'RUNNING', 0, ?, NULL, NULL)`,
      )
      .run("running-without-actor", "a".repeat(64), "2026-08-21T12:00:00.000Z", "1".repeat(64));
    expect(
      getLatestH40Run(databaseHandle(database), {
        accountId: "a".repeat(64),
        crewId: "crew-a",
        sessionId: "session-a",
        workSessionId: "work-a",
      }),
    ).toBeNull();
  });

  it("repairs a persisted v8 H40 table created before recovered_sending", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "rutacuadrilla-field-h40-pre-recovery-"));
    const databasePath = join(temporaryDirectory, "field.sqlite3");
    database = new DatabaseSync(databasePath);
    database.exec(localSchema);
    database.exec("PRAGMA user_version = 8");
    database
      .prepare(
        `INSERT INTO local_context (
           account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
           route_name, content_hash, package_json, package_sha256, work_session_id, installed_at
         ) VALUES (?, 'crew-a', 'session-a', 'campaign-a', 'route-a', 'revision-a',
                   'Ruta', ?, '{}', ?, 'work-a', ?)`,
      )
      .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_work_session (
           account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
           status, version, started_at, finished_at, session_json, saved_at
         ) VALUES (?, 'crew-a', 'session-a', 'work-a', 'campaign-a', 'ACTIVE', 1,
                   ?, NULL, '{}', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:00:00.000Z", "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_point (
           account_id, crew_id, session_id, point_id, external_id, latitude, longitude,
           display_order, point_type, state, server_state, server_version
         ) VALUES (?, 'crew-a', 'session-a', 'point-a', 'external-a', -0.45, -0.67,
                   0, 'DWELLING', 'VOLVER', 'VOLVER', 1)`,
      )
      .run("a".repeat(64));
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id,
           device_id, membership_id, device_alias, build_id,
           started_at, ended_at, status, salt
         ) VALUES ('run-pre-recovery', ?, 'crew-a', 'session-a', 'work-a',
                   'device-a', 'membership-a', 'A', 'build-42', ?, NULL, 'RUNNING', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:01:00.000Z", "d".repeat(64));
    database
      .prepare(
        `INSERT INTO outbox (
           account_id, crew_id, session_id, operation_id, device_id, device_sequence,
           point_id, base_version, work_session_id, previous_state, to_state, state, created_at
         ) VALUES (?, 'crew-a', 'session-a', 'operation-sending', 'device-a', 1,
                   'point-a', 1, 'work-a', 'SIN_VISITAR', 'VOLVER', 'SENDING', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:02:00.000Z");
    database
      .prepare(
        `INSERT INTO h40_run_operation (
           run_id, account_id, crew_id, session_id, work_session_id, operation_id,
           action_kind, visual_ms, persist_ms, recorded_at
         ) VALUES ('run-pre-recovery', ?, 'crew-a', 'session-a', 'work-a',
                   'operation-sending', 'MARK', NULL, NULL, ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:02:00.000Z");
    database.exec(`
      DROP TRIGGER h40_run_update_guard;
      ALTER TABLE h40_run DROP COLUMN recovered_sending;
    `);
    database.close();
    database = new DatabaseSync(databasePath);

    expect(() => recoverSends(databaseHandle(database as DatabaseSync))).toThrow(
      /no such column: recovered_sending/,
    );
    expect(repairSameVersionH40SchemaV8(databaseHandle(database))).toBe(true);
    database.exec(localSchema);
    expect(recoverSends(databaseHandle(database))).toBe(1);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(
      database
        .prepare(
          `SELECT run_id AS "runId", recovered_sending AS "recoveredSending"
           FROM h40_run`,
        )
        .get(),
    ).toEqual({ recoveredSending: 1, runId: "run-pre-recovery" });
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "PENDING" });

    database.close();
    database = new DatabaseSync(databasePath);
    expect(repairSameVersionH40SchemaV8(databaseHandle(database))).toBe(false);
    database.exec(localSchema);
    expect(recoverSends(databaseHandle(database))).toBe(0);
    expect(database.prepare("SELECT count(*) AS count FROM h40_run").get()).toEqual({ count: 1 });
  });

  it("repairs a persisted intermediate v8 shape and invalidates unbound evidence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "rutacuadrilla-field-h40-v8-shape-"));
    const databasePath = join(temporaryDirectory, "field.sqlite3");
    database = new DatabaseSync(databasePath);
    database.exec(localSchema);
    database
      .prepare(
        `INSERT INTO local_context (
           account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
           route_name, content_hash, package_json, package_sha256, work_session_id, installed_at
         ) VALUES (?, 'crew-a', 'session-a', 'campaign-a', 'route-a', 'revision-a',
                   'Ruta', ?, '{}', ?, 'work-a', ?)`,
      )
      .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_work_session (
           account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
           status, version, started_at, finished_at, session_json, saved_at
         ) VALUES (?, 'crew-a', 'session-a', 'work-a', 'campaign-a', 'ACTIVE', 1,
                   ?, NULL, '{}', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:00:00.000Z", "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_point (
           account_id, crew_id, session_id, point_id, external_id, latitude, longitude,
           display_order, point_type, state, server_state, server_version
         ) VALUES (?, 'crew-a', 'session-a', 'point-a', 'external-a', -0.45, -0.67,
                   0, 'DWELLING', 'VOLVER', 'VOLVER', 1)`,
      )
      .run("a".repeat(64));
    database
      .prepare(
        `INSERT INTO outbox (
           account_id, crew_id, session_id, operation_id, device_id, device_sequence,
           point_id, base_version, work_session_id, previous_state, to_state, state, created_at
         ) VALUES (?, 'crew-a', 'session-a', 'operation-preserved', 'device-a', 1,
                   'point-a', 1, 'work-a', 'SIN_VISITAR', 'VOLVER', 'PENDING', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:02:00.000Z");
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
      CREATE TABLE h40_run (
        run_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        crew_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        work_session_id TEXT NOT NULL,
        device_alias TEXT NOT NULL CHECK (device_alias IN ('A','B')),
        build_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('RUNNING','FINISHED','ABORTED')),
        salt TEXT NOT NULL,
        UNIQUE (run_id, account_id, crew_id, session_id, work_session_id),
        FOREIGN KEY (account_id, crew_id, session_id)
          REFERENCES local_context(account_id, crew_id, session_id),
        FOREIGN KEY (account_id, crew_id, work_session_id)
          REFERENCES local_work_session(account_id, crew_id, work_session_id)
      ) STRICT;
      PRAGMA user_version = 8;
    `);
    const insertLegacyRun = database.prepare(
      `INSERT INTO h40_run (
         run_id, account_id, crew_id, session_id, work_session_id, device_alias,
         build_id, started_at, ended_at, status, salt
       ) VALUES (?, ?, 'crew-a', 'session-a', 'work-a', ?, 'build-intermediate',
                 ?, ?, ?, ?)`,
    );
    insertLegacyRun.run(
      "run-finished-intermediate",
      "a".repeat(64),
      "A",
      "2026-08-21T09:00:00.000Z",
      "2026-08-21T09:30:00.000Z",
      "FINISHED",
      "d".repeat(64),
    );
    insertLegacyRun.run(
      "run-running-intermediate",
      "a".repeat(64),
      "B",
      "2026-08-21T10:01:00.000Z",
      null,
      "RUNNING",
      "e".repeat(64),
    );
    database.close();
    database = new DatabaseSync(databasePath);

    expect(repairSameVersionH40SchemaV8(databaseHandle(database))).toBe(true);
    database.exec(localSchema);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      database
        .prepare("PRAGMA table_info('h40_run')")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).toEqual(
      expect.arrayContaining([
        "recovered_sending",
        "device_id",
        "membership_id",
        "exported_at",
        "final_projection_json",
        "final_outbox_json",
      ]),
    );
    expect(
      database
        .prepare(
          `SELECT run_id AS "runId", status, ended_at AS "endedAt",
                  recovered_sending AS "recoveredSending", device_id AS "deviceId",
                  membership_id AS "membershipId", exported_at AS "exportedAt",
                  final_projection_json AS projection, final_outbox_json AS outbox
           FROM h40_run ORDER BY run_id`,
        )
        .all(),
    ).toEqual([
      {
        deviceId: null,
        endedAt: "2026-08-21T09:30:00.000Z",
        exportedAt: null,
        membershipId: null,
        outbox: null,
        projection: null,
        recoveredSending: 0,
        runId: "run-finished-intermediate",
        status: "ABORTED",
      },
      {
        deviceId: null,
        endedAt: "2026-08-21T10:01:00.000Z",
        exportedAt: null,
        membershipId: null,
        outbox: null,
        projection: null,
        recoveredSending: 0,
        runId: "run-running-intermediate",
        status: "ABORTED",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT operation_id AS "operationId", device_id AS "deviceId", state
           FROM outbox`,
        )
        .get(),
    ).toEqual({ deviceId: "device-a", operationId: "operation-preserved", state: "PENDING" });

    database.close();
    database = new DatabaseSync(databasePath);
    expect(repairSameVersionH40SchemaV8(databaseHandle(database))).toBe(false);
    database.exec(localSchema);
    expect(database.prepare("SELECT count(*) AS count FROM h40_run").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM outbox").get()).toEqual({ count: 1 });
  });

  it("persists an H40 run after closing and reopening the local file", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "rutacuadrilla-field-h40-"));
    const databasePath = join(temporaryDirectory, "field.sqlite3");
    database = new DatabaseSync(databasePath);
    database.exec(localSchema);
    database.exec("PRAGMA user_version = 8");
    database
      .prepare(
        `INSERT INTO local_context (
           account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
           route_name, content_hash, package_json, package_sha256, work_session_id, installed_at
         ) VALUES (?, 'crew-a', 'session-a', 'campaign-a', 'route-a', 'revision-a',
                   'Ruta', ?, '{}', ?, 'work-a', ?)`,
      )
      .run("a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO local_work_session (
           account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
           status, version, started_at, finished_at, session_json, saved_at
         ) VALUES (?, 'crew-a', 'session-a', 'work-a', 'campaign-a', 'ACTIVE', 1,
                   ?, NULL, '{}', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:00:00.000Z", "2026-08-21T10:00:00.000Z");
    database
      .prepare(
        `INSERT INTO h40_run (
           run_id, account_id, crew_id, session_id, work_session_id,
           device_id, membership_id, device_alias, build_id,
           started_at, ended_at, status, salt
         ) VALUES ('run-persisted', ?, 'crew-a', 'session-a', 'work-a',
                   'device-a', 'membership-a', 'A', 'build-42', ?, NULL, 'RUNNING', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:01:00.000Z", "d".repeat(64));
    database
      .prepare(
        `INSERT INTO local_point (
           account_id, crew_id, session_id, point_id, external_id, latitude, longitude,
           display_order, point_type, state, server_state, server_version
         ) VALUES (?, 'crew-a', 'session-a', 'point-a', 'external-a', -0.45, -0.67,
                   0, 'DWELLING', 'VOLVER', 'VOLVER', 1)`,
      )
      .run("a".repeat(64));
    database
      .prepare(
        `INSERT INTO outbox (
           account_id, crew_id, session_id, operation_id, device_id, device_sequence,
           point_id, base_version, work_session_id, previous_state, to_state, state, created_at
         ) VALUES (?, 'crew-a', 'session-a', 'operation-sending', 'device-a', 1,
                   'point-a', 1, 'work-a', 'SIN_VISITAR', 'VOLVER', 'SENDING', ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:02:00.000Z");
    database
      .prepare(
        `INSERT INTO h40_run_operation (
           run_id, account_id, crew_id, session_id, work_session_id, operation_id,
           action_kind, visual_ms, persist_ms, recorded_at
         ) VALUES ('run-persisted', ?, 'crew-a', 'session-a', 'work-a',
                   'operation-sending', 'MARK', NULL, NULL, ?)`,
      )
      .run("a".repeat(64), "2026-08-21T10:02:00.000Z");
    database.close();
    database = new DatabaseSync(databasePath);

    expect(recoverSends(databaseHandle(database))).toBe(1);

    expect(
      database
        .prepare(
          `SELECT run_id AS "runId", device_alias AS alias, build_id AS "buildId", status,
                  recovered_sending AS "recoveredSending"
           FROM h40_run`,
        )
        .get(),
    ).toEqual({
      alias: "A",
      buildId: "build-42",
      recoveredSending: 1,
      runId: "run-persisted",
      status: "RUNNING",
    });
    expect(database.prepare("SELECT state FROM outbox").get()).toEqual({ state: "PENDING" });
    database.close();
    database = new DatabaseSync(databasePath);
    expect(recoverSends(databaseHandle(database))).toBe(0);
    expect(database.prepare("SELECT recovered_sending AS count FROM h40_run").get()).toEqual({
      count: 1,
    });
    database.prepare("UPDATE outbox SET state = 'CONFIRMED'").run();
    database
      .prepare(
        `UPDATE h40_run_operation SET visual_ms = 9, persist_ms = 8
         WHERE operation_id = 'operation-sending'`,
      )
      .run();
    const insertOperation = database.prepare(
      `INSERT INTO outbox (
         account_id, crew_id, session_id, operation_id, device_id, device_sequence,
         point_id, base_version, work_session_id, previous_state, to_state, state, created_at
       ) VALUES (?, 'crew-a', 'session-a', ?, 'device-a', ?, 'point-a', 1, 'work-a',
                 'VOLVER', 'APORTO', 'CONFIRMED', ?)`,
    );
    const insertH40Operation = database.prepare(
      `INSERT INTO h40_run_operation (
         run_id, account_id, crew_id, session_id, work_session_id, operation_id,
         action_kind, visual_ms, persist_ms, recorded_at
       ) VALUES ('run-persisted', ?, 'crew-a', 'session-a', 'work-a', ?,
                 'MARK', ?, ?, ?)`,
    );
    for (let index = 0; index < 30; index += 1) {
      const operationId = `operation-h40-${String(index).padStart(2, "0")}`;
      const recordedAt = new Date(Date.parse("2026-08-21T10:03:00.000Z") + index).toISOString();
      insertOperation.run("a".repeat(64), operationId, index + 2, recordedAt);
      insertH40Operation.run("a".repeat(64), operationId, 10 + index, 5 + index, recordedAt);
    }
    const context = {
      accountId: "a".repeat(64),
      crewId: "crew-a",
      sessionId: "session-a",
      workSessionId: "work-a",
    };
    expect(
      finishH40Run(databaseHandle(database), { ...context, runId: "run-persisted" }),
    ).toMatchObject({ finished: true, summary: { status: "FINISHED" } });
    const evidenceAtFinish = getH40Evidence(databaseHandle(database), {
      ...context,
      runId: "run-persisted",
    });
    database.close();
    database = new DatabaseSync(databasePath);

    expect(getLatestH40Run(databaseHandle(database), context)).toMatchObject({
      runId: "run-persisted",
      status: "FINISHED",
    });
    expect(
      getH40Evidence(databaseHandle(database), { ...context, runId: "run-persisted" }),
    ).toEqual(evidenceAtFinish);
    database
      .prepare(
        `UPDATE local_point
         SET state = 'NO_PARTICIPA', server_state = 'NO_PARTICIPA', server_version = 99`,
      )
      .run();
    database
      .prepare("UPDATE outbox SET state = 'REJECTED' WHERE operation_id = 'operation-sending'")
      .run();
    expect(
      getH40Evidence(databaseHandle(database), { ...context, runId: "run-persisted" }),
    ).toEqual(evidenceAtFinish);
    expect(
      markH40RunExported(databaseHandle(database), { ...context, runId: "run-persisted" }),
    ).toMatchObject({ status: "FINISHED" });
    database.close();
    database = new DatabaseSync(databasePath);
    expect(getLatestH40Run(databaseHandle(database), context)).toBeNull();
    expect(
      getH40Evidence(databaseHandle(database), { ...context, runId: "run-persisted" }),
    ).toEqual(evidenceAtFinish);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("migrates a populated v1 outbox and assigns stable point order per context", () => {
    database = new DatabaseSync(":memory:");
    database.exec(V1_SCHEMA);

    const insertContext = database.prepare(
      `INSERT INTO local_context (
         account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
         route_name, content_hash, package_json, installed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertContext.run(
      "account-1",
      "crew-1",
      "session-1",
      "campaign-1",
      "route-1",
      "revision-1",
      "Ruta uno",
      "a".repeat(64),
      '{"points":[]}',
      "2026-08-10T10:00:00.000Z",
    );
    insertContext.run(
      "account-1",
      "crew-1",
      "session-2",
      "campaign-2",
      "route-2",
      "revision-2",
      "Ruta dos",
      "b".repeat(64),
      '{"points":[]}',
      "2026-08-10T11:00:00.000Z",
    );

    const insertPoint = database.prepare(
      `INSERT INTO local_point (
         account_id, crew_id, session_id, point_id, external_id, street, house_number,
         latitude, longitude, point_type, state, server_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertPoint.run(
      "account-1",
      "crew-1",
      "session-1",
      "point-z",
      "external-z",
      "Calle Z",
      "10",
      -0.45,
      -0.67,
      "DWELLING",
      "SIN_VISITAR",
      0,
    );
    insertPoint.run(
      "account-1",
      "crew-1",
      "session-1",
      "point-a",
      "external-a",
      "Calle A",
      "20",
      -0.46,
      -0.68,
      "DWELLING",
      "SOBRE_ENTREGADO",
      2,
    );
    insertPoint.run(
      "account-1",
      "crew-1",
      "session-2",
      "point-m",
      "external-m",
      null,
      null,
      -0.47,
      -0.69,
      "SPECIAL",
      "VOLVER",
      1,
    );

    const insertOperation = database.prepare(
      `INSERT INTO outbox (
         account_id, crew_id, session_id, operation_id, device_id, device_sequence,
         point_id, base_version, depends_on_operation_id, previous_state, to_state,
         state, created_at, result_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertOperation.run(
      "account-1",
      "crew-1",
      "session-1",
      "operation-1",
      "device-1",
      1,
      "point-z",
      0,
      null,
      "SIN_VISITAR",
      "SOBRE_ENTREGADO",
      "CONFIRMED",
      "2026-08-10T10:01:00.000Z",
      '{"status":"APPLIED"}',
    );
    insertOperation.run(
      "account-1",
      "crew-1",
      "session-1",
      "operation-2",
      "device-1",
      2,
      "point-a",
      2,
      "operation-1",
      "SOBRE_ENTREGADO",
      "VOLVER",
      "PENDING",
      "2026-08-10T10:02:00.000Z",
      null,
    );

    database.exec(migrationSql);

    const points = database
      .prepare(
        `SELECT session_id AS sessionId, point_id AS pointId, display_order AS displayOrder
         FROM local_point ORDER BY rowid`,
      )
      .all() as Array<{ displayOrder: number; pointId: string; sessionId: string }>;
    expect(points).toEqual([
      { displayOrder: 0, pointId: "point-z", sessionId: "session-1" },
      { displayOrder: 1, pointId: "point-a", sessionId: "session-1" },
      { displayOrder: 0, pointId: "point-m", sessionId: "session-2" },
    ]);

    const operations = database
      .prepare(
        `SELECT operation_id AS operationId, depends_on_operation_id AS dependsOn,
                undoes_operation_id AS undoes, state, result_json AS resultJson
         FROM outbox ORDER BY device_sequence`,
      )
      .all() as Array<{
      dependsOn: string | null;
      operationId: string;
      resultJson: string | null;
      state: string;
      undoes: string | null;
    }>;
    expect(operations).toEqual([
      {
        dependsOn: null,
        operationId: "operation-1",
        resultJson: '{"status":"APPLIED"}',
        state: "CONFIRMED",
        undoes: null,
      },
      {
        dependsOn: "operation-1",
        operationId: "operation-2",
        resultJson: null,
        state: "PENDING",
        undoes: null,
      },
    ]);

    const newColumns = database
      .prepare(
        `SELECT name, dflt_value AS "defaultValue", "notnull" AS "notNull"
         FROM pragma_table_info('local_point') WHERE name = 'display_order'
         UNION ALL
         SELECT name, dflt_value AS "defaultValue", "notnull" AS "notNull"
         FROM pragma_table_info('local_context') WHERE name = 'package_sha256'`,
      )
      .all() as Array<{ defaultValue: string; name: string; notNull: number }>;
    expect(newColumns).toEqual([
      { defaultValue: "0", name: "display_order", notNull: 1 },
      { defaultValue: "''", name: "package_sha256", notNull: 1 },
    ]);
    expect(database.prepare("SELECT package_sha256 FROM local_context LIMIT 1").get()).toEqual({
      package_sha256: "",
    });
    expect(() => database?.exec("UPDATE local_point SET display_order = -1")).toThrow(/CHECK/u);
  });
});
