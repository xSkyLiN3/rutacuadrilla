/// <reference lib="webworker" />

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { normalizeFieldSegments } from "../streetSide";
import type {
  ConflictResolutionDecision,
  FieldContextPackage,
  FieldPoint,
  FieldSegment,
  LocalOperation,
  LocalWorkSession,
  PointState,
  SyncOperationResult,
} from "../types";
import type {
  H40ActionKind,
  H40ContextKey,
  H40EvidenceSource,
  H40FinishResult,
  H40LatencySummary,
  H40MetricInput,
  H40MetricRecord,
  H40RunSummary,
  LocalDatabaseRequest,
  LocalDatabaseResponse,
} from "./protocol";

export interface DatabaseHandle {
  close?(): void;
  exec(sql: string | { bind?: unknown[]; sql: string }): unknown;
  selectObject(sql: string, bind?: unknown[]): Record<string, unknown> | undefined;
  selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
  selectValue(sql: string, bind?: unknown[]): unknown;
  transaction<T>(callback: (database: DatabaseHandle) => T): T;
}

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
export const LOCAL_SCHEMA_VERSION = 8;
let database: DatabaseHandle | undefined;
let persistent = false;
let startupRecoveryReport = { integrity: "ok" as const, requeuedSending: 0 };
let initializationPromise:
  | Promise<{
      persistent: boolean;
      recovery: { integrity: "ok"; requeuedSending: number };
      schemaVersion: number;
    }>
  | undefined;

export const H40_SCHEMA_V8 = `
  CREATE TABLE IF NOT EXISTS h40_run (
    run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 64),
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    work_session_id TEXT NOT NULL,
    device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 256),
    membership_id TEXT NOT NULL CHECK (length(membership_id) BETWEEN 1 AND 256),
    device_alias TEXT NOT NULL CHECK (device_alias IN ('A','B')),
    build_id TEXT NOT NULL CHECK (length(build_id) BETWEEN 1 AND 100),
    started_at TEXT NOT NULL CHECK (length(started_at) BETWEEN 20 AND 40),
    ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) BETWEEN 20 AND 40),
    status TEXT NOT NULL CHECK (status IN ('RUNNING','FINISHED','ABORTED')),
    recovered_sending INTEGER NOT NULL DEFAULT 0 CHECK (recovered_sending >= 0),
    exported_at TEXT CHECK (exported_at IS NULL OR length(exported_at) BETWEEN 20 AND 40),
    final_projection_json TEXT CHECK (
      final_projection_json IS NULL OR (
        json_valid(final_projection_json) AND json_type(final_projection_json) = 'array'
      )
    ),
    final_outbox_json TEXT CHECK (
      final_outbox_json IS NULL OR (
        json_valid(final_outbox_json) AND json_type(final_outbox_json) = 'object'
      )
    ),
    salt TEXT NOT NULL CHECK (
      length(salt) BETWEEN 32 AND 128
      AND length(salt) % 2 = 0
      AND salt NOT GLOB '*[^0-9a-f]*'
    ),
    UNIQUE (run_id, account_id, crew_id, session_id, work_session_id),
    FOREIGN KEY (account_id, crew_id, session_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, crew_id, work_session_id)
      REFERENCES local_work_session(account_id, crew_id, work_session_id) ON DELETE CASCADE,
    CHECK (
      (status = 'RUNNING' AND ended_at IS NULL
        AND exported_at IS NULL
        AND final_projection_json IS NULL AND final_outbox_json IS NULL)
      OR (status = 'ABORTED' AND ended_at IS NOT NULL
        AND exported_at IS NULL
        AND final_projection_json IS NULL AND final_outbox_json IS NULL)
      OR (status = 'FINISHED' AND ended_at IS NOT NULL
        AND final_projection_json IS NOT NULL AND final_outbox_json IS NOT NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS h40_one_running_context_idx
    ON h40_run (account_id, crew_id, session_id, work_session_id)
    WHERE status = 'RUNNING';

  CREATE TABLE IF NOT EXISTS h40_run_operation (
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    work_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('MARK','UNDO')),
    visual_ms REAL CHECK (visual_ms IS NULL OR (visual_ms >= 0 AND visual_ms <= 600000)),
    persist_ms REAL CHECK (persist_ms IS NULL OR (persist_ms >= 0 AND persist_ms <= 600000)),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
    PRIMARY KEY (run_id, operation_id),
    FOREIGN KEY (run_id, account_id, crew_id, session_id, work_session_id)
      REFERENCES h40_run(run_id, account_id, crew_id, session_id, work_session_id)
      ON DELETE CASCADE,
    FOREIGN KEY (account_id, crew_id, operation_id)
      REFERENCES outbox(account_id, crew_id, operation_id) ON DELETE RESTRICT,
    CHECK ((visual_ms IS NULL AND persist_ms IS NULL)
      OR (visual_ms IS NOT NULL AND persist_ms IS NOT NULL))
  ) STRICT;

  CREATE INDEX IF NOT EXISTS h40_run_operation_context_idx
    ON h40_run_operation (account_id, crew_id, session_id, work_session_id, run_id);

  CREATE TRIGGER IF NOT EXISTS h40_run_operation_limit
  BEFORE INSERT ON h40_run_operation
  WHEN (SELECT count(*) FROM h40_run_operation WHERE run_id = NEW.run_id) >= 500
  BEGIN
    SELECT RAISE(ABORT, 'H40_ACTION_LIMIT_REACHED');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_run_operation_complete_once
  BEFORE UPDATE OF visual_ms, persist_ms ON h40_run_operation
  WHEN OLD.visual_ms IS NOT NULL OR OLD.persist_ms IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'H40_ACTION_ALREADY_COMPLETED');
  END;

  CREATE TABLE IF NOT EXISTS h40_metric (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    event_kind TEXT NOT NULL CHECK (
      event_kind IN ('OFFLINE_START','OFFLINE_END','BOOT','SYNC_START','SYNC_END','RECOVERY')
    ),
    wall_at TEXT NOT NULL CHECK (length(wall_at) BETWEEN 20 AND 40),
    monotonic_ms REAL CHECK (
      monotonic_ms IS NULL OR (monotonic_ms >= 0 AND monotonic_ms <= 9007199254740991)
    ),
    pending INTEGER CHECK (pending IS NULL OR pending >= 0),
    applied INTEGER CHECK (applied IS NULL OR applied >= 0),
    conflict INTEGER CHECK (conflict IS NULL OR conflict >= 0),
    rejected INTEGER CHECK (rejected IS NULL OR rejected >= 0),
    replayed INTEGER CHECK (replayed IS NULL OR replayed >= 0),
    error_code TEXT CHECK (
      error_code IS NULL OR (
        length(error_code) BETWEEN 1 AND 64
        AND error_code NOT GLOB '*[^A-Z0-9_]*'
      )
    ),
    PRIMARY KEY (run_id, seq),
    FOREIGN KEY (run_id) REFERENCES h40_run(run_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS h40_metric_no_update
  BEFORE UPDATE ON h40_metric
  BEGIN
    SELECT RAISE(ABORT, 'H40_METRIC_APPEND_ONLY');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_metric_no_direct_delete
  BEFORE DELETE ON h40_metric
  WHEN EXISTS (SELECT 1 FROM h40_run WHERE run_id = OLD.run_id)
  BEGIN
    SELECT RAISE(ABORT, 'H40_METRIC_APPEND_ONLY');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_run_operation_update_guard
  BEFORE UPDATE ON h40_run_operation
  WHEN NEW.run_id <> OLD.run_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.crew_id <> OLD.crew_id
    OR NEW.session_id <> OLD.session_id
    OR NEW.work_session_id <> OLD.work_session_id
    OR NEW.operation_id <> OLD.operation_id
    OR NEW.action_kind <> OLD.action_kind
    OR NEW.recorded_at <> OLD.recorded_at
    OR (
      OLD.visual_ms IS NULL AND OLD.persist_ms IS NULL
      AND (NEW.visual_ms IS NULL OR NEW.persist_ms IS NULL)
    )
  BEGIN
    SELECT RAISE(ABORT, 'H40_ACTION_EVIDENCE_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_run_operation_no_direct_delete
  BEFORE DELETE ON h40_run_operation
  WHEN EXISTS (SELECT 1 FROM h40_run WHERE run_id = OLD.run_id)
  BEGIN
    SELECT RAISE(ABORT, 'H40_ACTION_EVIDENCE_APPEND_ONLY');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_run_update_guard
  BEFORE UPDATE ON h40_run
  WHEN NEW.run_id <> OLD.run_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.crew_id <> OLD.crew_id
    OR NEW.session_id <> OLD.session_id
    OR NEW.work_session_id <> OLD.work_session_id
    OR NEW.device_id IS NOT OLD.device_id
    OR NEW.membership_id IS NOT OLD.membership_id
    OR NEW.device_alias <> OLD.device_alias
    OR NEW.build_id <> OLD.build_id
    OR NEW.started_at <> OLD.started_at
    OR NEW.salt <> OLD.salt
    OR NOT (
      (
        OLD.status = 'RUNNING' AND NEW.status = 'RUNNING'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NULL
        AND NEW.recovered_sending > OLD.recovered_sending
        AND NEW.exported_at IS OLD.exported_at
        AND NEW.final_projection_json IS OLD.final_projection_json
        AND NEW.final_outbox_json IS OLD.final_outbox_json
      )
      OR (
        OLD.status = 'RUNNING' AND NEW.status = 'FINISHED'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NULL
        AND OLD.final_projection_json IS NULL AND NEW.final_projection_json IS NOT NULL
        AND OLD.final_outbox_json IS NULL AND NEW.final_outbox_json IS NOT NULL
      )
      OR (
        OLD.status = 'RUNNING' AND NEW.status = 'ABORTED'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NULL
        AND OLD.final_projection_json IS NULL AND NEW.final_projection_json IS NULL
        AND OLD.final_outbox_json IS NULL AND NEW.final_outbox_json IS NULL
      )
      OR (
        OLD.status = 'FINISHED' AND NEW.status = 'FINISHED'
        AND NEW.ended_at IS OLD.ended_at
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
        AND NEW.final_projection_json IS OLD.final_projection_json
        AND NEW.final_outbox_json IS OLD.final_outbox_json
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'H40_RUN_EVIDENCE_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS h40_run_no_delete_while_running
  BEFORE DELETE ON h40_run
  WHEN OLD.status = 'RUNNING'
  BEGIN
    SELECT RAISE(ABORT, 'H40_RUNNING_RUN_CANNOT_DELETE');
  END;
`;

export const LOCAL_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS local_context (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    route_revision_id TEXT NOT NULL,
    route_name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    package_json TEXT NOT NULL,
    package_sha256 TEXT NOT NULL,
    work_session_id TEXT,
    installed_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, session_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS local_work_session (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    campaign_route_id TEXT NOT NULL,
    work_session_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','FINISHED')),
    version INTEGER NOT NULL CHECK (version > 0),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    session_json TEXT NOT NULL CHECK (json_valid(session_json)),
    saved_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, work_session_id),
    UNIQUE (account_id, crew_id, campaign_route_id, work_session_id),
    FOREIGN KEY (account_id, crew_id, campaign_route_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE,
    CHECK ((status = 'ACTIVE' AND finished_at IS NULL)
      OR (status = 'FINISHED' AND finished_at IS NOT NULL))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS local_point (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    point_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    street TEXT,
    house_number TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    point_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA')),
    server_state TEXT NOT NULL CHECK (server_state IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA')),
    server_version INTEGER NOT NULL CHECK (server_version >= 0),
    PRIMARY KEY (account_id, crew_id, session_id, point_id),
    FOREIGN KEY (account_id, crew_id, session_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS outbox (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_sequence INTEGER NOT NULL CHECK (device_sequence > 0),
    point_id TEXT NOT NULL,
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    depends_on_operation_id TEXT,
    undoes_operation_id TEXT,
    resolves_operation_id TEXT,
    work_session_id TEXT,
    previous_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING','SENDING','CONFIRMED','CONFLICT','REJECTED','SUPERSEDED')),
    created_at TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (account_id, crew_id, operation_id),
    UNIQUE (account_id, crew_id, device_id, device_sequence),
    FOREIGN KEY (account_id, crew_id, session_id, point_id)
      REFERENCES local_point(account_id, crew_id, session_id, point_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS outbox_pending_idx
    ON outbox (account_id, crew_id, session_id, state, device_sequence);

  CREATE INDEX IF NOT EXISTS outbox_legacy_work_session_idx
    ON outbox (account_id, crew_id, session_id, state)
    WHERE work_session_id IS NULL;

  CREATE TABLE IF NOT EXISTS sync_cursor (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, session_id),
    FOREIGN KEY (account_id, crew_id, session_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS local_identity_binding (
    partition_id TEXT PRIMARY KEY
      CHECK (partition_id NOT GLOB '*[^0-9a-f]*' AND length(partition_id) = 64),
    subject_binding TEXT NOT NULL UNIQUE
      CHECK (subject_binding NOT GLOB '*[^0-9a-f]*' AND length(subject_binding) = 64),
    bound_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS local_conflict_resolution (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    resolution_id TEXT NOT NULL,
    conflict_operation_id TEXT NOT NULL,
    resolution_operation_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('ACCEPT_SERVER','REAPPLY_LOCAL')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    canonical_state TEXT NOT NULL
      CHECK (canonical_state IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA')),
    canonical_version INTEGER NOT NULL CHECK (canonical_version >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, resolution_id),
    UNIQUE (account_id, crew_id, conflict_operation_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS local_conflict_resolution_no_update
  BEFORE UPDATE ON local_conflict_resolution
  BEGIN
    SELECT RAISE(ABORT, 'LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY');
  END;

  CREATE TRIGGER IF NOT EXISTS local_conflict_resolution_no_delete
  BEFORE DELETE ON local_conflict_resolution
  BEGIN
    SELECT RAISE(ABORT, 'LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY');
  END;

  ${H40_SCHEMA_V8}

`;

export const MIGRATE_V1_TO_V2 = `
  ALTER TABLE local_context ADD COLUMN package_sha256 TEXT NOT NULL DEFAULT '';
  ALTER TABLE local_point
    ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0);
  WITH ordered_points AS (
    SELECT
      rowid AS point_rowid,
      row_number() OVER (
        PARTITION BY account_id, crew_id, session_id
        ORDER BY rowid
      ) - 1 AS migrated_display_order
    FROM local_point
  )
  UPDATE local_point
  SET display_order = (
    SELECT migrated_display_order
    FROM ordered_points
    WHERE ordered_points.point_rowid = local_point.rowid
  );
  DROP INDEX IF EXISTS outbox_pending_idx;
  ALTER TABLE outbox RENAME TO outbox_v1;
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
    undoes_operation_id TEXT,
    previous_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING','SENDING','CONFIRMED','CONFLICT','REJECTED','SUPERSEDED')),
    created_at TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY (account_id, crew_id, operation_id),
    UNIQUE (account_id, crew_id, device_id, device_sequence),
    FOREIGN KEY (account_id, crew_id, session_id, point_id)
      REFERENCES local_point(account_id, crew_id, session_id, point_id) ON DELETE RESTRICT
  ) STRICT;
  INSERT INTO outbox (
    account_id, crew_id, session_id, operation_id, device_id, device_sequence,
    point_id, base_version, depends_on_operation_id, undoes_operation_id,
    previous_state, to_state, state, created_at, result_json
  )
  SELECT
    account_id, crew_id, session_id, operation_id, device_id, device_sequence,
    point_id, base_version, depends_on_operation_id, NULL,
    previous_state, to_state, state, created_at, result_json
  FROM outbox_v1;
  DROP TABLE outbox_v1;
  CREATE INDEX outbox_pending_idx
    ON outbox (account_id, crew_id, session_id, state, device_sequence);
`;

export const MIGRATE_V3_TO_V4 = `
  ALTER TABLE outbox ADD COLUMN resolves_operation_id TEXT;

  CREATE TABLE local_identity_binding (
    partition_id TEXT PRIMARY KEY
      CHECK (partition_id NOT GLOB '*[^0-9a-f]*' AND length(partition_id) = 64),
    subject_binding TEXT NOT NULL UNIQUE
      CHECK (subject_binding NOT GLOB '*[^0-9a-f]*' AND length(subject_binding) = 64),
    bound_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE local_conflict_resolution (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    resolution_id TEXT NOT NULL,
    conflict_operation_id TEXT NOT NULL,
    resolution_operation_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('ACCEPT_SERVER','REAPPLY_LOCAL')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
    canonical_state TEXT NOT NULL
      CHECK (canonical_state IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA')),
    canonical_version INTEGER NOT NULL CHECK (canonical_version >= 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, resolution_id),
    UNIQUE (account_id, crew_id, conflict_operation_id)
  ) STRICT;

  CREATE TRIGGER local_conflict_resolution_no_update
  BEFORE UPDATE ON local_conflict_resolution
  BEGIN
    SELECT RAISE(ABORT, 'LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY');
  END;

  CREATE TRIGGER local_conflict_resolution_no_delete
  BEFORE DELETE ON local_conflict_resolution
  BEGIN
    SELECT RAISE(ABORT, 'LOCAL_CONFLICT_RESOLUTION_APPEND_ONLY');
  END;
`;

export const MIGRATE_V4_TO_V5 = `
  ALTER TABLE local_point
    ADD COLUMN server_state TEXT NOT NULL DEFAULT 'SIN_VISITAR'
      CHECK (server_state IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA'));

  UPDATE local_point
  SET server_state = coalesce(
    (
      SELECT coalesce(
        json_extract(operation.result_json, '$.canonicalState'),
        json_extract(operation.result_json, '$.state')
      )
      FROM outbox operation
      WHERE operation.account_id = local_point.account_id
        AND operation.crew_id = local_point.crew_id
        AND operation.session_id = local_point.session_id
        AND operation.point_id = local_point.point_id
        AND json_valid(operation.result_json)
        AND coalesce(
          json_extract(operation.result_json, '$.canonicalVersion'),
          json_extract(operation.result_json, '$.version')
        ) = local_point.server_version
        AND coalesce(
          json_extract(operation.result_json, '$.canonicalState'),
          json_extract(operation.result_json, '$.state')
        ) IN ('SIN_VISITAR','SOBRE_ENTREGADO','VOLVER','SIN_RESPUESTA','APORTO','NO_PARTICIPA')
      ORDER BY operation.device_sequence DESC
      LIMIT 1
    ),
    (
      SELECT operation.previous_state
      FROM outbox operation
      WHERE operation.account_id = local_point.account_id
        AND operation.crew_id = local_point.crew_id
        AND operation.session_id = local_point.session_id
        AND operation.point_id = local_point.point_id
        AND operation.state IN ('PENDING','SENDING','CONFLICT','REJECTED')
      ORDER BY operation.device_sequence ASC
      LIMIT 1
    ),
    state
  );
`;

export const MIGRATE_V5_TO_V6 = `
  ALTER TABLE local_context ADD COLUMN work_session_id TEXT;
  ALTER TABLE outbox ADD COLUMN work_session_id TEXT;

  CREATE TABLE local_work_session (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    campaign_route_id TEXT NOT NULL,
    work_session_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','FINISHED')),
    version INTEGER NOT NULL CHECK (version > 0),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    session_json TEXT NOT NULL CHECK (json_valid(session_json)),
    saved_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, work_session_id),
    UNIQUE (account_id, crew_id, campaign_route_id, work_session_id),
    FOREIGN KEY (account_id, crew_id, campaign_route_id)
      REFERENCES local_context(account_id, crew_id, session_id) ON DELETE CASCADE,
    CHECK ((status = 'ACTIVE' AND finished_at IS NULL)
      OR (status = 'FINISHED' AND finished_at IS NOT NULL))
  ) STRICT;

  CREATE INDEX outbox_legacy_work_session_idx
    ON outbox (account_id, crew_id, session_id, state)
    WHERE work_session_id IS NULL;
`;

export const MIGRATE_V6_TO_V8 = H40_SCHEMA_V8;

export const MIGRATE_V7_TO_V8 = `
  ALTER TABLE h40_run ADD COLUMN device_id TEXT CHECK (
    device_id IS NULL OR length(device_id) BETWEEN 1 AND 256
  );
  ALTER TABLE h40_run ADD COLUMN membership_id TEXT CHECK (
    membership_id IS NULL OR length(membership_id) BETWEEN 1 AND 256
  );
  ALTER TABLE h40_run ADD COLUMN exported_at TEXT CHECK (
    exported_at IS NULL OR length(exported_at) BETWEEN 20 AND 40
  );
  ALTER TABLE h40_run ADD COLUMN final_projection_json TEXT CHECK (
    final_projection_json IS NULL OR (
      json_valid(final_projection_json) AND json_type(final_projection_json) = 'array'
    )
  );
  ALTER TABLE h40_run ADD COLUMN final_outbox_json TEXT CHECK (
    final_outbox_json IS NULL OR (
      json_valid(final_outbox_json) AND json_type(final_outbox_json) = 'object'
    )
  );

  DROP TRIGGER IF EXISTS h40_run_update_guard;

  -- Version 7 did not bind runs to a device/membership and did not freeze
  -- evidence at finish. Those rows cannot be accredited safely in v8.
  UPDATE h40_run
  SET status = 'ABORTED', ended_at = coalesce(ended_at, started_at)
  WHERE status IN ('RUNNING','FINISHED');

  CREATE TRIGGER h40_run_update_guard
  BEFORE UPDATE ON h40_run
  WHEN NEW.run_id <> OLD.run_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.crew_id <> OLD.crew_id
    OR NEW.session_id <> OLD.session_id
    OR NEW.work_session_id <> OLD.work_session_id
    OR NEW.device_id IS NOT OLD.device_id
    OR NEW.membership_id IS NOT OLD.membership_id
    OR NEW.device_alias <> OLD.device_alias
    OR NEW.build_id <> OLD.build_id
    OR NEW.started_at <> OLD.started_at
    OR NEW.salt <> OLD.salt
    OR NOT (
      (
        OLD.status = 'RUNNING' AND NEW.status = 'RUNNING'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NULL
        AND NEW.recovered_sending > OLD.recovered_sending
        AND NEW.exported_at IS OLD.exported_at
        AND NEW.final_projection_json IS OLD.final_projection_json
        AND NEW.final_outbox_json IS OLD.final_outbox_json
      )
      OR (
        OLD.status = 'RUNNING' AND NEW.status = 'FINISHED'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NULL
        AND OLD.final_projection_json IS NULL AND NEW.final_projection_json IS NOT NULL
        AND OLD.final_outbox_json IS NULL AND NEW.final_outbox_json IS NOT NULL
      )
      OR (
        OLD.status = 'RUNNING' AND NEW.status = 'ABORTED'
        AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NULL
        AND OLD.final_projection_json IS NULL AND NEW.final_projection_json IS NULL
        AND OLD.final_outbox_json IS NULL AND NEW.final_outbox_json IS NULL
      )
      OR (
        OLD.status = 'FINISHED' AND NEW.status = 'FINISHED'
        AND NEW.ended_at IS OLD.ended_at
        AND NEW.recovered_sending = OLD.recovered_sending
        AND OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
        AND NEW.final_projection_json IS OLD.final_projection_json
        AND NEW.final_outbox_json IS OLD.final_outbox_json
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'H40_RUN_EVIDENCE_IMMUTABLE');
  END;
`;

function requireDatabase(): DatabaseHandle {
  if (!database) throw new Error("LOCAL_DATABASE_NOT_INITIALIZED");
  return database;
}

function exec(sql: string, bind: unknown[] = []): void {
  requireDatabase().exec({ sql, bind });
}

function asPoint(row: Record<string, unknown>): FieldPoint {
  return {
    id: String(row.id),
    externalId: String(row.externalId),
    displayOrder: Number(row.displayOrder),
    ...(row.street ? { street: String(row.street) } : {}),
    ...(row.number ? { number: String(row.number) } : {}),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    pointType: String(row.pointType),
    state: String(row.state) as FieldPoint["state"],
    version: Number(row.version),
  };
}

function asOperation(row: Record<string, unknown>): LocalOperation {
  let result: {
    canonicalState?: PointState;
    canonicalVersion?: number;
    code?: string;
    state?: PointState;
    version?: number;
  } = {};
  try {
    result = row.resultJson ? (JSON.parse(String(row.resultJson)) as typeof result) : {};
  } catch {
    result = {};
  }
  const receiptState = result.canonicalState ?? result.state;
  const receiptVersion = result.canonicalVersion ?? result.version;
  const receiptCanonical =
    isPointState(receiptState) && Number.isInteger(receiptVersion) && Number(receiptVersion) >= 0
      ? { state: receiptState, version: Number(receiptVersion) }
      : undefined;
  const pointCanonical =
    isPointState(row.pointCanonicalState) &&
    Number.isInteger(row.pointCanonicalVersion) &&
    Number(row.pointCanonicalVersion) >= 0
      ? { state: row.pointCanonicalState, version: Number(row.pointCanonicalVersion) }
      : undefined;
  const canonical =
    pointCanonical && (!receiptCanonical || pointCanonical.version >= receiptCanonical.version)
      ? pointCanonical
      : receiptCanonical;
  const canonicalState = canonical?.state;
  const canonicalVersion = canonical?.version;
  const resolutionConverged =
    String(row.state) === "SUPERSEDED" &&
    Boolean(row.resolvesOperationId) &&
    result.code === "NO_STATE_CHANGE" &&
    receiptCanonical?.state === String(row.toState);
  return {
    accountId: String(row.accountId),
    aggregateId: String(row.aggregateId),
    baseVersion: Number(row.baseVersion),
    crewId: String(row.crewId),
    ...(canonicalState ? { canonicalState } : {}),
    ...(canonicalVersion !== undefined ? { canonicalVersion } : {}),
    ...(result.code ? { conflictCode: result.code } : {}),
    ...(row.dependsOnOperationId ? { dependsOnOperationId: String(row.dependsOnOperationId) } : {}),
    deviceId: String(row.deviceId),
    deviceSequence: Number(row.deviceSequence),
    operationId: String(row.operationId),
    previousState: String(row.previousState) as LocalOperation["previousState"],
    ...(row.resolutionDecision
      ? { resolutionDecision: String(row.resolutionDecision) as ConflictResolutionDecision }
      : {}),
    ...(resolutionConverged ? { resolutionConverged: true } : {}),
    ...(row.resolutionOperationId
      ? { resolutionOperationId: String(row.resolutionOperationId) }
      : {}),
    ...(row.resolutionOperationState
      ? {
          resolutionOperationState: String(row.resolutionOperationState) as LocalOperation["state"],
        }
      : {}),
    ...(row.resolutionReason ? { resolutionReason: String(row.resolutionReason) } : {}),
    ...(row.resolvesOperationId ? { resolvesOperationId: String(row.resolvesOperationId) } : {}),
    state: String(row.state) as LocalOperation["state"],
    toState: String(row.toState) as LocalOperation["toState"],
    ...(row.undoesOperationId ? { undoesOperationId: String(row.undoesOperationId) } : {}),
    ...(row.workSessionId ? { workSessionId: String(row.workSessionId) } : {}),
  };
}

const H40_SCHEMA_V8_ADDITIVE_COLUMNS = [
  {
    name: "recovered_sending",
    sql: `ALTER TABLE h40_run
            ADD COLUMN recovered_sending INTEGER NOT NULL DEFAULT 0
              CHECK (recovered_sending >= 0)`,
    preservesAccreditation: true,
  },
  {
    name: "device_id",
    sql: `ALTER TABLE h40_run ADD COLUMN device_id TEXT CHECK (
            device_id IS NULL OR length(device_id) BETWEEN 1 AND 256
          )`,
    preservesAccreditation: false,
  },
  {
    name: "membership_id",
    sql: `ALTER TABLE h40_run ADD COLUMN membership_id TEXT CHECK (
            membership_id IS NULL OR length(membership_id) BETWEEN 1 AND 256
          )`,
    preservesAccreditation: false,
  },
  {
    name: "exported_at",
    sql: `ALTER TABLE h40_run ADD COLUMN exported_at TEXT CHECK (
            exported_at IS NULL OR length(exported_at) BETWEEN 20 AND 40
          )`,
    preservesAccreditation: false,
  },
  {
    name: "final_projection_json",
    sql: `ALTER TABLE h40_run ADD COLUMN final_projection_json TEXT CHECK (
            final_projection_json IS NULL OR (
              json_valid(final_projection_json)
              AND json_type(final_projection_json) = 'array'
            )
          )`,
    preservesAccreditation: false,
  },
  {
    name: "final_outbox_json",
    sql: `ALTER TABLE h40_run ADD COLUMN final_outbox_json TEXT CHECK (
            final_outbox_json IS NULL OR (
              json_valid(final_outbox_json)
              AND json_type(final_outbox_json) = 'object'
            )
          )`,
    preservesAccreditation: false,
  },
] as const;

export function repairSameVersionH40SchemaV8(db: DatabaseHandle): boolean {
  return db.transaction((transaction) => {
    const columns = transaction.selectObjects("PRAGMA table_info('h40_run')");
    if (columns.length === 0) return false;

    const existingNames = new Set(columns.map((column) => String(column.name)));
    const missingColumns = H40_SCHEMA_V8_ADDITIVE_COLUMNS.filter(
      (column) => !existingNames.has(column.name),
    );
    if (missingColumns.length === 0) return false;

    // Some pre-release databases were already marked v8 while h40_run still had
    // an intermediate shape. CREATE TABLE IF NOT EXISTS cannot evolve it.
    transaction.exec("DROP TRIGGER IF EXISTS h40_run_update_guard");
    for (const column of missingColumns) transaction.exec(column.sql);

    if (missingColumns.some((column) => !column.preservesAccreditation)) {
      // Actor binding and frozen snapshots are accreditation boundaries. Runs
      // created without any of those fields remain stored but cannot count as
      // valid H40 evidence, matching the v7 -> v8 fail-closed policy.
      transaction.exec(`UPDATE h40_run
                        SET status = 'ABORTED',
                            ended_at = coalesce(ended_at, started_at),
                            exported_at = NULL,
                            final_projection_json = NULL,
                            final_outbox_json = NULL
                        WHERE status IN ('RUNNING','FINISHED')`);
    }
    return true;
  });
}

async function initialize(): Promise<{
  persistent: boolean;
  recovery: { integrity: "ok"; requeuedSending: number };
  schemaVersion: number;
}> {
  if (database) {
    return {
      persistent,
      recovery: startupRecoveryReport,
      schemaVersion: Number(database.selectValue("PRAGMA user_version")),
    };
  }
  if (!initializationPromise) initializationPromise = initializeOnce();
  try {
    return await initializationPromise;
  } catch (error) {
    initializationPromise = undefined;
    throw error;
  }
}

async function initializeOnce(): Promise<{
  persistent: boolean;
  recovery: { integrity: "ok"; requeuedSending: number };
  schemaVersion: number;
}> {
  const sqlite3 = await sqlite3InitModule();
  const OpfsDb = sqlite3.oo1.OpfsDb;
  const nextPersistent = typeof OpfsDb === "function";
  const openedDatabase = (nextPersistent
    ? new OpfsDb("/rutacuadrilla-field.sqlite3", "c")
    : new sqlite3.oo1.DB(":memory:", "c")) as unknown as DatabaseHandle;
  try {
    const previousVersion = Number(openedDatabase.selectValue("PRAGMA user_version"));
    if (previousVersion > LOCAL_SCHEMA_VERSION) {
      throw new Error("UNSUPPORTED_LOCAL_SCHEMA_VERSION");
    }
    if (previousVersion === LOCAL_SCHEMA_VERSION) {
      repairSameVersionH40SchemaV8(openedDatabase);
    }
    const packageMigrations =
      previousVersion === 1 || previousVersion === 2
        ? await planLocalPackageV3Migrations(
            openedDatabase.selectObjects(
              `SELECT rowid AS "rowId", package_json AS "packageJson" FROM local_context`,
            ),
            previousVersion === 1,
          )
        : [];
    if (previousVersion === 1) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V1_TO_V2);
        for (const migration of packageMigrations) {
          transaction.exec({
            sql: `UPDATE local_context
                  SET package_json = ?, package_sha256 = ?
                  WHERE rowid = ?`,
            bind: [migration.packageJson, migration.packageSha256, migration.rowId],
          });
        }
        transaction.exec(MIGRATE_V3_TO_V4);
        transaction.exec(MIGRATE_V4_TO_V5);
        transaction.exec(MIGRATE_V5_TO_V6);
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 2) {
      openedDatabase.transaction((transaction) => {
        for (const migration of packageMigrations) {
          transaction.exec({
            sql: `UPDATE local_context
                  SET package_json = ?, package_sha256 = ?
                  WHERE rowid = ?`,
            bind: [migration.packageJson, migration.packageSha256, migration.rowId],
          });
        }
        transaction.exec(MIGRATE_V3_TO_V4);
        transaction.exec(MIGRATE_V4_TO_V5);
        transaction.exec(MIGRATE_V5_TO_V6);
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 3) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V3_TO_V4);
        transaction.exec(MIGRATE_V4_TO_V5);
        transaction.exec(MIGRATE_V5_TO_V6);
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 4) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V4_TO_V5);
        transaction.exec(MIGRATE_V5_TO_V6);
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 5) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V5_TO_V6);
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 6) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V6_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 7) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(MIGRATE_V7_TO_V8);
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else if (previousVersion === 0) {
      openedDatabase.transaction((transaction) => {
        transaction.exec(LOCAL_SCHEMA);
        transaction.exec(`PRAGMA user_version = ${LOCAL_SCHEMA_VERSION}`);
      });
    } else {
      openedDatabase.exec(LOCAL_SCHEMA);
    }
    const integrity = String(openedDatabase.selectValue("PRAGMA quick_check"));
    if (integrity !== "ok") throw new Error("LOCAL_DATABASE_INTEGRITY_CHECK_FAILED");
    const requeuedSending = recoverInterruptedSends(openedDatabase);
    database = openedDatabase;
    persistent = nextPersistent;
    startupRecoveryReport = { integrity: "ok", requeuedSending };
    return {
      persistent,
      recovery: startupRecoveryReport,
      schemaVersion: Number(openedDatabase.selectValue("PRAGMA user_version")),
    };
  } catch (error) {
    openedDatabase.close?.();
    database = undefined;
    persistent = false;
    startupRecoveryReport = { integrity: "ok", requeuedSending: 0 };
    throw error;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function recoverInterruptedSends(db: DatabaseHandle): number {
  return db.transaction((transaction) => {
    transaction.exec(
      `UPDATE h40_run AS run
       SET recovered_sending = recovered_sending + (
         SELECT count(*)
         FROM h40_run_operation evidence
         JOIN outbox operation
           ON operation.account_id = evidence.account_id
          AND operation.crew_id = evidence.crew_id
          AND operation.operation_id = evidence.operation_id
         WHERE evidence.run_id = run.run_id
           AND operation.account_id = run.account_id
           AND operation.crew_id = run.crew_id
           AND operation.session_id = run.session_id
           AND operation.work_session_id = run.work_session_id
           AND operation.device_id = run.device_id
           AND operation.state = 'SENDING'
       )
       WHERE run.status = 'RUNNING'
         AND EXISTS (
           SELECT 1
           FROM h40_run_operation evidence
           JOIN outbox operation
             ON operation.account_id = evidence.account_id
            AND operation.crew_id = evidence.crew_id
            AND operation.operation_id = evidence.operation_id
           WHERE evidence.run_id = run.run_id
             AND operation.account_id = run.account_id
             AND operation.crew_id = run.crew_id
             AND operation.session_id = run.session_id
             AND operation.work_session_id = run.work_session_id
             AND operation.device_id = run.device_id
             AND operation.state = 'SENDING'
         )`,
    );
    transaction.exec("UPDATE outbox SET state = 'PENDING' WHERE state = 'SENDING'");
    return Number(transaction.selectValue("SELECT changes()"));
  });
}

function accountRowCount(db: DatabaseHandle, accountId: string): number {
  return Number(
    db.selectValue(
      `SELECT
         (SELECT count(*) FROM local_context WHERE account_id = ?) +
         (SELECT count(*) FROM local_work_session WHERE account_id = ?) +
         (SELECT count(*) FROM local_point WHERE account_id = ?) +
         (SELECT count(*) FROM outbox WHERE account_id = ?) +
         (SELECT count(*) FROM h40_run WHERE account_id = ?) +
         (SELECT count(*) FROM h40_run_operation WHERE account_id = ?) +
         (SELECT count(*) FROM sync_cursor WHERE account_id = ?)`,
      [accountId, accountId, accountId, accountId, accountId, accountId, accountId],
    ) ?? 0,
  );
}

export function bindLocalAccount(
  db: DatabaseHandle,
  input: { legacyAccountId: string; partitionId: string; subjectBinding: string },
): { bound: true; migratedContexts: number; migratedOperations: number } {
  if (
    !input.legacyAccountId ||
    !/^[0-9a-f]{64}$/u.test(input.partitionId) ||
    !/^[0-9a-f]{64}$/u.test(input.subjectBinding)
  ) {
    throw new Error("INVALID_LOCAL_IDENTITY_BINDING");
  }
  const existingBinding = db.selectObject(
    `SELECT subject_binding AS "subjectBinding"
     FROM local_identity_binding WHERE partition_id = ?`,
    [input.partitionId],
  );
  if (existingBinding && String(existingBinding.subjectBinding) !== input.subjectBinding) {
    throw new Error("LOCAL_PARTITION_OCCUPIED_BY_ANOTHER_IDENTITY");
  }
  const sameSubject = db.selectObject(
    `SELECT partition_id AS "partitionId"
     FROM local_identity_binding WHERE subject_binding = ?`,
    [input.subjectBinding],
  );
  if (sameSubject && String(sameSubject.partitionId) !== input.partitionId) {
    throw new Error("LOCAL_IDENTITY_ALREADY_BOUND_TO_ANOTHER_PARTITION");
  }

  const legacyRows = accountRowCount(db, input.legacyAccountId);
  const targetRows = accountRowCount(db, input.partitionId);
  if (targetRows > 0 && !existingBinding) {
    throw new Error("LOCAL_PARTITION_OCCUPIED_BY_UNBOUND_DATA");
  }
  if (legacyRows > 0 && targetRows > 0 && input.legacyAccountId !== input.partitionId) {
    throw new Error("LOCAL_PARTITION_MERGE_REJECTED");
  }
  const legacyResolutionRows = Number(
    db.selectValue("SELECT count(*) FROM local_conflict_resolution WHERE account_id = ?", [
      input.legacyAccountId,
    ]) ?? 0,
  );
  if (legacyResolutionRows > 0 && input.legacyAccountId !== input.partitionId) {
    throw new Error("LOCAL_APPEND_ONLY_AUDIT_REQUIRES_MANUAL_MIGRATION");
  }
  const legacyH40Rows = Number(
    db.selectValue("SELECT count(*) FROM h40_run WHERE account_id = ?", [input.legacyAccountId]) ??
      0,
  );
  if (legacyH40Rows > 0 && input.legacyAccountId !== input.partitionId) {
    throw new Error("LOCAL_H40_EVIDENCE_REQUIRES_MANUAL_MIGRATION");
  }
  const migratedContexts = Number(
    db.selectValue("SELECT count(*) FROM local_context WHERE account_id = ?", [
      input.legacyAccountId,
    ]) ?? 0,
  );
  const migratedOperations = Number(
    db.selectValue("SELECT count(*) FROM outbox WHERE account_id = ?", [input.legacyAccountId]) ??
      0,
  );

  db.transaction((transaction) => {
    transaction.exec("PRAGMA defer_foreign_keys = ON");
    if (!existingBinding) {
      transaction.exec({
        sql: `INSERT INTO local_identity_binding
                (partition_id, subject_binding, bound_at)
              VALUES (?, ?, ?)`,
        bind: [input.partitionId, input.subjectBinding, new Date().toISOString()],
      });
    }
    if (input.legacyAccountId !== input.partitionId && legacyRows > 0) {
      for (const table of [
        "local_context",
        "local_work_session",
        "local_point",
        "outbox",
        "h40_run",
        "h40_run_operation",
        "sync_cursor",
      ]) {
        transaction.exec({
          sql: `UPDATE ${table} SET account_id = ? WHERE account_id = ?`,
          bind: [input.partitionId, input.legacyAccountId],
        });
      }
    }
  });
  return { bound: true, migratedContexts, migratedOperations };
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function canonicalLocalWorkSession(session: LocalWorkSession): LocalWorkSession {
  return {
    campaignId: session.campaignId,
    campaignRouteId: session.campaignRouteId,
    devices: [...session.devices].sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId),
    ),
    ...(session.finishedAt !== undefined ? { finishedAt: session.finishedAt } : {}),
    ...(session.finishedByMembershipId !== undefined
      ? { finishedByMembershipId: session.finishedByMembershipId }
      : {}),
    id: session.id,
    participants: [...session.participants].sort((left, right) =>
      left.membershipId.localeCompare(right.membershipId),
    ),
    startedAt: session.startedAt,
    startedByDeviceId: session.startedByDeviceId,
    startedByMembershipId: session.startedByMembershipId,
    status: session.status,
    version: session.version,
  };
}

function validateLocalWorkSession(
  session: LocalWorkSession,
  campaignId: string,
  campaignRouteId: string,
): void {
  const participantIds = new Set(
    session.participants.map((participant) => participant.membershipId),
  );
  if (
    !session.id ||
    session.campaignId !== campaignId ||
    session.campaignRouteId !== campaignRouteId ||
    (session.status !== "ACTIVE" && session.status !== "FINISHED") ||
    !Number.isInteger(session.version) ||
    session.version < 1 ||
    !isIsoTimestamp(session.startedAt) ||
    !session.startedByDeviceId ||
    !session.startedByMembershipId ||
    !participantIds.has(session.startedByMembershipId) ||
    (session.status === "ACTIVE" && session.finishedAt !== undefined) ||
    (session.status === "FINISHED" && !isIsoTimestamp(session.finishedAt)) ||
    (session.finishedByMembershipId !== undefined &&
      !participantIds.has(session.finishedByMembershipId)) ||
    session.participants.length === 0 ||
    participantIds.size !== session.participants.length ||
    session.participants.some(
      (participant) =>
        !participant.displayName ||
        !participant.membershipId ||
        !isIsoTimestamp(participant.joinedAt) ||
        !["ASSISTANT", "DRIVER", "OTHER"].includes(participant.profile),
    ) ||
    new Set(session.devices.map((device) => device.deviceId)).size !== session.devices.length ||
    session.devices.some(
      (device) =>
        !device.deviceId ||
        !device.membershipId ||
        !isIsoTimestamp(device.joinedAt) ||
        !participantIds.has(device.membershipId),
    ) ||
    !session.devices.some(
      (device) =>
        device.deviceId === session.startedByDeviceId &&
        device.membershipId === session.startedByMembershipId,
    )
  ) {
    throw new Error("LOCAL_WORK_SESSION_INVALID");
  }
}

export function saveLocalWorkSession(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "save-work-session" }>,
): { legacyBlocked: number; saved: true } {
  const context = db.selectObject(
    `SELECT campaign_id AS "campaignId" FROM local_context
     WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
    [input.accountId, input.crewId, input.campaignRouteId],
  );
  if (!context) throw new Error("LOCAL_CONTEXT_NOT_FOUND");
  const session = canonicalLocalWorkSession(input.session);
  validateLocalWorkSession(session, String(context.campaignId), input.campaignRouteId);
  const serialized = JSON.stringify(session);
  const existing = db.selectObject(
    `SELECT version, status, session_json AS "sessionJson"
     FROM local_work_session
     WHERE account_id = ? AND crew_id = ? AND work_session_id = ?`,
    [input.accountId, input.crewId, session.id],
  );
  if (existing) {
    if (Number(existing.version) > session.version) {
      throw new Error("LOCAL_WORK_SESSION_VERSION_REGRESSION");
    }
    if (
      Number(existing.version) === session.version &&
      String(existing.sessionJson) !== serialized
    ) {
      throw new Error("LOCAL_WORK_SESSION_VERSION_REUSED");
    }
    if (String(existing.status) === "FINISHED" && session.status !== "FINISHED") {
      throw new Error("LOCAL_WORK_SESSION_STATUS_REGRESSION");
    }
  }
  db.transaction((transaction) => {
    transaction.exec({
      sql: `INSERT INTO local_work_session (
              account_id, crew_id, campaign_route_id, work_session_id, campaign_id,
              status, version, started_at, finished_at, session_json, saved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, crew_id, work_session_id) DO UPDATE SET
              status = excluded.status,
              version = excluded.version,
              finished_at = excluded.finished_at,
              session_json = excluded.session_json,
              saved_at = excluded.saved_at`,
      bind: [
        input.accountId,
        input.crewId,
        input.campaignRouteId,
        session.id,
        session.campaignId,
        session.status,
        session.version,
        session.startedAt,
        session.finishedAt ?? null,
        serialized,
        new Date().toISOString(),
      ],
    });
    transaction.exec({
      sql: `UPDATE local_context SET work_session_id = ?
            WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
      bind: [session.id, input.accountId, input.crewId, input.campaignRouteId],
    });
  });
  const legacyBlocked = Number(
    db.selectValue(
      `SELECT count(*) FROM outbox
       WHERE account_id = ? AND crew_id = ? AND session_id = ?
         AND work_session_id IS NULL
         AND state IN ('PENDING','SENDING','CONFLICT','REJECTED')`,
      [input.accountId, input.crewId, input.campaignRouteId],
    ) ?? 0,
  );
  return { legacyBlocked, saved: true };
}

function saveWorkSession(input: Extract<LocalDatabaseRequest, { type: "save-work-session" }>) {
  return saveLocalWorkSession(requireDatabase(), input);
}

export function getLocalOutboxStatus(
  db: DatabaseHandle,
  accountId: string,
  crewId: string,
  sessionId: string,
) {
  const row = db.selectObject(
    `SELECT
       count(*) FILTER (
         WHERE state IN ('PENDING','SENDING','CONFLICT','REJECTED')
       ) AS unresolved,
       count(*) FILTER (
         WHERE work_session_id IS NULL
           AND state IN ('PENDING','SENDING','CONFLICT','REJECTED')
       ) AS "legacyBlocked"
     FROM outbox
     WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
    [accountId, crewId, sessionId],
  );
  return {
    legacyBlocked: Number(row?.legacyBlocked ?? 0),
    unresolved: Number(row?.unresolved ?? 0),
  };
}

function getOutboxStatus(accountId: string, crewId: string, sessionId: string) {
  return getLocalOutboxStatus(requireDatabase(), accountId, crewId, sessionId);
}

type LocalPackageMigration = {
  packageJson: string;
  packageSha256: string;
  rowId: number;
};

function normalizeLegacyLocalPackage(packageJson: string): {
  migrated: boolean;
  packageJson: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(packageJson);
  } catch {
    return { migrated: false, packageJson };
  }
  if (!value || typeof value !== "object") return { migrated: false, packageJson };
  const legacy = value as Record<string, unknown>;
  if (
    legacy.contractVersion !== "p0-provisional-v1" ||
    Object.hasOwn(legacy, "segments") ||
    !legacy.context ||
    typeof legacy.context !== "object"
  ) {
    return { migrated: false, packageJson };
  }
  return {
    migrated: true,
    packageJson: JSON.stringify({
      ...legacy,
      contractVersion: "p0-provisional-v2",
      context: { ...(legacy.context as Record<string, unknown>), segmentCount: 0 },
      segments: [],
    }),
  };
}

export async function planLocalPackageV3Migrations(
  rows: Array<Record<string, unknown>>,
  backfillAll = false,
): Promise<LocalPackageMigration[]> {
  const migrations: LocalPackageMigration[] = [];
  for (const row of rows) {
    const normalized = normalizeLegacyLocalPackage(String(row.packageJson));
    if (!normalized.migrated && !backfillAll) continue;
    migrations.push({
      packageJson: normalized.packageJson,
      packageSha256: await sha256Hex(normalized.packageJson),
      rowId: Number(row.rowId),
    });
  }
  return migrations;
}

async function validatePackage(input: FieldContextPackage): Promise<void> {
  if (input.schemaVersion !== 1 || !/^[0-9a-f]{64}$/i.test(input.contentHash)) {
    throw new Error("INVALID_FIELD_PACKAGE");
  }
  if (
    !/^[0-9a-f]{64}$/i.test(input.transportSha256) ||
    (await sha256Hex(input.rawBody)) !== input.transportSha256.toLowerCase()
  ) {
    throw new Error("CORRUPT_FIELD_PACKAGE");
  }
  let raw: {
    contractVersion?: string;
    context?: {
      contentHash?: string;
      id?: string;
      routeRevisionId?: string;
      segmentCount?: number;
      vehicleId?: string;
      vehicleName?: string;
    };
    points?: Array<{ displayOrder?: number; id?: string; version?: number }>;
    segments?: unknown;
  };
  try {
    raw = JSON.parse(input.rawBody) as typeof raw;
  } catch {
    throw new Error("INVALID_FIELD_PACKAGE_JSON");
  }
  let rawSegments: FieldSegment[];
  try {
    rawSegments = normalizeFieldSegments(raw.segments);
  } catch {
    throw new Error("INVALID_FIELD_SEGMENTS");
  }
  if (
    raw.contractVersion !== "p0-provisional-v3" ||
    input.campaignRouteId !== input.sessionId ||
    raw.context?.id !== input.sessionId ||
    raw.context.routeRevisionId !== input.routeRevisionId ||
    raw.context.contentHash !== input.contentHash ||
    raw.context.vehicleId !== input.vehicleId ||
    raw.context.vehicleName !== input.vehicleName ||
    !Array.isArray(raw.points) ||
    !Array.isArray(raw.segments) ||
    raw.points.length !== input.points.length ||
    raw.context.segmentCount !== rawSegments.length ||
    rawSegments.length !== input.segments.length ||
    rawSegments.some((segment, index) => {
      const normalized = input.segments[index];
      return (
        !normalized ||
        segment.id !== normalized.id ||
        segment.externalId !== normalized.externalId ||
        segment.displayOrder !== normalized.displayOrder ||
        segment.streetSegmentVersionId !== normalized.streetSegmentVersionId ||
        segment.serviceSide !== normalized.serviceSide ||
        segment.source !== normalized.source ||
        segment.name !== normalized.name ||
        segment.sourceVersion !== normalized.sourceVersion ||
        segment.attribution !== normalized.attribution ||
        JSON.stringify(segment.geometry) !== JSON.stringify(normalized.geometry)
      );
    }) ||
    raw.points.some((point, index) => {
      const normalized = input.points[index];
      return (
        !normalized ||
        point.id !== normalized.id ||
        point.displayOrder !== normalized.displayOrder ||
        point.version !== normalized.version
      );
    })
  ) {
    throw new Error("FIELD_PACKAGE_IDENTITY_MISMATCH");
  }
  const pointIds = new Set(input.points.map((point) => point.id));
  if (pointIds.size !== input.points.length) throw new Error("DUPLICATE_PACKAGE_POINT");
}

async function installPackage(accountId: string, input: FieldContextPackage) {
  await validatePackage(input);
  const db = requireDatabase();
  const pending = Number(
    db.selectValue(
      `SELECT count(*) FROM outbox
       WHERE account_id = ? AND crew_id = ? AND session_id = ?
         AND state IN ('PENDING','SENDING','CONFLICT')`,
      [accountId, input.crewId, input.sessionId],
    ) ?? 0,
  );
  const previousHash = db.selectValue(
    `SELECT content_hash FROM local_context
     WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
    [accountId, input.crewId, input.sessionId],
  );
  if (previousHash && previousHash !== input.contentHash) {
    throw new Error(pending > 0 ? "LOCAL_OUTBOX_NOT_EMPTY" : "LOCAL_CONTEXT_IDENTITY_MISMATCH");
  }

  db.transaction(() => {
    exec(
      `INSERT INTO local_context (
         account_id, crew_id, session_id, campaign_id, route_id, route_revision_id,
         route_name, content_hash, package_json, package_sha256, installed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, crew_id, session_id) DO UPDATE SET
         campaign_id = excluded.campaign_id,
         route_id = excluded.route_id,
         route_revision_id = excluded.route_revision_id,
         route_name = excluded.route_name,
         content_hash = excluded.content_hash,
         package_json = excluded.package_json,
         package_sha256 = excluded.package_sha256,
         installed_at = excluded.installed_at`,
      [
        accountId,
        input.crewId,
        input.sessionId,
        input.campaignId,
        input.routeId,
        input.routeRevisionId,
        input.routeName,
        input.contentHash,
        input.rawBody,
        input.transportSha256,
        new Date().toISOString(),
      ],
    );
    for (const point of input.points) {
      const pointHasUnresolvedOperation =
        Number(
          db.selectValue(
            `SELECT count(*) FROM outbox
             WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
               AND state IN ('PENDING','SENDING','CONFLICT','REJECTED')`,
            [accountId, input.crewId, input.sessionId, point.id],
          ),
        ) > 0;
      exec(
        `INSERT INTO local_point (
            account_id, crew_id, session_id, point_id, external_id, street, house_number,
            latitude, longitude, display_order, point_type, state, server_state, server_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, crew_id, session_id, point_id) DO UPDATE SET
           external_id = excluded.external_id,
           street = excluded.street,
           house_number = excluded.house_number,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           display_order = excluded.display_order,
           point_type = excluded.point_type,
            state = CASE
              WHEN ? = 0 AND excluded.server_version >= local_point.server_version
                THEN excluded.state
              ELSE local_point.state
            END,
            server_state = CASE
              WHEN excluded.server_version > local_point.server_version
                THEN excluded.server_state
              ELSE local_point.server_state
            END,
            server_version = CASE
              WHEN excluded.server_version > local_point.server_version
                THEN excluded.server_version
              ELSE local_point.server_version
            END`,
        [
          accountId,
          input.crewId,
          input.sessionId,
          point.id,
          point.externalId,
          point.street ?? null,
          point.number ?? null,
          point.latitude,
          point.longitude,
          point.displayOrder,
          point.pointType,
          point.state,
          point.state,
          point.version,
          pointHasUnresolvedOperation ? 1 : 0,
        ],
      );
    }
    exec(
      `INSERT INTO sync_cursor (account_id, crew_id, session_id, cursor_value)
       VALUES (?, ?, ?, '')
       ON CONFLICT (account_id, crew_id, session_id) DO NOTHING`,
      [accountId, input.crewId, input.sessionId],
    );
  });
  return { installed: true as const, pointCount: input.points.length };
}

export const SELECT_LOCAL_CONTEXT_SQL = `
    SELECT c.campaign_id AS "campaignId", c.content_hash AS "contentHash",
             c.crew_id AS "crewId", c.route_name AS "routeName",
             c.route_revision_id AS "routeRevisionId", c.package_json AS "packageJson",
             c.package_sha256 AS "packageSha256", c.session_id AS "sessionId",
             work_session.session_json AS "workSessionJson",
            (SELECT count(*) FROM local_point p
             WHERE p.account_id = c.account_id AND p.crew_id = c.crew_id
               AND p.session_id = c.session_id) AS "pointCount"
      FROM local_context c
      LEFT JOIN local_work_session work_session
       ON work_session.account_id = c.account_id
       AND work_session.crew_id = c.crew_id
       AND work_session.work_session_id = c.work_session_id
     WHERE c.account_id = ? AND c.crew_id = ? AND c.session_id = ?`;

async function getContext(accountId: string, crewId: string, sessionId: string) {
  const row = requireDatabase().selectObject(SELECT_LOCAL_CONTEXT_SQL, [
    accountId,
    crewId,
    sessionId,
  ]);
  if (!row) throw new Error("LOCAL_CONTEXT_NOT_FOUND");
  if ((await sha256Hex(String(row.packageJson))) !== String(row.packageSha256)) {
    throw new Error("CORRUPT_FIELD_PACKAGE");
  }
  let segments: FieldSegment[];
  let vehicleId: string | undefined;
  let vehicleName: string | undefined;
  let workSession: LocalWorkSession | undefined;
  try {
    const raw = JSON.parse(String(row.packageJson)) as {
      context?: { vehicleId?: unknown; vehicleName?: unknown };
      segments?: unknown;
    };
    segments = normalizeFieldSegments(raw.segments);
    if (
      !raw.context ||
      !(
        (raw.context.vehicleId === undefined && raw.context.vehicleName === undefined) ||
        (typeof raw.context.vehicleId === "string" &&
          raw.context.vehicleId.length > 0 &&
          typeof raw.context.vehicleName === "string" &&
          raw.context.vehicleName.length > 0)
      )
    ) {
      throw new Error("CORRUPT_FIELD_PACKAGE_VEHICLE");
    }
    vehicleId = raw.context.vehicleId;
    vehicleName = raw.context.vehicleName;
  } catch {
    throw new Error("CORRUPT_FIELD_PACKAGE_SEGMENTS");
  }
  if (row.workSessionJson) {
    try {
      workSession = JSON.parse(String(row.workSessionJson)) as LocalWorkSession;
      validateLocalWorkSession(workSession, String(row.campaignId), String(row.sessionId));
    } catch {
      throw new Error("CORRUPT_LOCAL_WORK_SESSION");
    }
  }
  return {
    campaignId: String(row.campaignId),
    campaignRouteId: String(row.sessionId),
    contentHash: String(row.contentHash),
    crewId: String(row.crewId),
    pointCount: Number(row.pointCount),
    routeName: String(row.routeName),
    routeRevisionId: String(row.routeRevisionId),
    segmentCount: segments.length,
    segments,
    sessionId: String(row.sessionId),
    ...(workSession ? { workSession } : {}),
    ...(vehicleId ? { vehicleId } : {}),
    ...(vehicleName ? { vehicleName } : {}),
  };
}

function listPoints(accountId: string, crewId: string, sessionId: string): FieldPoint[] {
  return requireDatabase()
    .selectObjects(
      `SELECT point_id AS id, external_id AS "externalId", display_order AS "displayOrder", street,
              house_number AS number, latitude, longitude, point_type AS "pointType",
              state, server_version AS version
       FROM local_point
       WHERE account_id = ? AND crew_id = ? AND session_id = ?
       ORDER BY display_order, point_id`,
      [accountId, crewId, sessionId],
    )
    .map(asPoint);
}

function clearAccount(accountId: string) {
  const unresolved = Number(
    requireDatabase().selectValue(
      `SELECT count(*) FROM outbox
       WHERE account_id = ? AND state IN ('PENDING','SENDING','CONFLICT','REJECTED')`,
      [accountId],
    ),
  );
  if (unresolved > 0) throw new Error("LOCAL_OUTBOX_UNRESOLVED");
  const auditRows = Number(
    requireDatabase().selectValue(
      "SELECT count(*) FROM local_conflict_resolution WHERE account_id = ?",
      [accountId],
    ) ?? 0,
  );
  if (auditRows > 0) throw new Error("LOCAL_APPEND_ONLY_AUDIT_RETAINED");
  requireDatabase().transaction(() => {
    exec(
      `UPDATE h40_run SET status = 'ABORTED', ended_at = ?
       WHERE account_id = ? AND status = 'RUNNING'`,
      [new Date().toISOString(), accountId],
    );
    exec("DELETE FROM h40_run WHERE account_id = ?", [accountId]);
    exec("DELETE FROM outbox WHERE account_id = ?", [accountId]);
    exec("DELETE FROM local_context WHERE account_id = ?", [accountId]);
  });
  return { cleared: true as const };
}

function requireJoinedActiveWorkSession(
  db: DatabaseHandle,
  input: {
    accountId: string;
    crewId: string;
    deviceId: string;
    membershipId: string;
    sessionId: string;
    workSessionId: string;
  },
): LocalWorkSession {
  const row = db.selectObject(
    `SELECT work_session.session_json AS "sessionJson"
     FROM local_context context
     JOIN local_work_session work_session
       ON work_session.account_id = context.account_id
      AND work_session.crew_id = context.crew_id
      AND work_session.work_session_id = context.work_session_id
     WHERE context.account_id = ? AND context.crew_id = ? AND context.session_id = ?
       AND context.work_session_id = ?`,
    [input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  if (!row) throw new Error("LOCAL_WORK_SESSION_REQUIRED");
  let session: LocalWorkSession;
  try {
    session = JSON.parse(String(row.sessionJson)) as LocalWorkSession;
    validateLocalWorkSession(session, session.campaignId, input.sessionId);
  } catch {
    throw new Error("CORRUPT_LOCAL_WORK_SESSION");
  }
  if (session.status !== "ACTIVE") throw new Error("LOCAL_WORK_SESSION_FINISHED");
  if (
    !session.devices.some(
      (device) => device.deviceId === input.deviceId && device.membershipId === input.membershipId,
    )
  ) {
    throw new Error("LOCAL_DEVICE_NOT_JOINED");
  }
  return session;
}

type H40RunRow = {
  buildId: string;
  deviceAlias: "A" | "B";
  deviceId?: string;
  endedAt?: string;
  exportedAt?: string;
  finalOutboxJson?: string;
  finalProjectionJson?: string;
  membershipId?: string;
  runId: string;
  recoveredSending: number;
  salt: string;
  startedAt: string;
  status: "RUNNING" | "FINISHED" | "ABORTED";
};

function validateH40Context(input: H40ContextKey): void {
  if (
    !input.accountId ||
    !input.crewId ||
    !input.sessionId ||
    !input.workSessionId ||
    [input.accountId, input.crewId, input.sessionId, input.workSessionId].some(
      (value) => value.length > 256,
    )
  ) {
    throw new Error("H40_CONTEXT_INVALID");
  }
}

function getH40RunRow(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
  requireRunning = false,
): H40RunRow {
  validateH40Context(input);
  if (!input.runId || input.runId.length > 64) throw new Error("H40_RUN_ID_INVALID");
  const row = db.selectObject(
    `SELECT run_id AS "runId", device_alias AS "deviceAlias", build_id AS "buildId",
            device_id AS "deviceId", membership_id AS "membershipId",
            started_at AS "startedAt", ended_at AS "endedAt", status,
            recovered_sending AS "recoveredSending", exported_at AS "exportedAt", salt,
            final_projection_json AS "finalProjectionJson",
            final_outbox_json AS "finalOutboxJson"
     FROM h40_run
     WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
       AND work_session_id = ?`,
    [input.runId, input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  if (!row) throw new Error("H40_RUN_NOT_FOUND_OR_CONTEXT_MISMATCH");
  const status = String(row.status);
  if (requireRunning && status !== "RUNNING") throw new Error("H40_RUN_NOT_RUNNING");
  return {
    buildId: String(row.buildId),
    deviceAlias: String(row.deviceAlias) as H40RunRow["deviceAlias"],
    ...(row.deviceId ? { deviceId: String(row.deviceId) } : {}),
    ...(row.endedAt ? { endedAt: String(row.endedAt) } : {}),
    ...(row.exportedAt ? { exportedAt: String(row.exportedAt) } : {}),
    ...(row.finalOutboxJson ? { finalOutboxJson: String(row.finalOutboxJson) } : {}),
    ...(row.finalProjectionJson ? { finalProjectionJson: String(row.finalProjectionJson) } : {}),
    ...(row.membershipId ? { membershipId: String(row.membershipId) } : {}),
    runId: String(row.runId),
    recoveredSending: Number(row.recoveredSending),
    salt: String(row.salt),
    startedAt: String(row.startedAt),
    status: status as H40RunRow["status"],
  };
}

function latencySummary(values: number[]): H40LatencySummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, max: null, p50: null, p95: null };
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: sorted.length,
    max: sorted.at(-1) ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function summarizeH40Run(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40RunSummary {
  const run = getH40RunRow(db, input);
  const operations = db.selectObjects(
    `SELECT action_kind AS "actionKind", visual_ms AS "visualMs", persist_ms AS "persistMs"
     FROM h40_run_operation
     WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
       AND work_session_id = ?
     ORDER BY recorded_at, operation_id`,
    [input.runId, input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  const metric = db.selectObject(
    `SELECT count(*) AS "metricCount", coalesce(max(seq), 0) AS "lastMetricSequence"
     FROM h40_metric WHERE run_id = ?`,
    [input.runId],
  );
  const visualValues = operations
    .filter((operation) => operation.visualMs !== null && operation.visualMs !== undefined)
    .map((operation) => Number(operation.visualMs));
  const persistValues = operations
    .filter((operation) => operation.persistMs !== null && operation.persistMs !== undefined)
    .map((operation) => Number(operation.persistMs));
  return {
    actionCount: operations.length,
    buildId: run.buildId,
    completedActionCount: operations.filter(
      (operation) => operation.visualMs !== null && operation.visualMs !== undefined,
    ).length,
    deviceAlias: run.deviceAlias,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    lastMetricSequence: Number(metric?.lastMetricSequence ?? 0),
    markCount: operations.filter((operation) => operation.actionKind === "MARK").length,
    metricCount: Number(metric?.metricCount ?? 0),
    persistMs: latencySummary(persistValues),
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
    undoCount: operations.filter((operation) => operation.actionKind === "UNDO").length,
    visualMs: latencySummary(visualValues),
  };
}

function requireActiveH40WorkSession(db: DatabaseHandle, input: H40ContextKey): void {
  validateH40Context(input);
  const active = Number(
    db.selectValue(
      `SELECT count(*)
       FROM local_context context
       JOIN local_work_session work_session
         ON work_session.account_id = context.account_id
        AND work_session.crew_id = context.crew_id
        AND work_session.work_session_id = context.work_session_id
       WHERE context.account_id = ? AND context.crew_id = ? AND context.session_id = ?
         AND context.work_session_id = ? AND work_session.status = 'ACTIVE'`,
      [input.accountId, input.crewId, input.sessionId, input.workSessionId],
    ) ?? 0,
  );
  if (active !== 1) throw new Error("H40_ACTIVE_WORK_SESSION_REQUIRED");
}

export function startLocalH40Run(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "start-h40-run" }>,
): H40RunSummary {
  requireActiveH40WorkSession(db, input);
  requireJoinedActiveWorkSession(db, input);
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(input.buildId)) {
    throw new Error("H40_BUILD_ID_INVALID");
  }
  if (input.deviceAlias !== "A" && input.deviceAlias !== "B") {
    throw new Error("H40_DEVICE_ALIAS_INVALID");
  }
  if (!/^[0-9a-f]{32,128}$/u.test(input.salt) || input.salt.length % 2 !== 0) {
    throw new Error("H40_SALT_INVALID");
  }
  const running = Number(
    db.selectValue(
      `SELECT count(*) FROM h40_run
       WHERE account_id = ? AND crew_id = ? AND session_id = ? AND work_session_id = ?
         AND status = 'RUNNING'`,
      [input.accountId, input.crewId, input.sessionId, input.workSessionId],
    ) ?? 0,
  );
  if (running > 0) throw new Error("H40_RUN_ALREADY_RUNNING");
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  db.exec({
    sql: `INSERT INTO h40_run (
            run_id, account_id, crew_id, session_id, work_session_id,
            device_id, membership_id, device_alias, build_id,
            started_at, ended_at, status, salt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'RUNNING', ?)`,
    bind: [
      runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
      input.deviceId,
      input.membershipId,
      input.deviceAlias,
      input.buildId,
      startedAt,
      input.salt,
    ],
  });
  return summarizeH40Run(db, { ...input, runId });
}

export function getRunningLocalH40Run(
  db: DatabaseHandle,
  input: H40ContextKey,
): H40RunSummary | null {
  validateH40Context(input);
  const row = db.selectObject(
    `SELECT run_id AS "runId" FROM h40_run
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND work_session_id = ?
       AND status = 'RUNNING'`,
    [input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  return row ? summarizeH40Run(db, { ...input, runId: String(row.runId) }) : null;
}

export function getLatestLocalH40Run(
  db: DatabaseHandle,
  input: H40ContextKey,
): H40RunSummary | null {
  validateH40Context(input);
  const row = db.selectObject(
    `SELECT run_id AS "runId" FROM h40_run
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND work_session_id = ?
       AND status IN ('RUNNING','FINISHED')
       AND device_id IS NOT NULL AND membership_id IS NOT NULL
       AND (
         status = 'RUNNING'
         OR (
           status = 'FINISHED' AND exported_at IS NULL
           AND final_projection_json IS NOT NULL AND final_outbox_json IS NOT NULL
         )
       )
     ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END,
              coalesce(ended_at, started_at) DESC, started_at DESC, run_id DESC
     LIMIT 1`,
    [input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  return row ? summarizeH40Run(db, { ...input, runId: String(row.runId) }) : null;
}

export function getLocalH40RunSummary(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40RunSummary {
  return summarizeH40Run(db, input);
}

export function markLocalH40RunExported(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40RunSummary {
  const run = getH40RunRow(db, input);
  if (run.status !== "FINISHED") throw new Error("H40_RUN_NOT_FINISHED");
  if (run.exportedAt) return summarizeH40Run(db, input);
  db.exec({
    sql: `UPDATE h40_run SET exported_at = ?
          WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
            AND work_session_id = ? AND status = 'FINISHED' AND exported_at IS NULL`,
    bind: [
      new Date().toISOString(),
      input.runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
    ],
  });
  if (Number(db.selectValue("SELECT changes()") ?? 0) !== 1) {
    const current = getH40RunRow(db, input);
    if (current.status === "FINISHED" && current.exportedAt) {
      return summarizeH40Run(db, input);
    }
    throw new Error("H40_RUN_EXPORT_RACE");
  }
  return summarizeH40Run(db, input);
}

function requireH40ActionCapacity(
  db: DatabaseHandle,
  input: H40ContextKey & {
    deviceId: string;
    membershipId: string;
    runId: string;
  },
): void {
  const run = getH40RunRow(db, input, true);
  if (run.deviceId !== input.deviceId || run.membershipId !== input.membershipId) {
    throw new Error("H40_RUN_ACTOR_MISMATCH");
  }
  const count = Number(
    db.selectValue("SELECT count(*) FROM h40_run_operation WHERE run_id = ?", [input.runId]) ?? 0,
  );
  if (count >= 500) throw new Error("H40_ACTION_LIMIT_REACHED");
}

function associateH40Action(
  transaction: DatabaseHandle,
  input: H40ContextKey & {
    deviceId: string;
    membershipId: string;
    runId: string;
  },
  operationId: string,
  actionKind: H40ActionKind,
  recordedAt: string,
): void {
  transaction.exec({
    sql: `INSERT INTO h40_run_operation (
            run_id, account_id, crew_id, session_id, work_session_id, operation_id,
            action_kind, visual_ms, persist_ms, recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?
          FROM h40_run
          WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
            AND work_session_id = ? AND device_id = ? AND membership_id = ?
            AND status = 'RUNNING'`,
    bind: [
      input.runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
      operationId,
      actionKind,
      recordedAt,
      input.runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
      input.deviceId,
      input.membershipId,
    ],
  });
  if (Number(transaction.selectValue("SELECT changes()") ?? 0) !== 1) {
    throw new Error("H40_RUN_ACTOR_MISMATCH");
  }
}

function validH40Latency(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 600_000;
}

export function completeLocalH40Action(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "complete-h40-action" }>,
): H40RunSummary {
  getH40RunRow(db, input, true);
  if (!input.operationId || input.operationId.length > 128) {
    throw new Error("H40_OPERATION_ID_INVALID");
  }
  if (!validH40Latency(input.visualMs) || !validH40Latency(input.persistMs)) {
    throw new Error("H40_ACTION_LATENCY_INVALID");
  }
  db.exec({
    sql: `UPDATE h40_run_operation
          SET visual_ms = ?, persist_ms = ?
          WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
            AND work_session_id = ? AND operation_id = ?
            AND visual_ms IS NULL AND persist_ms IS NULL`,
    bind: [
      input.visualMs,
      input.persistMs,
      input.runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
      input.operationId,
    ],
  });
  const changed = Number(db.selectValue("SELECT changes()") ?? 0);
  if (changed !== 1) {
    const exists = Number(
      db.selectValue(
        `SELECT count(*) FROM h40_run_operation
         WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
           AND work_session_id = ? AND operation_id = ?`,
        [
          input.runId,
          input.accountId,
          input.crewId,
          input.sessionId,
          input.workSessionId,
          input.operationId,
        ],
      ) ?? 0,
    );
    throw new Error(exists > 0 ? "H40_ACTION_ALREADY_COMPLETED" : "H40_ACTION_NOT_FOUND");
  }
  return summarizeH40Run(db, input);
}

function optionalH40Count(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error("H40_METRIC_COUNT_INVALID");
  }
  return value;
}

function asH40Metric(row: Record<string, unknown>): H40MetricRecord {
  return {
    ...(row.applied !== null && row.applied !== undefined ? { applied: Number(row.applied) } : {}),
    ...(row.conflict !== null && row.conflict !== undefined
      ? { conflict: Number(row.conflict) }
      : {}),
    ...(row.errorCode ? { errorCode: String(row.errorCode) } : {}),
    eventKind: String(row.eventKind) as H40MetricRecord["eventKind"],
    ...(row.monotonicMs !== null && row.monotonicMs !== undefined
      ? { monotonicMs: Number(row.monotonicMs) }
      : {}),
    ...(row.pending !== null && row.pending !== undefined ? { pending: Number(row.pending) } : {}),
    recordedSequence: Number(row.recordedSequence),
    ...(row.rejected !== null && row.rejected !== undefined
      ? { rejected: Number(row.rejected) }
      : {}),
    ...(row.replayed !== null && row.replayed !== undefined
      ? { replayed: Number(row.replayed) }
      : {}),
    wallAt: String(row.wallAt),
  };
}

export function recordLocalH40Metric(db: DatabaseHandle, input: H40MetricInput): H40MetricRecord {
  getH40RunRow(db, input, true);
  if (
    !["OFFLINE_START", "OFFLINE_END", "BOOT", "SYNC_START", "SYNC_END", "RECOVERY"].includes(
      input.eventKind,
    )
  ) {
    throw new Error("H40_METRIC_EVENT_KIND_INVALID");
  }
  if (!isIsoTimestamp(input.wallAt)) throw new Error("H40_METRIC_WALL_AT_INVALID");
  if (
    input.monotonicMs !== undefined &&
    (!Number.isFinite(input.monotonicMs) || input.monotonicMs < 0)
  ) {
    throw new Error("H40_METRIC_MONOTONIC_INVALID");
  }
  if (input.errorCode !== undefined && !/^[A-Z0-9_]{1,64}$/u.test(input.errorCode)) {
    throw new Error("H40_METRIC_ERROR_CODE_INVALID");
  }
  const counts = {
    applied: optionalH40Count(input.applied),
    conflict: optionalH40Count(input.conflict),
    pending: optionalH40Count(input.pending),
    rejected: optionalH40Count(input.rejected),
    replayed: optionalH40Count(input.replayed),
  };
  const recordedSequence = db.transaction((transaction) => {
    const next = Number(
      transaction.selectValue("SELECT coalesce(max(seq), 0) + 1 FROM h40_metric WHERE run_id = ?", [
        input.runId,
      ]),
    );
    transaction.exec({
      sql: `INSERT INTO h40_metric (
              run_id, seq, event_kind, wall_at, monotonic_ms, pending, applied,
              conflict, rejected, replayed, error_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        input.runId,
        next,
        input.eventKind,
        input.wallAt,
        input.monotonicMs ?? null,
        counts.pending,
        counts.applied,
        counts.conflict,
        counts.rejected,
        counts.replayed,
        input.errorCode ?? null,
      ],
    });
    return next;
  });
  return {
    ...(counts.applied !== null ? { applied: counts.applied } : {}),
    ...(counts.conflict !== null ? { conflict: counts.conflict } : {}),
    eventKind: input.eventKind,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.monotonicMs !== undefined ? { monotonicMs: input.monotonicMs } : {}),
    ...(counts.pending !== null ? { pending: counts.pending } : {}),
    recordedSequence,
    ...(counts.rejected !== null ? { rejected: counts.rejected } : {}),
    ...(counts.replayed !== null ? { replayed: counts.replayed } : {}),
    wallAt: input.wallAt,
  };
}

function getH40FinalOutboxSnapshot(
  db: DatabaseHandle,
  input: H40ContextKey,
): H40EvidenceSource["finalOutbox"] {
  const row = db.selectObject(
    `SELECT
       count(*) FILTER (WHERE state = 'PENDING') AS pending,
       count(*) FILTER (WHERE state = 'SENDING') AS sending,
       count(*) FILTER (WHERE state = 'CONFLICT') AS conflict,
       count(*) FILTER (WHERE state = 'REJECTED') AS rejected
     FROM outbox
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND work_session_id = ?`,
    [input.accountId, input.crewId, input.sessionId, input.workSessionId],
  );
  return {
    conflict: Number(row?.conflict ?? 0),
    pending: Number(row?.pending ?? 0),
    rejected: Number(row?.rejected ?? 0),
    sending: Number(row?.sending ?? 0),
  };
}

function getH40ProjectionSnapshot(
  db: DatabaseHandle,
  input: H40ContextKey,
): H40EvidenceSource["projection"] {
  return db
    .selectObjects(
      `SELECT point_id AS id, state, server_version AS version
       FROM local_point
       WHERE account_id = ? AND crew_id = ? AND session_id = ?
       ORDER BY display_order, point_id`,
      [input.accountId, input.crewId, input.sessionId],
    )
    .map((row) => ({
      id: String(row.id),
      state: String(row.state) as PointState,
      version: Number(row.version),
    }));
}

function parseH40FinalOutboxSnapshot(value: string): H40EvidenceSource["finalOutbox"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("H40_FINAL_OUTBOX_SNAPSHOT_CORRUPT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("H40_FINAL_OUTBOX_SNAPSHOT_CORRUPT");
  }
  const record = parsed as Record<string, unknown>;
  const keys = ["conflict", "pending", "rejected", "sending"] as const;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
  ) {
    throw new Error("H40_FINAL_OUTBOX_SNAPSHOT_CORRUPT");
  }
  return {
    conflict: Number(record.conflict),
    pending: Number(record.pending),
    rejected: Number(record.rejected),
    sending: Number(record.sending),
  };
}

function parseH40ProjectionSnapshot(value: string): H40EvidenceSource["projection"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("H40_PROJECTION_SNAPSHOT_CORRUPT");
  }
  if (!Array.isArray(parsed)) throw new Error("H40_PROJECTION_SNAPSHOT_CORRUPT");
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("H40_PROJECTION_SNAPSHOT_CORRUPT");
    }
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      row.id.length > 512 ||
      !isPointState(row.state) ||
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 0
    ) {
      throw new Error("H40_PROJECTION_SNAPSHOT_CORRUPT");
    }
    return { id: row.id, state: row.state, version: Number(row.version) };
  });
}

export function getLocalH40EvidenceSource(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40EvidenceSource {
  const run = getH40RunRow(db, input);
  if (run.status !== "FINISHED") throw new Error("H40_EVIDENCE_NOT_FINALIZED");
  if (!run.finalProjectionJson || !run.finalOutboxJson) {
    throw new Error("H40_EVIDENCE_SNAPSHOT_MISSING");
  }
  const operations = db
    .selectObjects(
      `SELECT operation_id AS "operationId", action_kind AS "actionKind",
              visual_ms AS "visualMs", persist_ms AS "persistMs", recorded_at AS "recordedAt"
       FROM h40_run_operation
       WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
         AND work_session_id = ?
       ORDER BY recorded_at, operation_id`,
      [input.runId, input.accountId, input.crewId, input.sessionId, input.workSessionId],
    )
    .map((row) => ({
      actionKind: String(row.actionKind) as H40ActionKind,
      operationId: String(row.operationId),
      ...(row.persistMs !== null && row.persistMs !== undefined
        ? { persistMs: Number(row.persistMs) }
        : {}),
      recordedAt: String(row.recordedAt),
      ...(row.visualMs !== null && row.visualMs !== undefined
        ? { visualMs: Number(row.visualMs) }
        : {}),
    }));
  const metrics = db
    .selectObjects(
      `SELECT seq AS "recordedSequence", event_kind AS "eventKind", wall_at AS "wallAt",
              monotonic_ms AS "monotonicMs", pending, applied, conflict, rejected, replayed,
              error_code AS "errorCode"
       FROM h40_metric WHERE run_id = ? ORDER BY seq`,
      [input.runId],
    )
    .map(asH40Metric);
  return {
    finalOutbox: parseH40FinalOutboxSnapshot(run.finalOutboxJson),
    metrics,
    operations,
    projection: parseH40ProjectionSnapshot(run.finalProjectionJson),
    recoveredSending: run.recoveredSending,
    salt: run.salt,
    summary: summarizeH40Run(db, input),
  };
}

export function finishLocalH40Run(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40FinishResult {
  return db.transaction((transaction) => {
    const run = getH40RunRow(transaction, input);
    if (run.status === "FINISHED") {
      return { blocking: [], finished: true, summary: summarizeH40Run(transaction, input) };
    }
    if (run.status === "ABORTED") throw new Error("H40_RUN_ABORTED");
    const summary = summarizeH40Run(transaction, input);
    const finalOutbox = getH40FinalOutboxSnapshot(transaction, input);
    const blocking: H40FinishResult["blocking"] = [];
    if (summary.actionCount < 30) {
      blocking.push({ code: "LESS_THAN_30_ACTIONS", current: summary.actionCount, required: 30 });
    }
    if (summary.completedActionCount !== summary.actionCount) {
      blocking.push({
        code: "INCOMPLETE_ACTION_METRICS",
        current: summary.completedActionCount,
        required: summary.actionCount,
      });
    }
    const pending = finalOutbox.pending + finalOutbox.sending;
    if (pending > 0) blocking.push({ code: "OUTBOX_NOT_EMPTY", current: pending, required: 0 });
    const attention = finalOutbox.conflict + finalOutbox.rejected;
    if (attention > 0) {
      blocking.push({ code: "ATTENTION_REQUIRED", current: attention, required: 0 });
    }
    if (blocking.length > 0) return { blocking, finished: false, summary };

    const projection = getH40ProjectionSnapshot(transaction, input);
    transaction.exec({
      sql: `UPDATE h40_run
            SET status = 'FINISHED', ended_at = ?,
                final_projection_json = ?, final_outbox_json = ?
            WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
              AND work_session_id = ? AND status = 'RUNNING'`,
      bind: [
        new Date().toISOString(),
        JSON.stringify(projection),
        JSON.stringify(finalOutbox),
        input.runId,
        input.accountId,
        input.crewId,
        input.sessionId,
        input.workSessionId,
      ],
    });
    if (Number(transaction.selectValue("SELECT changes()") ?? 0) !== 1) {
      throw new Error("H40_RUN_FINISH_RACE");
    }
    return { blocking: [], finished: true, summary: summarizeH40Run(transaction, input) };
  });
}

export function abortLocalH40Run(
  db: DatabaseHandle,
  input: H40ContextKey & { runId: string },
): H40RunSummary {
  const run = getH40RunRow(db, input);
  if (run.status === "ABORTED") return summarizeH40Run(db, input);
  if (run.status === "FINISHED") throw new Error("H40_RUN_ALREADY_FINISHED");
  db.exec({
    sql: `UPDATE h40_run SET status = 'ABORTED', ended_at = ?
          WHERE run_id = ? AND account_id = ? AND crew_id = ? AND session_id = ?
            AND work_session_id = ? AND status = 'RUNNING'`,
    bind: [
      new Date().toISOString(),
      input.runId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.workSessionId,
    ],
  });
  if (Number(db.selectValue("SELECT changes()") ?? 0) !== 1) {
    throw new Error("H40_RUN_ABORT_RACE");
  }
  return summarizeH40Run(db, input);
}

export function markLocalPoint(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "mark-point" }>,
  undoId?: string,
) {
  requireJoinedActiveWorkSession(db, input);
  if (input.h40RunId) {
    requireH40ActionCapacity(db, { ...input, runId: input.h40RunId });
  }
  if (getLocalOutboxStatus(db, input.accountId, input.crewId, input.sessionId).legacyBlocked > 0) {
    throw new Error("LOCAL_LEGACY_OUTBOX_BLOCKED");
  }
  const point = db.selectObject(
    `SELECT state, server_version AS version FROM local_point
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?`,
    [input.accountId, input.crewId, input.sessionId, input.pointId],
  );
  if (!point) throw new Error("LOCAL_POINT_NOT_FOUND");
  if (input.h40RunId && String(point.state) === input.toState) {
    throw new Error("H40_ACTION_NO_STATE_CHANGE");
  }
  const unresolvedConflict = Number(
    db.selectValue(
      `SELECT count(*) FROM outbox
       WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
         AND state = 'CONFLICT'`,
      [input.accountId, input.crewId, input.sessionId, input.pointId],
    ) ?? 0,
  );
  if (unresolvedConflict > 0) throw new Error("POINT_HAS_UNRESOLVED_CONFLICT");
  const latest = db.selectObject(
    `SELECT operation_id AS id FROM outbox
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
       AND work_session_id = ?
        AND state IN ('PENDING','SENDING')
     ORDER BY device_sequence DESC LIMIT 1`,
    [input.accountId, input.crewId, input.sessionId, input.pointId, input.workSessionId],
  );
  const nextSequence = Number(
    db.selectValue(
      `SELECT coalesce(max(device_sequence), 0) + 1 FROM outbox
       WHERE account_id = ? AND crew_id = ? AND device_id = ?`,
      [input.accountId, input.crewId, input.deviceId],
    ),
  );
  const operationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.transaction((transaction) => {
    transaction.exec({
      sql: `UPDATE local_point SET state = ?
            WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?`,
      bind: [input.toState, input.accountId, input.crewId, input.sessionId, input.pointId],
    });
    transaction.exec({
      sql: `INSERT INTO outbox (
          account_id, crew_id, session_id, operation_id, device_id, device_sequence,
          point_id, base_version, depends_on_operation_id, undoes_operation_id,
          work_session_id, previous_state, to_state, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      bind: [
        input.accountId,
        input.crewId,
        input.sessionId,
        operationId,
        input.deviceId,
        nextSequence,
        input.pointId,
        Number(point.version),
        undoId ?? latest?.id ?? null,
        undoId ?? null,
        input.workSessionId,
        String(point.state),
        input.toState,
        createdAt,
      ],
    });
    if (input.h40RunId) {
      associateH40Action(
        transaction,
        { ...input, runId: input.h40RunId },
        operationId,
        undoId ? "UNDO" : "MARK",
        createdAt,
      );
    }
  });
  return asOperation({
    accountId: input.accountId,
    aggregateId: input.pointId,
    baseVersion: point.version,
    crewId: input.crewId,
    dependsOnOperationId: undoId ?? latest?.id,
    deviceId: input.deviceId,
    deviceSequence: nextSequence,
    operationId,
    previousState: point.state,
    state: "PENDING",
    toState: input.toState,
    ...(undoId ? { undoesOperationId: undoId } : {}),
    workSessionId: input.workSessionId,
  });
}

function markPoint(input: Extract<LocalDatabaseRequest, { type: "mark-point" }>, undoId?: string) {
  return markLocalPoint(requireDatabase(), input, undoId);
}

export function undoLocalOperation(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "undo-operation" }>,
) {
  const original = db.selectObject(
    `SELECT point_id AS "pointId", previous_state AS "previousState"
     FROM outbox
     WHERE account_id = ? AND crew_id = ? AND session_id = ? AND operation_id = ?
       AND work_session_id = ?`,
    [input.accountId, input.crewId, input.sessionId, input.operationId, input.workSessionId],
  );
  if (!original) throw new Error("LOCAL_OPERATION_NOT_FOUND");
  return markLocalPoint(
    db,
    {
      ...input,
      type: "mark-point",
      pointId: String(original.pointId),
      toState: String(original.previousState) as LocalOperation["toState"],
    },
    input.operationId,
  );
}

function undoOperation(input: Extract<LocalDatabaseRequest, { type: "undo-operation" }>) {
  return undoLocalOperation(requireDatabase(), input);
}

const POINT_STATES: PointState[] = [
  "SIN_VISITAR",
  "SOBRE_ENTREGADO",
  "VOLVER",
  "SIN_RESPUESTA",
  "APORTO",
  "NO_PARTICIPA",
];

function isPointState(value: unknown): value is PointState {
  return typeof value === "string" && POINT_STATES.includes(value as PointState);
}

function canonicalFromSyncResult(
  result: SyncOperationResult,
): { state: PointState; version: number } | undefined {
  const suppliedStateVersion = result.state !== undefined || result.version !== undefined;
  const suppliedCanonicalStateVersion =
    result.canonicalState !== undefined || result.canonicalVersion !== undefined;
  const stateVersion =
    isPointState(result.state) && Number.isInteger(result.version) && Number(result.version) >= 0
      ? { state: result.state, version: Number(result.version) }
      : undefined;
  const canonicalStateVersion =
    isPointState(result.canonicalState) &&
    Number.isInteger(result.canonicalVersion) &&
    Number(result.canonicalVersion) >= 0
      ? { state: result.canonicalState, version: Number(result.canonicalVersion) }
      : undefined;
  if (
    (suppliedStateVersion && !stateVersion) ||
    (suppliedCanonicalStateVersion && !canonicalStateVersion) ||
    (stateVersion &&
      canonicalStateVersion &&
      (stateVersion.state !== canonicalStateVersion.state ||
        stateVersion.version !== canonicalStateVersion.version)) ||
    (result.status !== "BLOCKED_DEPENDENCY" && !stateVersion)
  ) {
    throw new Error("LOCAL_SYNC_RESULT_CANONICAL_STATE_MISSING");
  }
  return canonicalStateVersion ?? stateVersion;
}

function parseCanonicalConflict(resultJson: unknown):
  | {
      state: PointState;
      version: number;
    }
  | undefined {
  let result: {
    canonicalState?: unknown;
    canonicalVersion?: unknown;
    state?: unknown;
    version?: unknown;
  };
  try {
    result = JSON.parse(String(resultJson)) as typeof result;
  } catch {
    return undefined;
  }
  const state = result.canonicalState ?? result.state;
  const version = result.canonicalVersion ?? result.version;
  if (!isPointState(state) || !Number.isInteger(version) || Number(version) < 0) return undefined;
  return { state, version: Number(version) };
}

function supersedeResolutionChain(
  db: DatabaseHandle,
  input: { accountId: string; crewId: string; sessionId: string },
  operationId: string,
) {
  db.exec({
    sql: `WITH RECURSIVE resolution_chain(operation_id) AS (
            SELECT ?
            UNION
            SELECT operation.resolves_operation_id
            FROM outbox operation
            JOIN resolution_chain child ON child.operation_id = operation.operation_id
            WHERE operation.account_id = ? AND operation.crew_id = ? AND operation.session_id = ?
              AND operation.resolves_operation_id IS NOT NULL
          )
          UPDATE outbox SET state = 'SUPERSEDED'
          WHERE account_id = ? AND crew_id = ? AND session_id = ?
            AND operation_id IN (SELECT operation_id FROM resolution_chain)
            AND state IN ('CONFLICT','REJECTED')`,
    bind: [
      operationId,
      input.accountId,
      input.crewId,
      input.sessionId,
      input.accountId,
      input.crewId,
      input.sessionId,
    ],
  });
}

export function resolveLocalConflict(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "resolve-conflict" }>,
) {
  if (input.decision !== "ACCEPT_SERVER" && input.decision !== "REAPPLY_LOCAL") {
    throw new Error("LOCAL_CONFLICT_DECISION_INVALID");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > 500) {
    throw new Error("LOCAL_CONFLICT_REASON_REQUIRED");
  }
  requireJoinedActiveWorkSession(db, input);
  const conflict = db.selectObject(
    `SELECT operation.point_id AS "pointId", operation.to_state AS "toState",
            operation.device_sequence AS "deviceSequence",
            operation.resolves_operation_id AS "resolvesOperationId",
            operation.result_json AS "resultJson", point.server_state AS "localCanonicalState",
            point.server_version AS "localCanonicalVersion"
     FROM outbox operation
     JOIN local_point point
       ON point.account_id = operation.account_id
      AND point.crew_id = operation.crew_id
      AND point.session_id = operation.session_id
      AND point.point_id = operation.point_id
     WHERE operation.account_id = ? AND operation.crew_id = ? AND operation.session_id = ?
       AND operation.operation_id = ?
       AND operation.work_session_id = ?
       AND (
         operation.state = 'CONFLICT'
         OR (operation.state = 'REJECTED' AND operation.resolves_operation_id IS NOT NULL)
       )`,
    [input.accountId, input.crewId, input.sessionId, input.operationId, input.workSessionId],
  );
  if (!conflict) throw new Error("LOCAL_CONFLICT_NOT_FOUND");
  const priorResolution = Number(
    db.selectValue(
      `SELECT count(*) FROM local_conflict_resolution
       WHERE account_id = ? AND crew_id = ? AND conflict_operation_id = ?`,
      [input.accountId, input.crewId, input.operationId],
    ) ?? 0,
  );
  if (priorResolution > 0) throw new Error("LOCAL_CONFLICT_ALREADY_RESOLVING");
  const receiptCanonical = parseCanonicalConflict(conflict.resultJson);
  const localCanonical = {
    state: String(conflict.localCanonicalState) as PointState,
    version: Number(conflict.localCanonicalVersion),
  };
  if (
    !isPointState(localCanonical.state) ||
    !Number.isInteger(localCanonical.version) ||
    localCanonical.version < 0
  ) {
    throw new Error("LOCAL_POINT_CANONICAL_STATE_INVALID");
  }
  const canonical =
    receiptCanonical && receiptCanonical.version > localCanonical.version
      ? receiptCanonical
      : localCanonical;
  const causalDescendants = db.selectObjects(
    `WITH RECURSIVE descendants AS (
       SELECT operation_id, to_state, state, device_sequence, result_json
       FROM outbox
       WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
         AND depends_on_operation_id = ?
       UNION
       SELECT child.operation_id, child.to_state, child.state, child.device_sequence,
              child.result_json
       FROM outbox child
       JOIN descendants parent ON child.depends_on_operation_id = parent.operation_id
       WHERE child.account_id = ? AND child.crew_id = ? AND child.session_id = ?
         AND child.point_id = ?
     )
     SELECT operation_id AS "operationId", to_state AS "toState", device_sequence AS "deviceSequence"
     FROM descendants
     WHERE state IN ('PENDING','SENDING')
        OR (
          state = 'REJECTED'
          AND json_valid(result_json)
          AND json_extract(result_json, '$.status') = 'BLOCKED_DEPENDENCY'
        )
     ORDER BY device_sequence`,
    [
      input.accountId,
      input.crewId,
      input.sessionId,
      conflict.pointId,
      input.operationId,
      input.accountId,
      input.crewId,
      input.sessionId,
      conflict.pointId,
    ],
  );
  const latestDescendant = causalDescendants.at(-1);
  const desiredState = String(latestDescendant?.toState ?? conflict.toState) as PointState;
  if (!isPointState(desiredState)) throw new Error("LOCAL_CONFLICT_DESIRED_STATE_INVALID");
  const resolutionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const supersedeCausalDescendants = (transaction: DatabaseHandle) => {
    for (const descendant of causalDescendants) {
      transaction.exec({
        sql: `UPDATE outbox
              SET state = 'SUPERSEDED',
                  result_json = json_set(
                    CASE WHEN json_valid(result_json) THEN result_json ELSE '{}' END,
                    '$.localDisposition', 'SUPERSEDED_BY_CONFLICT_RESOLUTION',
                    '$.localResolutionId', ?
                  )
              WHERE account_id = ? AND crew_id = ? AND session_id = ?
                AND operation_id = ? AND state IN ('PENDING','SENDING','REJECTED')`,
        bind: [
          resolutionId,
          input.accountId,
          input.crewId,
          input.sessionId,
          descendant.operationId,
        ],
      });
    }
  };

  if (input.decision === "ACCEPT_SERVER") {
    db.transaction((transaction) => {
      transaction.exec({
        sql: `INSERT INTO local_conflict_resolution (
                account_id, crew_id, session_id, resolution_id, conflict_operation_id,
                resolution_operation_id, decision, reason, canonical_state,
                canonical_version, created_at
              ) VALUES (?, ?, ?, ?, ?, NULL, 'ACCEPT_SERVER', ?, ?, ?, ?)`,
        bind: [
          input.accountId,
          input.crewId,
          input.sessionId,
          resolutionId,
          input.operationId,
          reason,
          canonical.state,
          canonical.version,
          createdAt,
        ],
      });
      supersedeCausalDescendants(transaction);
      transaction.exec({
        sql: `UPDATE local_point SET state = ?, server_state = ?, server_version = ?
              WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
                AND server_version <= ?`,
        bind: [
          canonical.state,
          canonical.state,
          canonical.version,
          input.accountId,
          input.crewId,
          input.sessionId,
          conflict.pointId,
          canonical.version,
        ],
      });
      supersedeResolutionChain(transaction, input, input.operationId);
    });
    return { decision: input.decision, resolutionId };
  }

  if (desiredState === canonical.state) {
    throw new Error("LOCAL_REAPPLY_ALREADY_CANONICAL");
  }
  if (input.h40RunId) {
    requireH40ActionCapacity(db, { ...input, runId: input.h40RunId });
  }
  const operationId = crypto.randomUUID();
  const nextSequence = Number(
    db.selectValue(
      `SELECT coalesce(max(device_sequence), 0) + 1 FROM outbox
       WHERE account_id = ? AND crew_id = ? AND device_id = ?`,
      [input.accountId, input.crewId, input.deviceId],
    ),
  );
  db.transaction((transaction) => {
    supersedeCausalDescendants(transaction);
    transaction.exec({
      sql: `INSERT INTO outbox (
              account_id, crew_id, session_id, operation_id, device_id, device_sequence,
              point_id, base_version, depends_on_operation_id, undoes_operation_id,
              resolves_operation_id, work_session_id, previous_state, to_state, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'PENDING', ?)`,
      bind: [
        input.accountId,
        input.crewId,
        input.sessionId,
        operationId,
        input.deviceId,
        nextSequence,
        conflict.pointId,
        canonical.version,
        input.operationId,
        input.workSessionId,
        canonical.state,
        desiredState,
        createdAt,
      ],
    });
    transaction.exec({
      sql: `INSERT INTO local_conflict_resolution (
              account_id, crew_id, session_id, resolution_id, conflict_operation_id,
              resolution_operation_id, decision, reason, canonical_state,
              canonical_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'REAPPLY_LOCAL', ?, ?, ?, ?)`,
      bind: [
        input.accountId,
        input.crewId,
        input.sessionId,
        resolutionId,
        input.operationId,
        operationId,
        reason,
        canonical.state,
        canonical.version,
        createdAt,
      ],
    });
    if (input.h40RunId) {
      associateH40Action(
        transaction,
        { ...input, runId: input.h40RunId },
        operationId,
        "MARK",
        createdAt,
      );
    }
    transaction.exec({
      sql: `UPDATE local_point SET state = ?, server_state = ?, server_version = ?
            WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
              AND server_version <= ?`,
      bind: [
        desiredState,
        canonical.state,
        canonical.version,
        input.accountId,
        input.crewId,
        input.sessionId,
        conflict.pointId,
        canonical.version,
      ],
    });
  });
  return {
    decision: input.decision,
    operation: asOperation({
      accountId: input.accountId,
      aggregateId: conflict.pointId,
      baseVersion: canonical.version,
      crewId: input.crewId,
      deviceId: input.deviceId,
      deviceSequence: nextSequence,
      operationId,
      previousState: canonical.state,
      resolvesOperationId: input.operationId,
      state: "PENDING",
      toState: desiredState,
      workSessionId: input.workSessionId,
    }),
    resolutionId,
  };
}

export function listLocalOperations(
  db: DatabaseHandle,
  accountId: string,
  crewId: string,
  sessionId: string,
  pendingOnly: boolean,
) {
  return db
    .selectObjects(
      `SELECT o.account_id AS "accountId", o.point_id AS "aggregateId",
              o.base_version AS "baseVersion", o.crew_id AS "crewId",
              o.depends_on_operation_id AS "dependsOnOperationId", o.device_id AS "deviceId",
              o.device_sequence AS "deviceSequence", o.operation_id AS "operationId",
              o.previous_state AS "previousState", o.state, o.to_state AS "toState",
              o.undoes_operation_id AS "undoesOperationId",
              o.resolves_operation_id AS "resolvesOperationId",
              o.work_session_id AS "workSessionId",
              o.result_json AS "resultJson", resolution.decision AS "resolutionDecision",
              point.server_state AS "pointCanonicalState",
              point.server_version AS "pointCanonicalVersion",
              resolution.reason AS "resolutionReason",
              resolution.resolution_operation_id AS "resolutionOperationId",
              resolution_operation.state AS "resolutionOperationState"
       FROM outbox o
       JOIN local_point point
         ON point.account_id = o.account_id
        AND point.crew_id = o.crew_id
        AND point.session_id = o.session_id
        AND point.point_id = o.point_id
       LEFT JOIN local_conflict_resolution resolution
         ON resolution.account_id = o.account_id
        AND resolution.crew_id = o.crew_id
        AND resolution.conflict_operation_id = o.operation_id
       LEFT JOIN outbox resolution_operation
         ON resolution_operation.account_id = resolution.account_id
        AND resolution_operation.crew_id = resolution.crew_id
        AND resolution_operation.operation_id = resolution.resolution_operation_id
       WHERE o.account_id = ? AND o.crew_id = ? AND o.session_id = ?
          ${pendingOnly ? "AND o.state IN ('PENDING','SENDING') AND o.work_session_id IS NOT NULL" : ""}
       ORDER BY o.device_sequence ${pendingOnly ? "ASC" : "DESC"}`,
      [accountId, crewId, sessionId],
    )
    .map(asOperation);
}

function listOperations(
  accountId: string,
  crewId: string,
  sessionId: string,
  pendingOnly: boolean,
) {
  return listLocalOperations(requireDatabase(), accountId, crewId, sessionId, pendingOnly);
}

export function transitionLocalOperations(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "mark-sending" | "restore-pending" }>,
) {
  if (input.operationIds.length === 0) return { applied: 0 };
  const targetState = input.type === "mark-sending" ? "SENDING" : "PENDING";
  const sourceStates = input.type === "mark-sending" ? "'PENDING','SENDING'" : "'SENDING'";
  let applied = 0;
  db.transaction((transaction) => {
    for (const operationId of new Set(input.operationIds)) {
      const belongsToScope = Number(
        transaction.selectValue(
          `SELECT count(*) FROM outbox
           WHERE account_id = ? AND crew_id = ? AND session_id = ? AND operation_id = ?
             AND work_session_id IS NOT NULL
              AND state IN (${sourceStates})`,
          [input.accountId, input.crewId, input.sessionId, operationId],
        ),
      );
      if (belongsToScope === 0) continue;
      transaction.exec({
        sql: `UPDATE outbox SET state = ?
              WHERE account_id = ? AND crew_id = ? AND session_id = ? AND operation_id = ?`,
        bind: [targetState, input.accountId, input.crewId, input.sessionId, operationId],
      });
      applied += 1;
    }
  });
  return { applied };
}

function transitionOperations(
  input: Extract<LocalDatabaseRequest, { type: "mark-sending" | "restore-pending" }>,
) {
  return transitionLocalOperations(requireDatabase(), input);
}

export function applySyncResults(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "apply-results" }>,
) {
  const canonicalResults = new Map(
    input.results.map((result) => [result.operationId, canonicalFromSyncResult(result)]),
  );
  db.transaction((transaction) => {
    const canonicalByPoint = new Map<string, { state: FieldPoint["state"]; version: number }>();
    for (const result of input.results) {
      const operation = transaction.selectObject(
        `SELECT point_id AS "pointId", resolves_operation_id AS "resolvesOperationId",
                to_state AS "toState", work_session_id AS "workSessionId"
         FROM outbox
         WHERE account_id = ? AND crew_id = ? AND session_id = ? AND operation_id = ?`,
        [input.accountId, input.crewId, input.sessionId, result.operationId],
      );
      if (!operation) continue;
      if (!operation.workSessionId || operation.workSessionId !== result.workSessionId) {
        throw new Error("LOCAL_SYNC_RESULT_WORK_SESSION_MISMATCH");
      }
      const resultCanonical = canonicalResults.get(result.operationId);
      const resultCanonicalState = resultCanonical?.state;
      const resultCanonicalVersion = resultCanonical?.version;
      const convergedNoStateChange =
        result.status === "REJECTED" &&
        result.code === "NO_STATE_CHANGE" &&
        resultCanonicalState === operation.toState &&
        Number.isInteger(resultCanonicalVersion) &&
        Number(resultCanonicalVersion) >= 0;
      const localState =
        result.status === "APPLIED"
          ? "CONFIRMED"
          : convergedNoStateChange
            ? "SUPERSEDED"
            : result.status === "CONFLICT"
              ? "CONFLICT"
              : "REJECTED";
      transaction.exec({
        sql: `UPDATE outbox SET state = ?, result_json = ?
              WHERE account_id = ? AND crew_id = ? AND operation_id = ?`,
        bind: [
          localState,
          JSON.stringify(result),
          input.accountId,
          input.crewId,
          result.operationId,
        ],
      });
      if (
        operation.resolvesOperationId &&
        (result.status === "APPLIED" || convergedNoStateChange)
      ) {
        supersedeResolutionChain(transaction, input, result.operationId);
      }
      if (
        isPointState(resultCanonicalState) &&
        Number.isInteger(resultCanonicalVersion) &&
        Number(resultCanonicalVersion) >= 0
      ) {
        const pointId = String(operation.pointId);
        const previousCanonical = canonicalByPoint.get(pointId);
        if (!previousCanonical || previousCanonical.version <= Number(resultCanonicalVersion)) {
          canonicalByPoint.set(pointId, {
            state: resultCanonicalState,
            version: Number(resultCanonicalVersion),
          });
        }
      }
    }

    for (const [pointId, canonical] of canonicalByPoint) {
      const laterPending = Number(
        transaction.selectValue(
          `SELECT count(*) FROM outbox
           WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
             AND state IN ('PENDING','SENDING')`,
          [input.accountId, input.crewId, input.sessionId, pointId],
        ),
      );
      transaction.exec({
        sql: `UPDATE local_point
              SET state = CASE WHEN ? = 0 AND server_version <= ? THEN ? ELSE state END,
                  server_state = CASE WHEN server_version <= ? THEN ? ELSE server_state END,
                  server_version = CASE WHEN server_version < ? THEN ? ELSE server_version END
              WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?`,
        bind: [
          laterPending,
          canonical.version,
          canonical.state,
          canonical.version,
          canonical.state,
          canonical.version,
          canonical.version,
          input.accountId,
          input.crewId,
          input.sessionId,
          pointId,
        ],
      });
    }
  });
  return { applied: input.results.length };
}

function applyResults(input: Extract<LocalDatabaseRequest, { type: "apply-results" }>) {
  return applySyncResults(requireDatabase(), input);
}

export function applySyncChanges(
  db: DatabaseHandle,
  input: Extract<LocalDatabaseRequest, { type: "apply-changes" }>,
) {
  db.transaction((transaction) => {
    for (const change of input.changes) {
      const pending = Number(
        transaction.selectValue(
          `SELECT count(*) FROM outbox
           WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?
             AND state IN ('PENDING','SENDING')`,
          [input.accountId, input.crewId, input.sessionId, change.pointId],
        ),
      );
      transaction.exec({
        sql: `UPDATE local_point
              SET state = CASE WHEN ? = 0 AND server_version < ? THEN ? ELSE state END,
                  server_state = CASE WHEN server_version < ? THEN ? ELSE server_state END,
                  server_version = CASE WHEN server_version < ? THEN ? ELSE server_version END
              WHERE account_id = ? AND crew_id = ? AND session_id = ? AND point_id = ?`,
        bind: [
          pending,
          change.version,
          change.state,
          change.version,
          change.state,
          change.version,
          change.version,
          input.accountId,
          input.crewId,
          input.sessionId,
          change.pointId,
        ],
      });
    }
    transaction.exec({
      sql: `UPDATE sync_cursor SET cursor_value = ?
            WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
      bind: [input.cursor, input.accountId, input.crewId, input.sessionId],
    });
  });
  return { applied: input.changes.length };
}

function applyChanges(input: Extract<LocalDatabaseRequest, { type: "apply-changes" }>) {
  return applySyncChanges(requireDatabase(), input);
}

async function handle(request: LocalDatabaseRequest): Promise<unknown> {
  if (request.type === "init") return initialize();
  await initialize();
  switch (request.type) {
    case "bind-account":
      return bindLocalAccount(requireDatabase(), request);
    case "clear-account":
      return clearAccount(request.accountId);
    case "install-package":
      return installPackage(request.accountId, request.package);
    case "save-work-session":
      return saveWorkSession(request);
    case "get-outbox-status":
      return getOutboxStatus(request.accountId, request.crewId, request.sessionId);
    case "get-context":
      return getContext(request.accountId, request.crewId, request.sessionId);
    case "list-points":
      return listPoints(request.accountId, request.crewId, request.sessionId);
    case "mark-point":
      return markPoint(request);
    case "undo-operation":
      return undoOperation(request);
    case "start-h40-run":
      return startLocalH40Run(requireDatabase(), request);
    case "get-running-h40-run":
      return getRunningLocalH40Run(requireDatabase(), request);
    case "get-latest-h40-run":
      return getLatestLocalH40Run(requireDatabase(), request);
    case "get-h40-run-summary":
      return getLocalH40RunSummary(requireDatabase(), request);
    case "complete-h40-action":
      return completeLocalH40Action(requireDatabase(), request);
    case "record-h40-metric":
      return recordLocalH40Metric(requireDatabase(), request);
    case "get-h40-evidence-source":
      return getLocalH40EvidenceSource(requireDatabase(), request);
    case "mark-h40-run-exported":
      return markLocalH40RunExported(requireDatabase(), request);
    case "finish-h40-run":
      return finishLocalH40Run(requireDatabase(), request);
    case "abort-h40-run":
      return abortLocalH40Run(requireDatabase(), request);
    case "resolve-conflict":
      return resolveLocalConflict(requireDatabase(), request);
    case "list-history":
      return listOperations(request.accountId, request.crewId, request.sessionId, false);
    case "list-pending":
      return listOperations(request.accountId, request.crewId, request.sessionId, true);
    case "mark-sending":
    case "restore-pending":
      return transitionOperations(request);
    case "get-cursor":
      return {
        cursor: String(
          requireDatabase().selectValue(
            `SELECT cursor_value FROM sync_cursor
             WHERE account_id = ? AND crew_id = ? AND session_id = ?`,
            [request.accountId, request.crewId, request.sessionId],
          ) ?? "",
        ),
      };
    case "apply-results":
      return applyResults(request);
    case "apply-changes":
      return applyChanges(request);
  }
}

workerScope.addEventListener("message", (event: MessageEvent<LocalDatabaseRequest>) => {
  void handle(event.data)
    .then((result) => {
      const response: LocalDatabaseResponse = {
        id: event.data.id,
        ok: true,
        result,
      } as LocalDatabaseResponse;
      workerScope.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: LocalDatabaseResponse = {
        id: event.data.id,
        ok: false,
        error: error instanceof Error ? error.message : "LOCAL_DATABASE_ERROR",
      };
      workerScope.postMessage(response);
    });
});
