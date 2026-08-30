import { DatabaseSync } from "node:sqlite";

export class SqliteOutboxStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_point (
        crew_id TEXT NOT NULL,
        point_id TEXT NOT NULL,
        state TEXT NOT NULL,
        local_sequence INTEGER NOT NULL,
        PRIMARY KEY (crew_id, point_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outbox (
        crew_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_sequence INTEGER NOT NULL,
        point_id TEXT NOT NULL,
        depends_on_operation_id TEXT,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENDING', 'CONFIRMED', 'CONFLICT', 'REJECTED')),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (crew_id, operation_id)
      ) STRICT;
    `);
  }

  close() {
    this.database.close();
  }

  recordPointState({
    crewId,
    deviceId,
    deviceSequence,
    operationId,
    pointId,
    toState,
    dependsOnOperationId = null,
    payloadHash,
  }) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(`
          INSERT INTO local_point (crew_id, point_id, state, local_sequence)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (crew_id, point_id) DO UPDATE SET
            state = excluded.state,
            local_sequence = excluded.local_sequence
        `)
        .run(crewId, pointId, toState, deviceSequence);

      this.database
        .prepare(`
          INSERT INTO outbox (
            crew_id,
            operation_id,
            device_id,
            device_sequence,
            point_id,
            depends_on_operation_id,
            payload_hash,
            state,
            payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
        `)
        .run(
          crewId,
          operationId,
          deviceId,
          deviceSequence,
          pointId,
          dependsOnOperationId,
          payloadHash,
          JSON.stringify({ toState }),
        );

      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  getPoint(crewId, pointId) {
    return this.database
      .prepare(`
        SELECT
          crew_id AS crewId,
          point_id AS pointId,
          state,
          local_sequence AS localSequence
        FROM local_point
        WHERE crew_id = ? AND point_id = ?
      `)
      .get(crewId, pointId);
  }

  listPending(crewId) {
    return this.database
      .prepare(`
        SELECT
          operation_id AS operationId,
          device_sequence AS deviceSequence,
          point_id AS pointId,
          depends_on_operation_id AS dependsOnOperationId,
          payload_hash AS payloadHash,
          state
        FROM outbox
        WHERE crew_id = ? AND state = 'PENDING'
        ORDER BY device_sequence
      `)
      .all(crewId);
  }
}
