import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const EVIDENCE_VERSION = 1;
const LOCAL_SCHEMA_VERSION = 8;
const MINIMUM_ACTIONS = 30;
const MAXIMUM_ACTIONS = 500;
const MAXIMUM_VISUAL_P95_MS = 200;
const MINIMUM_OFFLINE_MS = 20 * 60 * 1_000;
const MAXIMUM_EVIDENCE_BYTES = 2 * 1_024 * 1_024;
const OPERATION_FINGERPRINT_DOMAIN = "rutacuadrilla:h40:operation:v1:";
const PROJECTION_HASH_DOMAIN = "rutacuadrilla:h40:projection:v1:";
const RUN_SALT_DOMAIN = "rutacuadrilla:h40:run-salt:v1\n";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const TOP_LEVEL_KEYS = [
  "app",
  "counts",
  "createdAt",
  "deviceAlias",
  "endedAt",
  "environment",
  "finalOutbox",
  "fingerprintSalt",
  "integrity",
  "latenciesMs",
  "manifestHash",
  "measurementActive",
  "metricSummary",
  "operationFingerprints",
  "persistLatenciesMs",
  "persistenceSummary",
  "projectionHash",
  "recoveredSending",
  "runSaltDigest",
  "status",
  "summary",
  "version",
];

export class H40VerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "H40VerificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new H40VerificationError(code);
}

function assertCondition(condition, code) {
  if (!condition) fail(code);
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isLatency(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function canonicalH40Json(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_JSON_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalH40Json(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) fail("CANONICAL_JSON_UNSUPPORTED_VALUE");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalH40Json(value[key])}`)
    .join(",")}}`;
}

export function sha256H40Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashH40OperationFingerprint(salt, operationId) {
  assertCondition(SHA256_HEX.test(salt), "FINGERPRINT_SALT_INVALID");
  assertCondition(
    typeof operationId === "string" && operationId.length > 0 && operationId.length <= 512,
    "SERVER_OPERATION_ID_INVALID",
  );
  return sha256H40Hex(`${OPERATION_FINGERPRINT_DOMAIN}${salt}${operationId}`);
}

export function hashH40Projection(salt, rows) {
  assertCondition(SHA256_HEX.test(salt), "FINGERPRINT_SALT_INVALID");
  assertCondition(Array.isArray(rows), "SERVER_PROJECTION_INVALID");
  const canonicalRows = rows.map((row) => {
    assertCondition(
      isPlainRecord(row) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        row.id.length <= 512 &&
        typeof row.state === "string" &&
        row.state.length > 0 &&
        row.state.length <= 64 &&
        isNonNegativeInteger(row.version),
      "SERVER_PROJECTION_INVALID",
    );
    return { id: row.id, state: row.state, version: row.version };
  });
  canonicalRows.sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    if (left.state !== right.state) return left.state < right.state ? -1 : 1;
    return left.version - right.version;
  });
  return sha256H40Hex(`${PROJECTION_HASH_DOMAIN}${salt}${canonicalH40Json(canonicalRows)}`);
}

function nearestRank(samples, percentile) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

function expectedLatencySummary(samples) {
  return {
    sampleCount: samples.length,
    p50Ms: nearestRank(samples, 0.5),
    p95Ms: nearestRank(samples, 0.95),
    minimumSampleSize: MINIMUM_ACTIONS,
    minimumSampleSizeMet: samples.length >= MINIMUM_ACTIONS,
  };
}

function validateLatencySummary(summary, samples, label) {
  assertCondition(
    hasExactKeys(summary, [
      "minimumSampleSize",
      "minimumSampleSizeMet",
      "p50Ms",
      "p95Ms",
      "sampleCount",
    ]),
    `${label}_SUMMARY_SHAPE_INVALID`,
  );
  assertCondition(
    canonicalH40Json(summary) === canonicalH40Json(expectedLatencySummary(samples)),
    `${label}_SUMMARY_MISMATCH`,
  );
}

function validateMetricSummary(summary, confirmRestartGap) {
  assertCondition(
    hasExactKeys(summary, [
      "applied",
      "clockRollbackDetected",
      "conflict",
      "errorEvents",
      "manualConfirmationRequired",
      "maxPending",
      "offlineObservedMs",
      "offlineTotalMs",
      "rejected",
      "replayed",
      "restartGapMs",
      "syncDurationMs",
    ]),
    "METRIC_SUMMARY_SHAPE_INVALID",
  );
  for (const key of ["offlineObservedMs", "offlineTotalMs", "restartGapMs", "syncDurationMs"]) {
    assertCondition(isLatency(summary[key]), "METRIC_DURATION_INVALID");
  }
  for (const key of ["applied", "conflict", "errorEvents", "maxPending", "rejected", "replayed"]) {
    assertCondition(isNonNegativeInteger(summary[key]), "METRIC_COUNT_INVALID");
  }
  assertCondition(
    typeof summary.clockRollbackDetected === "boolean" &&
      typeof summary.manualConfirmationRequired === "boolean",
    "METRIC_FLAG_INVALID",
  );
  assertCondition(
    summary.offlineTotalMs === summary.offlineObservedMs + summary.restartGapMs,
    "OFFLINE_TOTAL_MISMATCH",
  );
  assertCondition(summary.offlineTotalMs >= MINIMUM_OFFLINE_MS, "OFFLINE_DURATION_TOO_SHORT");
  assertCondition(!summary.clockRollbackDetected, "CLOCK_ROLLBACK_DETECTED");
  if (summary.manualConfirmationRequired) {
    assertCondition(summary.restartGapMs > 0, "MANUAL_CONFIRMATION_REASON_UNSUPPORTED");
    assertCondition(confirmRestartGap, "RESTART_GAP_CONFIRMATION_REQUIRED");
  }
}

function validateEnvironment(environment) {
  assertCondition(
    hasExactKeys(environment, [
      "crossOriginIsolated",
      "online",
      "opfsPersistent",
      "secureContext",
      "serviceWorkerControlled",
    ]),
    "ENVIRONMENT_SHAPE_INVALID",
  );
  for (const value of Object.values(environment)) {
    assertCondition(typeof value === "boolean", "ENVIRONMENT_VALUE_INVALID");
  }
  assertCondition(environment.secureContext, "SECURE_CONTEXT_REQUIRED");
  assertCondition(environment.crossOriginIsolated, "CROSS_ORIGIN_ISOLATION_REQUIRED");
  assertCondition(environment.opfsPersistent, "OPFS_PERSISTENCE_REQUIRED");
  assertCondition(environment.serviceWorkerControlled, "SERVICE_WORKER_CONTROL_REQUIRED");
}

function validateCounts(counts, sampleCount) {
  assertCondition(
    hasExactKeys(counts, [
      "conflicts",
      "duplicateOperations",
      "lostOperations",
      "markActions",
      "pendingOperations",
      "successfulActions",
      "undoActions",
    ]),
    "COUNTS_SHAPE_INVALID",
  );
  for (const key of [
    "conflicts",
    "markActions",
    "pendingOperations",
    "successfulActions",
    "undoActions",
  ]) {
    assertCondition(isNonNegativeInteger(counts[key]), "COUNT_VALUE_INVALID");
  }
  assertCondition(counts.successfulActions === sampleCount, "ACTION_COUNT_MISMATCH");
  assertCondition(
    counts.markActions + counts.undoActions === counts.successfulActions,
    "ACTION_KIND_COUNT_MISMATCH",
  );
  assertCondition(counts.pendingOperations === 0, "PENDING_OPERATIONS_REMAIN");
  assertCondition(counts.conflicts === 0, "ATTENTION_REMAINS");
  assertCondition(
    counts.lostOperations === null && counts.duplicateOperations === null,
    "LOCAL_RECONCILIATION_MUST_BE_UNKNOWN",
  );
}

function validateFinalOutbox(finalOutbox) {
  assertCondition(
    hasExactKeys(finalOutbox, ["conflict", "pending", "rejected", "sending"]),
    "FINAL_OUTBOX_SHAPE_INVALID",
  );
  for (const value of Object.values(finalOutbox)) {
    assertCondition(isNonNegativeInteger(value), "FINAL_OUTBOX_VALUE_INVALID");
    assertCondition(value === 0, "FINAL_OUTBOX_NOT_EMPTY");
  }
}

export function validateH40EvidenceExport(evidence, expectedAlias, options = {}) {
  assertCondition(expectedAlias === "A" || expectedAlias === "B", "EXPECTED_ALIAS_INVALID");
  assertCondition(hasExactKeys(evidence, TOP_LEVEL_KEYS), "EVIDENCE_SHAPE_INVALID");
  assertCondition(evidence.version === EVIDENCE_VERSION, "EVIDENCE_VERSION_INVALID");
  assertCondition(evidence.deviceAlias === expectedAlias, "DEVICE_ALIAS_MISMATCH");
  assertCondition(isCanonicalTimestamp(evidence.createdAt), "CREATED_AT_INVALID");
  assertCondition(isCanonicalTimestamp(evidence.endedAt), "ENDED_AT_INVALID");
  assertCondition(
    new Date(evidence.endedAt).valueOf() >= new Date(evidence.createdAt).valueOf(),
    "EVIDENCE_TIME_ORDER_INVALID",
  );
  assertCondition(evidence.status === "FINISHED", "MEASUREMENT_NOT_FINISHED");
  assertCondition(evidence.measurementActive === false, "MEASUREMENT_STILL_ACTIVE");

  assertCondition(
    hasExactKeys(evidence.app, ["schemaVersion", "shellVersion", "version"]),
    "APP_SHAPE_INVALID",
  );
  assertCondition(SAFE_VERSION.test(evidence.app.version), "APP_VERSION_INVALID");
  assertCondition(SAFE_VERSION.test(evidence.app.shellVersion), "SHELL_VERSION_INVALID");
  assertCondition(evidence.app.version === evidence.app.shellVersion, "SHELL_BUILD_MISMATCH");
  assertCondition(evidence.app.schemaVersion === LOCAL_SCHEMA_VERSION, "LOCAL_SCHEMA_MISMATCH");
  validateEnvironment(evidence.environment);

  assertCondition(
    Array.isArray(evidence.latenciesMs) &&
      evidence.latenciesMs.length >= MINIMUM_ACTIONS &&
      evidence.latenciesMs.length <= MAXIMUM_ACTIONS &&
      evidence.latenciesMs.every(isLatency),
    "VISUAL_LATENCIES_INVALID",
  );
  assertCondition(
    Array.isArray(evidence.persistLatenciesMs) &&
      evidence.persistLatenciesMs.length === evidence.latenciesMs.length &&
      evidence.persistLatenciesMs.every(isLatency),
    "PERSISTENCE_LATENCIES_INVALID",
  );
  validateLatencySummary(evidence.summary, evidence.latenciesMs, "VISUAL");
  validateLatencySummary(evidence.persistenceSummary, evidence.persistLatenciesMs, "PERSISTENCE");
  assertCondition(
    evidence.summary.p95Ms !== null && evidence.summary.p95Ms <= MAXIMUM_VISUAL_P95_MS,
    "VISUAL_P95_EXCEEDED",
  );
  validateCounts(evidence.counts, evidence.latenciesMs.length);
  validateMetricSummary(evidence.metricSummary, options.confirmRestartGap === true);
  validateFinalOutbox(evidence.finalOutbox);
  assertCondition(isNonNegativeInteger(evidence.recoveredSending), "RECOVERED_SENDING_INVALID");

  assertCondition(SHA256_HEX.test(evidence.fingerprintSalt), "FINGERPRINT_SALT_INVALID");
  assertCondition(SHA256_HEX.test(evidence.runSaltDigest), "RUN_SALT_DIGEST_INVALID");
  assertCondition(SHA256_HEX.test(evidence.manifestHash), "MANIFEST_HASH_INVALID");
  assertCondition(SHA256_HEX.test(evidence.projectionHash), "PROJECTION_HASH_INVALID");
  assertCondition(
    Array.isArray(evidence.operationFingerprints) &&
      evidence.operationFingerprints.length === evidence.latenciesMs.length &&
      evidence.operationFingerprints.every((value) => SHA256_HEX.test(value)),
    "OPERATION_FINGERPRINTS_INVALID",
  );
  assertCondition(
    new Set(evidence.operationFingerprints).size === evidence.operationFingerprints.length,
    "OPERATION_FINGERPRINT_DUPLICATED",
  );
  const expectedRunSaltDigest = sha256H40Hex(`${RUN_SALT_DOMAIN}${evidence.fingerprintSalt}`);
  assertCondition(evidence.runSaltDigest === expectedRunSaltDigest, "RUN_SALT_DIGEST_MISMATCH");
  const expectedManifest = sha256H40Hex(
    canonicalH40Json({
      fingerprintSalt: evidence.fingerprintSalt,
      operationFingerprints: [...evidence.operationFingerprints].sort(),
      projectionHash: evidence.projectionHash,
      runSaltDigest: evidence.runSaltDigest,
      version: EVIDENCE_VERSION,
    }),
  );
  assertCondition(evidence.manifestHash === expectedManifest, "MANIFEST_HASH_MISMATCH");
  assertCondition(
    hasExactKeys(evidence.integrity, ["algorithm", "canonicalContentHash"]),
    "INTEGRITY_SHAPE_INVALID",
  );
  assertCondition(evidence.integrity.algorithm === "SHA-256", "INTEGRITY_ALGORITHM_INVALID");
  assertCondition(
    SHA256_HEX.test(evidence.integrity.canonicalContentHash),
    "CANONICAL_CONTENT_HASH_INVALID",
  );
  const { integrity: _integrity, ...canonicalContent } = evidence;
  assertCondition(
    evidence.integrity.canonicalContentHash === sha256H40Hex(canonicalH40Json(canonicalContent)),
    "CANONICAL_CONTENT_HASH_MISMATCH",
  );
  return evidence;
}

function normalizedUuid(value, code) {
  assertCondition(typeof value === "string" && UUID.test(value), code);
  return value.toLowerCase();
}

function numericVersion(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  assertCondition(isNonNegativeInteger(parsed), "SERVER_PROJECTION_VERSION_INVALID");
  return parsed;
}

function positiveSequence(value, code = "SERVER_CHANGE_SEQUENCE_INVALID") {
  const parsed = typeof value === "number" ? value : Number(value);
  assertCondition(Number.isSafeInteger(parsed) && parsed > 0, code);
  return parsed;
}

function serverResult(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      assertCondition(isPlainRecord(parsed), "SERVER_RECEIPT_RESULT_INVALID");
      return parsed;
    } catch (error) {
      if (error instanceof H40VerificationError) throw error;
      fail("SERVER_RECEIPT_RESULT_INVALID");
    }
  }
  assertCondition(isPlainRecord(value), "SERVER_RECEIPT_RESULT_INVALID");
  return value;
}

export async function loadH40ServerSnapshot(database, workSessionId) {
  const normalizedWorkSessionId = normalizedUuid(workSessionId, "WORK_SESSION_ID_INVALID");
  const sessionResult = await database.query(
    `SELECT crew_id::text AS "crewId",
            id::text AS "workSessionId",
            campaign_route_id::text AS "campaignRouteId",
            status
       FROM work_session
      WHERE id = $1
      ORDER BY crew_id
      LIMIT 2`,
    [normalizedWorkSessionId],
  );
  assertCondition(sessionResult.rows.length === 1, "WORK_SESSION_NOT_UNIQUE_OR_MISSING");
  const session = sessionResult.rows[0];
  assertCondition(
    isPlainRecord(session) &&
      typeof session.crewId === "string" &&
      typeof session.campaignRouteId === "string" &&
      typeof session.workSessionId === "string" &&
      (session.status === "ACTIVE" || session.status === "FINISHED"),
    "SERVER_WORK_SESSION_INVALID",
  );

  const [receiptResult, eventResult, pointResult] = await Promise.all([
    database.query(
      `SELECT operation_id::text AS "operationId",
              campaign_point_id::text AS "campaignPointId",
              device_id::text AS "deviceId",
              actor_membership_id::text AS "membershipId",
              status,
              result_json AS "resultJson",
              change_sequence::text AS "changeSequence"
         FROM sync_operation_receipt
        WHERE crew_id = $1 AND work_session_id = $2
        ORDER BY operation_id`,
      [session.crewId, session.workSessionId],
    ),
    database.query(
      `SELECT event.operation_id::text AS "operationId",
              event.campaign_point_id::text AS "campaignPointId",
              event.actor_membership_id::text AS "membershipId",
              event.device_id::text AS "deviceId",
              event.work_session_id::text AS "workSessionId",
              event.previous_state AS "previousState",
              event.next_state AS "nextState",
              event.applied_version::text AS "appliedVersion",
              change.sequence::text AS sequence
         FROM point_event AS event
         JOIN sync_change AS change
           ON change.crew_id = event.crew_id AND change.event_id = event.id
        WHERE event.crew_id = $1 AND event.campaign_route_id = $2
        ORDER BY change.sequence`,
      [session.crewId, session.campaignRouteId],
    ),
    database.query(
      `SELECT id::text AS id
         FROM campaign_point
        WHERE crew_id = $1 AND campaign_route_id = $2
        ORDER BY id`,
      [session.crewId, session.campaignRouteId],
    ),
  ]);

  const receipts = receiptResult.rows.map((row) => {
    assertCondition(
      isPlainRecord(row) &&
        typeof row.operationId === "string" &&
        typeof row.campaignPointId === "string" &&
        typeof row.deviceId === "string" &&
        typeof row.membershipId === "string" &&
        ["APPLIED", "CONFLICT", "REJECTED", "BLOCKED_DEPENDENCY"].includes(row.status),
      "SERVER_RECEIPT_INVALID",
    );
    const result = serverResult(row.resultJson);
    assertCondition(
      result.campaignPointId === row.campaignPointId &&
        result.operationId === row.operationId &&
        result.workSessionId === session.workSessionId &&
        result.status === row.status,
      "SERVER_RECEIPT_RESULT_MISMATCH",
    );
    let changeSequence = null;
    if (row.status === "APPLIED") {
      changeSequence = positiveSequence(row.changeSequence);
    } else {
      assertCondition(row.changeSequence === null, "NON_APPLIED_CHANGE_SEQUENCE_PRESENT");
    }
    const conflictVersion = row.status === "CONFLICT" ? numericVersion(result.version) : null;
    const conflictState = row.status === "CONFLICT" ? result.state : null;
    assertCondition(
      row.status !== "CONFLICT" || (typeof conflictState === "string" && conflictState.length > 0),
      "SERVER_CONFLICT_STATE_INVALID",
    );
    return {
      campaignPointId: row.campaignPointId,
      changeSequence,
      conflictState,
      conflictVersion,
      deviceId: row.deviceId,
      membershipId: row.membershipId,
      operationId: row.operationId,
      status: row.status,
    };
  });
  const canonicalEvents = eventResult.rows.map((row) => {
    assertCondition(
      isPlainRecord(row) &&
        typeof row.operationId === "string" &&
        typeof row.campaignPointId === "string" &&
        typeof row.membershipId === "string" &&
        typeof row.deviceId === "string" &&
        (typeof row.workSessionId === "string" || row.workSessionId === null) &&
        typeof row.previousState === "string" &&
        typeof row.nextState === "string",
      "SERVER_EVENT_INVALID",
    );
    return {
      appliedVersion: numericVersion(row.appliedVersion),
      campaignPointId: row.campaignPointId,
      deviceId: row.deviceId,
      membershipId: row.membershipId,
      nextState: row.nextState,
      operationId: row.operationId,
      previousState: row.previousState,
      sequence: positiveSequence(row.sequence),
      workSessionId: row.workSessionId,
    };
  });
  const eventCounts = new Map();
  const eventByOperation = new Map();
  for (const event of canonicalEvents) {
    eventCounts.set(event.operationId, (eventCounts.get(event.operationId) ?? 0) + 1);
    if (!eventByOperation.has(event.operationId)) eventByOperation.set(event.operationId, event);
  }
  const points = pointResult.rows.map((row) => {
    assertCondition(
      isPlainRecord(row) && typeof row.id === "string" && row.id.length > 0,
      "SERVER_POINT_INVALID",
    );
    return row.id;
  });
  assertCondition(points.length > 0, "SERVER_PROJECTION_EMPTY");
  assertCondition(new Set(points).size === points.length, "SERVER_POINT_DUPLICATED");
  return {
    campaignRouteId: session.campaignRouteId,
    canonicalEvents,
    crewId: session.crewId,
    eventByOperation,
    eventCounts,
    points,
    receipts,
    status: session.status,
    workSessionId: session.workSessionId,
  };
}

export function reconcileH40Evidence(evidence, serverSnapshot) {
  const receiptByFingerprint = new Map();
  for (const receipt of serverSnapshot.receipts) {
    const fingerprint = hashH40OperationFingerprint(evidence.fingerprintSalt, receipt.operationId);
    assertCondition(!receiptByFingerprint.has(fingerprint), "SERVER_FINGERPRINT_COLLISION");
    receiptByFingerprint.set(fingerprint, receipt);
  }

  const operationIds = new Set();
  const appliedOperationIds = new Set();
  const appliedChangeSequences = [];
  const conflicts = [];
  const deviceIds = new Set();
  const membershipIds = new Set();
  let appliedReceipts = 0;
  let conflictReceipts = 0;
  let nonAppliedReceipts = 0;
  for (const fingerprint of evidence.operationFingerprints) {
    const receipt = receiptByFingerprint.get(fingerprint);
    assertCondition(receipt, "SERVER_RECEIPT_MISSING");
    operationIds.add(receipt.operationId);
    deviceIds.add(receipt.deviceId);
    membershipIds.add(receipt.membershipId);
    const eventCount = serverSnapshot.eventCounts.get(receipt.operationId) ?? 0;
    if (receipt.status === "APPLIED") {
      assertCondition(
        eventCount === 1,
        eventCount === 0 ? "SERVER_EFFECT_MISSING" : "SERVER_EFFECT_DUPLICATED",
      );
      const event = serverSnapshot.eventByOperation.get(receipt.operationId);
      assertCondition(
        event?.sequence === receipt.changeSequence,
        "SERVER_CHANGE_SEQUENCE_MISMATCH",
      );
      appliedChangeSequences.push(receipt.changeSequence);
      appliedOperationIds.add(receipt.operationId);
      appliedReceipts += 1;
    } else {
      assertCondition(eventCount === 0, "NON_APPLIED_RECEIPT_HAS_EFFECT");
      nonAppliedReceipts += 1;
      if (receipt.status === "CONFLICT") {
        conflictReceipts += 1;
        conflicts.push({
          campaignPointId: receipt.campaignPointId,
          operationId: receipt.operationId,
          state: receipt.conflictState,
          version: receipt.conflictVersion,
        });
      }
    }
  }
  assertCondition(deviceIds.size === 1, "EVIDENCE_SPANS_MULTIPLE_DEVICES");
  assertCondition(membershipIds.size === 1, "EVIDENCE_SPANS_MULTIPLE_MEMBERSHIPS");
  assertCondition(appliedChangeSequences.length > 0, "MEASURED_APPLIED_REQUIRED");

  return {
    alias: evidence.deviceAlias,
    appliedChangeSequences,
    appliedOperationIds,
    appliedReceipts,
    campaignRouteId: serverSnapshot.campaignRouteId,
    conflicts,
    conflictReceipts,
    crewId: serverSnapshot.crewId,
    deviceId: [...deviceIds][0],
    membershipId: [...membershipIds][0],
    nonAppliedReceipts,
    offlineMs: evidence.metricSummary.offlineTotalMs,
    operationIds,
    persistenceP95Ms: evidence.persistenceSummary.p95Ms,
    recoveredSending: evidence.recoveredSending,
    replayed: evidence.metricSummary.replayed,
    serverReceipts: evidence.operationFingerprints.length,
    successfulActions: evidence.counts.successfulActions,
    syncConflicts: evidence.metricSummary.conflict,
    visualP50Ms: evidence.summary.p50Ms,
    visualP95Ms: evidence.summary.p95Ms,
    workSessionId: serverSnapshot.workSessionId,
  };
}

function validateCanonicalTimeline(serverSnapshot) {
  const pointStates = new Map(
    serverSnapshot.points.map((id) => [id, { id, state: "SIN_VISITAR", version: 0 }]),
  );
  let previousSequence = 0;
  for (const event of serverSnapshot.canonicalEvents) {
    assertCondition(event.sequence > previousSequence, "SERVER_CHANGE_SEQUENCE_NOT_STRICT");
    previousSequence = event.sequence;
    const current = pointStates.get(event.campaignPointId);
    assertCondition(current, "SERVER_EVENT_POINT_OUTSIDE_ROUTE");
    assertCondition(
      event.appliedVersion === current.version + 1 && event.previousState === current.state,
      "SERVER_EVENT_CHAIN_INVALID",
    );
    pointStates.set(event.campaignPointId, {
      id: event.campaignPointId,
      state: event.nextState,
      version: event.appliedVersion,
    });
  }
}

function projectionAtSequence(serverSnapshot, cutoffSequence) {
  const pointStates = new Map(
    serverSnapshot.points.map((id) => [id, { id, state: "SIN_VISITAR", version: 0 }]),
  );
  for (const event of serverSnapshot.canonicalEvents) {
    if (event.sequence > cutoffSequence) break;
    pointStates.set(event.campaignPointId, {
      id: event.campaignPointId,
      state: event.nextState,
      version: event.appliedVersion,
    });
  }
  return [...pointStates.values()];
}

function findFirstCommonProjectionCutoff(evidenceA, evidenceB, serverSnapshot, minimumSequence) {
  validateCanonicalTimeline(serverSnapshot);
  const candidateSequences = [
    minimumSequence,
    ...serverSnapshot.canonicalEvents
      .map((event) => event.sequence)
      .filter((sequence) => sequence > minimumSequence),
  ];
  for (const cutoffSequence of candidateSequences) {
    const projection = projectionAtSequence(serverSnapshot, cutoffSequence);
    if (
      hashH40Projection(evidenceA.fingerprintSalt, projection) === evidenceA.projectionHash &&
      hashH40Projection(evidenceB.fingerprintSalt, projection) === evidenceB.projectionHash
    ) {
      return cutoffSequence;
    }
  }
  fail("COMMON_CANONICAL_CUTOFF_NOT_FOUND");
}

function proveControlledConflicts(resultA, resultB, serverSnapshot) {
  const eventByPointVersion = new Map();
  for (const event of serverSnapshot.canonicalEvents) {
    if (event.workSessionId !== resultA.workSessionId) continue;
    const key = `${event.campaignPointId}:${event.appliedVersion}`;
    assertCondition(!eventByPointVersion.has(key), "SERVER_POINT_VERSION_DUPLICATED");
    eventByPointVersion.set(key, event);
  }
  const controlledPairs = new Set();
  const proveDirection = (source, other) => {
    for (const conflict of source.conflicts) {
      const key = `${conflict.campaignPointId}:${conflict.version}`;
      const event = eventByPointVersion.get(key);
      assertCondition(
        event &&
          event.deviceId === other.deviceId &&
          event.membershipId === other.membershipId &&
          event.nextState === conflict.state &&
          other.appliedOperationIds.has(event.operationId),
        "CONTROLLED_CONFLICT_NOT_CROSS_DEVICE",
      );
      controlledPairs.add(key);
    }
  };
  proveDirection(resultA, resultB);
  proveDirection(resultB, resultA);
  assertCondition(controlledPairs.size >= 2, "CONTROLLED_CONFLICT_PAIRS_INSUFFICIENT");
  return controlledPairs.size;
}

export async function verifyH40EvidencePair(input) {
  const evidenceA = validateH40EvidenceExport(input.evidenceA, "A", {
    confirmRestartGap: input.confirmRestartGap === true,
  });
  const evidenceB = validateH40EvidenceExport(input.evidenceB, "B", {
    confirmRestartGap: input.confirmRestartGap === true,
  });
  const [snapshotA, snapshotB] = await Promise.all([
    loadH40ServerSnapshot(input.database, input.workSessionA),
    loadH40ServerSnapshot(input.database, input.workSessionB),
  ]);
  assertCondition(snapshotA.crewId === snapshotB.crewId, "DEVICES_NOT_IN_SAME_CREW");
  assertCondition(
    snapshotA.campaignRouteId === snapshotB.campaignRouteId,
    "DEVICES_NOT_IN_SAME_CAMPAIGN_ROUTE",
  );
  assertCondition(
    snapshotA.workSessionId === snapshotB.workSessionId,
    "DEVICES_NOT_IN_SAME_WORK_SESSION",
  );
  assertCondition(
    canonicalH40Json(snapshotA.points) === canonicalH40Json(snapshotB.points) &&
      canonicalH40Json(snapshotA.canonicalEvents) === canonicalH40Json(snapshotB.canonicalEvents) &&
      canonicalH40Json(snapshotA.receipts) === canonicalH40Json(snapshotB.receipts) &&
      snapshotA.status === snapshotB.status,
    "SERVER_SNAPSHOT_CHANGED_DURING_VERIFICATION",
  );
  const resultA = reconcileH40Evidence(evidenceA, snapshotA);
  const resultB = reconcileH40Evidence(evidenceB, snapshotB);

  assertCondition(resultA.deviceId !== resultB.deviceId, "PHYSICAL_DEVICE_NOT_DISTINCT");
  assertCondition(resultA.membershipId !== resultB.membershipId, "PARTICIPANT_NOT_DISTINCT");
  for (const operationId of resultA.operationIds) {
    assertCondition(!resultB.operationIds.has(operationId), "EVIDENCE_OPERATION_OVERLAP");
  }
  assertCondition(
    resultA.syncConflicts + resultB.syncConflicts >= 2 &&
      resultA.conflictReceipts + resultB.conflictReceipts >= 2,
    "CONTROLLED_CONFLICTS_NOT_PROVEN",
  );
  const controlledConflictPairs = proveControlledConflicts(resultA, resultB, snapshotA);
  const minimumProjectionSequence = Math.max(
    ...resultA.appliedChangeSequences,
    ...resultB.appliedChangeSequences,
  );
  findFirstCommonProjectionCutoff(evidenceA, evidenceB, snapshotA, minimumProjectionSequence);
  assertCondition(
    resultA.recoveredSending + resultB.recoveredSending >= 1 &&
      resultA.replayed + resultB.replayed >= 1,
    "SENDING_RECOVERY_NOT_PROVEN",
  );

  const publicDevice = (result) => ({
    alias: result.alias,
    appliedReceipts: result.appliedReceipts,
    conflictReceipts: result.conflictReceipts,
    duplicateEffects: 0,
    lostOperations: 0,
    nonAppliedReceipts: result.nonAppliedReceipts,
    offlineMinutes: Math.round((result.offlineMs / 60_000) * 100) / 100,
    persistenceP95Ms: result.persistenceP95Ms,
    serverReceipts: result.serverReceipts,
    successfulActions: result.successfulActions,
    visualP50Ms: result.visualP50Ms,
    visualP95Ms: result.visualP95Ms,
  });
  return {
    status: "PASA",
    devices: [publicDevice(resultA), publicDevice(resultB)],
    aggregate: {
      controlledConflicts: resultA.conflictReceipts + resultB.conflictReceipts,
      controlledConflictPairs,
      duplicateEffects: 0,
      lostOperations: 0,
      recoveredSending: resultA.recoveredSending + resultB.recoveredSending,
      replayed: resultA.replayed + resultB.replayed,
      serverReceipts: resultA.serverReceipts + resultB.serverReceipts,
      successfulActions: resultA.successfulActions + resultB.successfulActions,
    },
  };
}

export function parseH40VerifierArguments(argumentsList) {
  const values = {};
  let confirmRestartGap = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const key = argumentsList[index];
    if (key === "--confirm-restart-gap") {
      assertCondition(!confirmRestartGap, "CLI_ARGUMENT_DUPLICATED");
      confirmRestartGap = true;
      continue;
    }
    assertCondition(
      [
        "--database-dir",
        "--evidence-a",
        "--evidence-b",
        "--work-session-a",
        "--work-session-b",
      ].includes(key),
      "CLI_ARGUMENT_INVALID",
    );
    const value = argumentsList[index + 1];
    assertCondition(typeof value === "string" && value.length > 0, "CLI_ARGUMENT_VALUE_MISSING");
    assertCondition(!Object.hasOwn(values, key), "CLI_ARGUMENT_DUPLICATED");
    values[key] = value;
    index += 1;
  }
  for (const key of [
    "--database-dir",
    "--evidence-a",
    "--evidence-b",
    "--work-session-a",
    "--work-session-b",
  ]) {
    assertCondition(Object.hasOwn(values, key), "CLI_ARGUMENT_MISSING");
  }
  assertCondition(isAbsolute(values["--database-dir"]), "DATABASE_PATH_MUST_BE_ABSOLUTE");
  assertCondition(isAbsolute(values["--evidence-a"]), "EVIDENCE_PATH_MUST_BE_ABSOLUTE");
  assertCondition(isAbsolute(values["--evidence-b"]), "EVIDENCE_PATH_MUST_BE_ABSOLUTE");
  return {
    confirmRestartGap,
    databaseDir: resolve(values["--database-dir"]),
    evidenceAPath: resolve(values["--evidence-a"]),
    evidenceBPath: resolve(values["--evidence-b"]),
    workSessionA: normalizedUuid(values["--work-session-a"], "WORK_SESSION_A_INVALID"),
    workSessionB: normalizedUuid(values["--work-session-b"], "WORK_SESSION_B_INVALID"),
  };
}

async function readEvidenceFile(path) {
  const physicalPath = await realpath(path).catch(() => fail("EVIDENCE_FILE_NOT_FOUND"));
  const information = await stat(physicalPath).catch(() => fail("EVIDENCE_FILE_INVALID"));
  assertCondition(information.isFile(), "EVIDENCE_FILE_INVALID");
  assertCondition(information.size <= MAXIMUM_EVIDENCE_BYTES, "EVIDENCE_FILE_TOO_LARGE");
  const serialized = await readFile(physicalPath, "utf8");
  try {
    return { evidence: JSON.parse(serialized), physicalPath };
  } catch {
    fail("EVIDENCE_JSON_INVALID");
  }
}

async function resolveDatabaseDirectory(path) {
  const physicalPath = await realpath(path).catch(() => fail("DATABASE_DIRECTORY_NOT_FOUND"));
  const information = await stat(physicalPath).catch(() => fail("DATABASE_DIRECTORY_INVALID"));
  assertCondition(information.isDirectory(), "DATABASE_DIRECTORY_INVALID");
  const root = parse(physicalPath).root;
  assertCondition(resolve(physicalPath) !== resolve(root), "DATABASE_DIRECTORY_TOO_BROAD");
  const baseDirectory = resolve(physicalPath, "base");
  const baseInformation = await stat(baseDirectory).catch(() => fail("DATABASE_SIGNATURE_MISSING"));
  assertCondition(baseInformation.isDirectory(), "DATABASE_SIGNATURE_MISSING");
  return physicalPath;
}

export async function runH40VerifierCli(argumentsList, output = process.stdout) {
  const options = parseH40VerifierArguments(argumentsList);
  const [databaseDir, evidenceAFile, evidenceBFile] = await Promise.all([
    resolveDatabaseDirectory(options.databaseDir),
    readEvidenceFile(options.evidenceAPath),
    readEvidenceFile(options.evidenceBPath),
  ]);
  assertCondition(
    evidenceAFile.physicalPath !== evidenceBFile.physicalPath,
    "EVIDENCE_FILES_MUST_BE_DISTINCT",
  );
  const database = new PGlite(databaseDir);
  try {
    await database.waitReady;
    const report = await verifyH40EvidencePair({
      confirmRestartGap: options.confirmRestartGap,
      database,
      evidenceA: evidenceAFile.evidence,
      evidenceB: evidenceBFile.evidence,
      workSessionA: options.workSessionA,
      workSessionB: options.workSessionB,
    });
    output.write(`${JSON.stringify(report)}\n`);
    return report;
  } finally {
    await database.close().catch(() => undefined);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runH40VerifierCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof H40VerificationError ? error.code : "VERIFIER_INTERNAL_ERROR";
    process.stdout.write(`${JSON.stringify({ status: "FALLA", codes: [code] })}\n`);
    process.exitCode = 1;
  });
}
