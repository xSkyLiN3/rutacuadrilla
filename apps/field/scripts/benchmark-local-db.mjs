import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

function integerArgument(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`INVALID_${name.toUpperCase()}`);
  return parsed;
}

const pointCount = integerArgument("points", 10_000);
const pendingCount = integerArgument("pending", 500);
const rounds = integerArgument("rounds", 9);

const schema = `
  PRAGMA journal_mode = MEMORY;
  PRAGMA synchronous = OFF;
  CREATE TABLE local_point (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    point_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    display_order INTEGER NOT NULL,
    state TEXT NOT NULL,
    server_state TEXT NOT NULL,
    server_version INTEGER NOT NULL,
    PRIMARY KEY (account_id, crew_id, session_id, point_id)
  ) STRICT;
  CREATE TABLE outbox (
    account_id TEXT NOT NULL,
    crew_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_sequence INTEGER NOT NULL,
    point_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    previous_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, crew_id, operation_id),
    UNIQUE (account_id, crew_id, device_id, device_sequence)
  ) STRICT;
  CREATE INDEX outbox_pending_idx
    ON outbox (account_id, crew_id, session_id, state, device_sequence);
`;

function quantile(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function summarize(values) {
  return {
    medianMs: Number(quantile(values, 0.5).toFixed(2)),
    p95Ms: Number(quantile(values, 0.95).toFixed(2)),
    samples: values.map((value) => Number(value.toFixed(2))),
  };
}

function runRound(round) {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  const insertPoint = database.prepare(
    `INSERT INTO local_point (
       account_id, crew_id, session_id, point_id, external_id,
       display_order, state, server_state, server_version
     ) VALUES ('partition-a', 'crew-a', 'session-a', ?, ?, ?, 'SIN_VISITAR', 'SIN_VISITAR', 0)`,
  );
  const installStarted = performance.now();
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < pointCount; index += 1) {
    insertPoint.run(`point-${index}`, `external-${index}`, index);
  }
  database.exec("COMMIT");
  const installMs = performance.now() - installStarted;

  const insertOperation = database.prepare(
    `INSERT INTO outbox (
       account_id, crew_id, session_id, operation_id, device_id, device_sequence,
       point_id, base_version, previous_state, to_state, state, created_at
     ) VALUES ('partition-a', 'crew-a', 'session-a', ?, 'device-a', ?, ?, 0,
               'SIN_VISITAR', 'VOLVER', ?, '2026-08-13T10:00:00.000Z')`,
  );
  database.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < pendingCount; index += 1) {
    insertOperation.run(
      `seed-operation-${index}`,
      index + 1,
      `point-${index % pointCount}`,
      index % 20 === 0 ? "SENDING" : "PENDING",
    );
  }
  database.exec("COMMIT");

  const loadStarted = performance.now();
  const points = database
    .prepare(
      `SELECT point_id, external_id, display_order, state, server_version
       FROM local_point
       WHERE account_id = 'partition-a' AND crew_id = 'crew-a' AND session_id = 'session-a'
       ORDER BY display_order, point_id`,
    )
    .all();
  const loadContextMs = performance.now() - loadStarted;
  if (points.length !== pointCount) throw new Error("BENCHMARK_POINT_COUNT_MISMATCH");

  const actionStarted = performance.now();
  database.exec("BEGIN IMMEDIATE");
  database
    .prepare(
      `UPDATE local_point SET state = 'APORTO'
       WHERE account_id = 'partition-a' AND crew_id = 'crew-a'
         AND session_id = 'session-a' AND point_id = ?`,
    )
    .run(`point-${pointCount - 1}`);
  insertOperation.run(
    `action-operation-${round}`,
    pendingCount + 1,
    `point-${pointCount - 1}`,
    "PENDING",
  );
  database.exec("COMMIT");
  const localActionMs = performance.now() - actionStarted;

  const pendingStarted = performance.now();
  const pending = database
    .prepare(
      `SELECT operation_id, device_sequence, point_id, state
       FROM outbox
       WHERE account_id = 'partition-a' AND crew_id = 'crew-a' AND session_id = 'session-a'
         AND state IN ('PENDING','SENDING')
       ORDER BY device_sequence LIMIT 100`,
    )
    .all();
  const pendingBatchMs = performance.now() - pendingStarted;
  if (pending.length !== Math.min(100, pendingCount + 1)) {
    throw new Error("BENCHMARK_OUTBOX_COUNT_MISMATCH");
  }

  const recoveryStarted = performance.now();
  database.exec("BEGIN IMMEDIATE");
  database.exec("UPDATE outbox SET state = 'PENDING' WHERE state = 'SENDING'");
  const recovered = Number(database.prepare("SELECT changes() AS count").get().count);
  database.exec("COMMIT");
  const startupRecoveryMs = performance.now() - recoveryStarted;
  database.close();

  return { installMs, loadContextMs, localActionMs, pendingBatchMs, recovered, startupRecoveryMs };
}

const heapBefore = process.memoryUsage().heapUsed;
const results = Array.from({ length: rounds }, (_, round) => runRound(round));
const metrics = Object.fromEntries(
  ["installMs", "loadContextMs", "localActionMs", "pendingBatchMs", "startupRecoveryMs"].map(
    (metric) => [metric, summarize(results.map((result) => result[metric]))],
  ),
);

console.log(
  JSON.stringify(
    {
      configuration: { pendingCount, pointCount, rounds },
      environment: { node: process.version, platform: `${process.platform}/${process.arch}` },
      heapDeltaMiB: Number(
        ((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2),
      ),
      metrics,
      recoveredSendingPerRound: results.map((result) => result.recovered),
      warning:
        "Guardrail reproducible de SQLite en Node. No acredita OPFS, renderizado, interacción, batería ni p95 en un teléfono real.",
    },
    null,
    2,
  ),
);
