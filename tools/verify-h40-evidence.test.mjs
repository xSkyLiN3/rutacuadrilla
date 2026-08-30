import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  canonicalH40Json,
  H40VerificationError,
  hashH40OperationFingerprint,
  hashH40Projection,
  parseH40VerifierArguments,
  reconcileH40Evidence,
  sha256H40Hex,
  validateH40EvidenceExport,
  verifyH40EvidencePair,
} from "./verify-h40-evidence.mjs";

const CREW_ID = "10000000-0000-4000-8000-000000000001";
const CREW_B_ID = "10000000-0000-4000-8000-000000000002";
const ROUTE_ID = "20000000-0000-4000-8000-000000000001";
const ROUTE_B_ID = "20000000-0000-4000-8000-000000000002";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const SESSION_B_ID = "30000000-0000-4000-8000-000000000002";
const DEVICE_A_ID = "40000000-0000-4000-8000-000000000001";
const DEVICE_B_ID = "40000000-0000-4000-8000-000000000002";
const MEMBER_A_ID = "50000000-0000-4000-8000-000000000001";
const MEMBER_B_ID = "50000000-0000-4000-8000-000000000002";
const SALT_A = "11".repeat(32);
const SALT_B = "22".repeat(32);
const PROJECTION = [
  { id: "60000000-0000-4000-8000-000000000001", state: "APORTO", version: 29 },
  { id: "60000000-0000-4000-8000-000000000002", state: "VOLVER", version: 29 },
];

function operationId(deviceOffset, index) {
  return `70000000-0000-4000-8000-${String(deviceOffset + index).padStart(12, "0")}`;
}

function summary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.ceil(value * sorted.length) - 1] ?? null;
  return {
    sampleCount: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    minimumSampleSize: 30,
    minimumSampleSizeMet: samples.length >= 30,
  };
}

function resignEvidence(evidence, options = {}) {
  if (options.summaries !== false) {
    evidence.summary = summary(evidence.latenciesMs);
    evidence.persistenceSummary = summary(evidence.persistLatenciesMs);
  }
  evidence.runSaltDigest = sha256H40Hex(
    `rutacuadrilla:h40:run-salt:v1\n${evidence.fingerprintSalt}`,
  );
  if (options.manifest !== false) {
    evidence.manifestHash = sha256H40Hex(
      canonicalH40Json({
        fingerprintSalt: evidence.fingerprintSalt,
        operationFingerprints: [...evidence.operationFingerprints].sort(),
        projectionHash: evidence.projectionHash,
        runSaltDigest: evidence.runSaltDigest,
        version: 1,
      }),
    );
  }
  const { integrity: _integrity, ...canonicalContent } = evidence;
  evidence.integrity = {
    algorithm: "SHA-256",
    canonicalContentHash: sha256H40Hex(canonicalH40Json(canonicalContent)),
  };
  return evidence;
}

function createEvidence(alias, operationIds, salt, options = {}) {
  const latenciesMs = Array.from({ length: operationIds.length }, (_, index) => 70 + (index % 30));
  const persistLatenciesMs = Array.from(
    { length: operationIds.length },
    (_, index) => 8 + (index % 10),
  );
  const evidence = {
    version: 1,
    deviceAlias: alias,
    createdAt: "2026-08-21T12:00:00.000Z",
    endedAt: "2026-08-21T12:30:00.000Z",
    status: "FINISHED",
    measurementActive: false,
    app: { version: "h40-20260821-a", shellVersion: "h40-20260821-a", schemaVersion: 8 },
    environment: {
      secureContext: true,
      crossOriginIsolated: true,
      opfsPersistent: true,
      serviceWorkerControlled: true,
      online: true,
    },
    counts: {
      successfulActions: operationIds.length,
      markActions: operationIds.length - 1,
      undoActions: 1,
      pendingOperations: 0,
      conflicts: 0,
      lostOperations: null,
      duplicateOperations: null,
    },
    latenciesMs,
    summary: summary(latenciesMs),
    persistLatenciesMs,
    persistenceSummary: summary(persistLatenciesMs),
    metricSummary: {
      offlineObservedMs: 1_200_000,
      restartGapMs: 0,
      offlineTotalMs: 1_200_000,
      syncDurationMs: 4_000,
      maxPending: operationIds.length,
      applied: operationIds.length - 1,
      conflict: 1,
      rejected: 0,
      replayed: options.replayed ?? 0,
      errorEvents: 0,
      clockRollbackDetected: false,
      manualConfirmationRequired: false,
    },
    finalOutbox: { pending: 0, sending: 0, conflict: 0, rejected: 0 },
    recoveredSending: options.recoveredSending ?? 0,
    projectionHash: hashH40Projection(salt, PROJECTION),
    operationFingerprints: operationIds.map((id) => hashH40OperationFingerprint(salt, id)),
    fingerprintSalt: salt,
    runSaltDigest: "",
    manifestHash: "",
    integrity: { algorithm: "SHA-256", canonicalContentHash: "" },
  };
  return resignEvidence(evidence);
}

function createFixture() {
  const operationsA = Array.from({ length: 30 }, (_, index) => operationId(1, index));
  const operationsB = Array.from({ length: 30 }, (_, index) => operationId(101, index));
  return {
    evidenceA: createEvidence("A", operationsA, SALT_A, { recoveredSending: 1, replayed: 1 }),
    evidenceB: createEvidence("B", operationsB, SALT_B),
    operationsA,
    operationsB,
  };
}

function pointState(alias, version) {
  if (version === 0 || version % 2 === 0) return "SIN_VISITAR";
  return alias === "A" ? "APORTO" : "VOLVER";
}

function receiptRows(operationIds, deviceId, membershipId, alias) {
  const ownPoint = alias === "A" ? PROJECTION[0] : PROJECTION[1];
  const crossPoint = alias === "A" ? PROJECTION[1] : PROJECTION[0];
  return operationIds.map((id, index) => ({
    campaignPointId: index === 0 ? crossPoint.id : ownPoint.id,
    changeSequence: index === 0 ? null : (alias === "A" ? 0 : 29) + index,
    conflictVersion: index === 0 ? 1 : null,
    operationId: id,
    deviceId,
    membershipId,
    status: index === 0 ? "CONFLICT" : "APPLIED",
  }));
}

function serverSnapshot(operationIds, deviceId, membershipId) {
  const receipts = receiptRows(operationIds, deviceId, membershipId, "A");
  const canonicalEvents = receipts
    .filter((receipt) => receipt.status === "APPLIED")
    .map((receipt, index) => ({
      appliedVersion: index + 1,
      campaignPointId: PROJECTION[0].id,
      deviceId,
      membershipId,
      nextState: pointState("A", index + 1),
      operationId: receipt.operationId,
      previousState: pointState("A", index),
      sequence: receipt.changeSequence,
      workSessionId: SESSION_ID,
    }));
  const eventCounts = new Map();
  const eventByOperation = new Map();
  for (const event of canonicalEvents) {
    eventCounts.set(event.operationId, (eventCounts.get(event.operationId) ?? 0) + 1);
    if (!eventByOperation.has(event.operationId)) eventByOperation.set(event.operationId, event);
  }
  return {
    campaignRouteId: ROUTE_ID,
    canonicalEvents,
    crewId: CREW_ID,
    eventByOperation,
    eventCounts,
    points: PROJECTION.map((point) => point.id),
    receipts,
    status: "ACTIVE",
    workSessionId: SESSION_ID,
  };
}

async function createDatabaseFixture(options = {}) {
  const fixture = createFixture();
  const distinctContext =
    options.differentWorkSession === true ||
    options.differentCampaignRoute === true ||
    options.differentCrew === true;
  const contextB = {
    crewId: options.differentCrew ? CREW_B_ID : CREW_ID,
    routeId: options.differentCampaignRoute || options.differentCrew ? ROUTE_B_ID : ROUTE_ID,
    workSessionId: distinctContext ? SESSION_B_ID : SESSION_ID,
  };
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE work_session (
      crew_id text NOT NULL,
      id text NOT NULL,
      campaign_route_id text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE campaign_point (
      crew_id text NOT NULL,
      id text NOT NULL,
      campaign_route_id text NOT NULL,
      display_state text NOT NULL,
      version bigint NOT NULL
    );
    CREATE TABLE sync_operation_receipt (
      crew_id text NOT NULL,
      operation_id text NOT NULL,
      campaign_point_id text NOT NULL,
      work_session_id text NOT NULL,
      actor_membership_id text NOT NULL,
      device_id text NOT NULL,
      status text NOT NULL,
      result_json jsonb NOT NULL,
      change_sequence bigint,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE point_event (
      crew_id text NOT NULL,
      id text NOT NULL,
      operation_id text NOT NULL,
      campaign_route_id text NOT NULL,
      work_session_id text NOT NULL,
      campaign_point_id text NOT NULL,
      actor_membership_id text NOT NULL,
      device_id text NOT NULL,
      previous_state text NOT NULL,
      next_state text NOT NULL,
      applied_version bigint NOT NULL,
      received_at_server timestamptz NOT NULL
    );
    CREATE TABLE sync_change (
      crew_id text NOT NULL,
      sequence bigint NOT NULL,
      event_id text NOT NULL,
      campaign_point_id text NOT NULL
    );
  `);
  await database.query(
    `INSERT INTO work_session (crew_id, id, campaign_route_id, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [CREW_ID, SESSION_ID, ROUTE_ID],
  );
  if (distinctContext) {
    await database.query(
      `INSERT INTO work_session (crew_id, id, campaign_route_id, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [contextB.crewId, contextB.workSessionId, contextB.routeId],
    );
  }
  for (const row of PROJECTION) {
    await database.query(
      `INSERT INTO campaign_point (crew_id, id, campaign_route_id, display_state, version)
       VALUES ($1, $2, $3, $4, $5)`,
      [CREW_ID, row.id, ROUTE_ID, row.state, row.version],
    );
    if (contextB.crewId !== CREW_ID || contextB.routeId !== ROUTE_ID) {
      await database.query(
        `INSERT INTO campaign_point (crew_id, id, campaign_route_id, display_state, version)
         VALUES ($1, $2, $3, $4, $5)`,
        [contextB.crewId, row.id, contextB.routeId, row.state, row.version],
      );
    }
  }
  const allReceipts = [
    ...receiptRows(fixture.operationsA, DEVICE_A_ID, MEMBER_A_ID, "A").map((receipt) => ({
      ...receipt,
      ...(options.invalidCrossConflict && receipt.status === "CONFLICT"
        ? { campaignPointId: PROJECTION[0].id }
        : {}),
      alias: "A",
      context: { crewId: CREW_ID, routeId: ROUTE_ID, workSessionId: SESSION_ID },
    })),
    ...receiptRows(
      fixture.operationsB,
      options.sameDevice ? DEVICE_A_ID : DEVICE_B_ID,
      options.sameMembership ? MEMBER_A_ID : MEMBER_B_ID,
      "B",
    ).map((receipt) => ({ ...receipt, alias: "B", context: contextB })),
  ];
  for (const receipt of allReceipts) {
    if (receipt.operationId === options.omitReceipt) continue;
    const result = {
      campaignPointId: receipt.campaignPointId,
      operationId: receipt.operationId,
      replayed: false,
      status: receipt.status,
      workSessionId: receipt.context.workSessionId,
      ...(receipt.status === "APPLIED"
        ? {
            changeSequence: receipt.changeSequence,
            eventId: receipt.operationId,
            state: pointState(
              receipt.alias,
              receipt.alias === "A" ? receipt.changeSequence : receipt.changeSequence - 29,
            ),
            version: receipt.alias === "A" ? receipt.changeSequence : receipt.changeSequence - 29,
          }
        : { state: pointState(receipt.alias === "A" ? "B" : "A", 1), version: 1 }),
    };
    await database.query(
      `INSERT INTO sync_operation_receipt
         (crew_id, operation_id, campaign_point_id, work_session_id,
          actor_membership_id, device_id, status, result_json, change_sequence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        receipt.context.crewId,
        receipt.operationId,
        receipt.campaignPointId,
        receipt.context.workSessionId,
        receipt.membershipId,
        receipt.deviceId,
        receipt.status,
        JSON.stringify(result),
        receipt.changeSequence,
        "2035-01-01T00:00:00.000Z",
      ],
    );
    if (receipt.status === "APPLIED") {
      const appliedVersion =
        receipt.alias === "A" ? receipt.changeSequence : receipt.changeSequence - 29;
      const eventId = receipt.operationId;
      await database.query(
        `INSERT INTO point_event
           (crew_id, id, operation_id, campaign_route_id, work_session_id,
            campaign_point_id, actor_membership_id, device_id, previous_state,
            next_state, applied_version, received_at_server)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          receipt.context.crewId,
          eventId,
          receipt.operationId,
          receipt.context.routeId,
          receipt.context.workSessionId,
          receipt.campaignPointId,
          receipt.membershipId,
          receipt.deviceId,
          pointState(receipt.alias, appliedVersion - 1),
          pointState(receipt.alias, appliedVersion),
          appliedVersion,
          "2035-01-01T00:00:00.000Z",
        ],
      );
      await database.query(
        `INSERT INTO sync_change (crew_id, sequence, event_id, campaign_point_id)
         VALUES ($1, $2, $3, $4)`,
        [receipt.context.crewId, receipt.changeSequence, eventId, receipt.campaignPointId],
      );
      if (receipt.operationId === options.duplicateEffect) {
        const duplicateEventId = operationId(950, 0);
        await database.query(
          `INSERT INTO point_event
             (crew_id, id, operation_id, campaign_route_id, work_session_id,
              campaign_point_id, actor_membership_id, device_id, previous_state,
              next_state, applied_version, received_at_server)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            receipt.context.crewId,
            duplicateEventId,
            receipt.operationId,
            receipt.context.routeId,
            receipt.context.workSessionId,
            receipt.campaignPointId,
            receipt.membershipId,
            receipt.deviceId,
            pointState(receipt.alias, appliedVersion - 1),
            pointState(receipt.alias, appliedVersion),
            appliedVersion,
            "2035-01-01T00:00:00.000Z",
          ],
        );
        await database.query(
          `INSERT INTO sync_change (crew_id, sequence, event_id, campaign_point_id)
           VALUES ($1, 999, $2, $3)`,
          [receipt.context.crewId, duplicateEventId, receipt.campaignPointId],
        );
      }
    }
  }
  if (options.postCutoffEffect) {
    const extraOperationId = operationId(901, 1);
    const result = {
      campaignPointId: PROJECTION[0].id,
      changeSequence: 59,
      eventId: extraOperationId,
      operationId: extraOperationId,
      replayed: false,
      state: "NO_PARTICIPA",
      status: "APPLIED",
      version: 30,
      workSessionId: SESSION_ID,
    };
    await database.query(
      `INSERT INTO sync_operation_receipt
         (crew_id, operation_id, campaign_point_id, work_session_id,
          actor_membership_id, device_id, status, result_json, change_sequence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'APPLIED', $7::jsonb, 59, $8)`,
      [
        CREW_ID,
        extraOperationId,
        PROJECTION[0].id,
        SESSION_ID,
        MEMBER_A_ID,
        DEVICE_A_ID,
        JSON.stringify(result),
        "2035-01-01T00:00:00.000Z",
      ],
    );
    await database.query(
      `INSERT INTO point_event
         (crew_id, id, operation_id, campaign_route_id, work_session_id,
          campaign_point_id, actor_membership_id, device_id, previous_state,
          next_state, applied_version, received_at_server)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, 'APORTO', 'NO_PARTICIPA', 30, $8)`,
      [
        CREW_ID,
        extraOperationId,
        ROUTE_ID,
        SESSION_ID,
        PROJECTION[0].id,
        MEMBER_A_ID,
        DEVICE_A_ID,
        "2035-01-01T00:00:00.000Z",
      ],
    );
    await database.query(
      `INSERT INTO sync_change (crew_id, sequence, event_id, campaign_point_id)
       VALUES ($1, 59, $2, $3)`,
      [CREW_ID, extraOperationId, PROJECTION[0].id],
    );
  }
  return { database, workSessionB: contextB.workSessionId, ...fixture };
}

function throwsCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof H40VerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof H40VerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("canonical JSON, operation fingerprints and projection hashes are deterministic", () => {
  assert.equal(
    canonicalH40Json({ z: 1, a: [true, { y: "x", b: null }] }),
    '{"a":[true,{"b":null,"y":"x"}],"z":1}',
  );
  assert.equal(
    hashH40OperationFingerprint(SALT_A, "operation-1"),
    sha256H40Hex(`rutacuadrilla:h40:operation:v1:${SALT_A}operation-1`),
  );
  assert.equal(
    hashH40Projection(SALT_A, [...PROJECTION].reverse()),
    hashH40Projection(SALT_A, PROJECTION),
  );
});

test("strict export validation accepts a complete redacted H40 record", () => {
  const { evidenceA } = createFixture();
  assert.equal(validateH40EvidenceExport(evidenceA, "A"), evidenceA);
  const serialized = JSON.stringify(evidenceA);
  for (const forbidden of [
    "@",
    "crewId",
    "deviceId",
    "membershipId",
    "pointId",
    "latitude",
    "address",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("strict export validation rejects extra fields and any canonical-content tampering", () => {
  const { evidenceA } = createFixture();
  const extra = structuredClone(evidenceA);
  extra.email = "persona@example.test";
  throwsCode(() => validateH40EvidenceExport(extra, "A"), "EVIDENCE_SHAPE_INVALID");

  const tampered = structuredClone(evidenceA);
  tampered.app.version = "h40-20260821-tampered";
  tampered.app.shellVersion = "h40-20260821-tampered";
  throwsCode(() => validateH40EvidenceExport(tampered, "A"), "CANONICAL_CONTENT_HASH_MISMATCH");
});

test("manifest and operation set are independently protected", () => {
  const { evidenceA } = createFixture();
  const manifestTamper = structuredClone(evidenceA);
  manifestTamper.projectionHash = "aa".repeat(32);
  resignEvidence(manifestTamper, { manifest: false });
  throwsCode(() => validateH40EvidenceExport(manifestTamper, "A"), "MANIFEST_HASH_MISMATCH");

  const duplicate = structuredClone(evidenceA);
  duplicate.operationFingerprints[1] = duplicate.operationFingerprints[0];
  resignEvidence(duplicate);
  throwsCode(() => validateH40EvidenceExport(duplicate, "A"), "OPERATION_FINGERPRINT_DUPLICATED");
});

test("minimum sample, visual p95, environment, schema and empty-attention gates are enforced", () => {
  const { evidenceA } = createFixture();
  const cases = [
    [
      "VISUAL_LATENCIES_INVALID",
      (value) => {
        value.latenciesMs.pop();
        value.persistLatenciesMs.pop();
        value.operationFingerprints.pop();
        value.counts.successfulActions = 29;
        value.counts.markActions = 28;
      },
    ],
    ["VISUAL_P95_EXCEEDED", (value) => value.latenciesMs.fill(201)],
    ["SECURE_CONTEXT_REQUIRED", (value) => (value.environment.secureContext = false)],
    ["LOCAL_SCHEMA_MISMATCH", (value) => (value.app.schemaVersion = 6)],
    ["PENDING_OPERATIONS_REMAIN", (value) => (value.counts.pendingOperations = 1)],
    ["ATTENTION_REMAINS", (value) => (value.counts.conflicts = 1)],
    ["FINAL_OUTBOX_NOT_EMPTY", (value) => (value.finalOutbox.rejected = 1)],
    ["MEASUREMENT_NOT_FINISHED", (value) => (value.status = "ABORTED")],
  ];
  for (const [code, mutate] of cases) {
    const candidate = structuredClone(evidenceA);
    mutate(candidate);
    resignEvidence(candidate);
    throwsCode(() => validateH40EvidenceExport(candidate, "A"), code);
  }
});

test("20 offline minutes are mandatory and restart gaps require an explicit safe confirmation", () => {
  const { evidenceA } = createFixture();
  const tooShort = structuredClone(evidenceA);
  tooShort.metricSummary.offlineObservedMs = 1_199_999;
  tooShort.metricSummary.offlineTotalMs = 1_199_999;
  resignEvidence(tooShort);
  throwsCode(() => validateH40EvidenceExport(tooShort, "A"), "OFFLINE_DURATION_TOO_SHORT");

  const restart = structuredClone(evidenceA);
  restart.metricSummary.offlineObservedMs = 600_000;
  restart.metricSummary.restartGapMs = 600_000;
  restart.metricSummary.manualConfirmationRequired = true;
  resignEvidence(restart);
  throwsCode(() => validateH40EvidenceExport(restart, "A"), "RESTART_GAP_CONFIRMATION_REQUIRED");
  assert.equal(validateH40EvidenceExport(restart, "A", { confirmRestartGap: true }), restart);

  restart.metricSummary.clockRollbackDetected = true;
  resignEvidence(restart);
  throwsCode(
    () => validateH40EvidenceExport(restart, "A", { confirmRestartGap: true }),
    "CLOCK_ROLLBACK_DETECTED",
  );
});

test("server reconciliation accepts APPLIED plus resolved conflict receipts without inventing effects", () => {
  const { evidenceA, operationsA } = createFixture();
  const result = reconcileH40Evidence(
    evidenceA,
    serverSnapshot(operationsA, DEVICE_A_ID, MEMBER_A_ID),
  );
  assert.deepEqual(
    {
      applied: result.appliedReceipts,
      conflicts: result.conflictReceipts,
      nonApplied: result.nonAppliedReceipts,
      receipts: result.serverReceipts,
    },
    { applied: 29, conflicts: 1, nonApplied: 1, receipts: 30 },
  );
});

test("server reconciliation detects lost receipts and duplicate canonical effects", () => {
  const { evidenceA, operationsA } = createFixture();
  const missing = serverSnapshot(operationsA, DEVICE_A_ID, MEMBER_A_ID);
  missing.receipts.pop();
  throwsCode(() => reconcileH40Evidence(evidenceA, missing), "SERVER_RECEIPT_MISSING");

  const duplicate = serverSnapshot(operationsA, DEVICE_A_ID, MEMBER_A_ID);
  duplicate.eventCounts.set(operationsA[1], 2);
  throwsCode(() => reconcileH40Evidence(evidenceA, duplicate), "SERVER_EFFECT_DUPLICATED");
});

test("the PGlite verifier ignores phone/server clock skew and emits only aggregate PASA evidence", async (context) => {
  const fixture = await createDatabaseFixture();
  context.after(() => fixture.database.close());
  const report = await verifyH40EvidencePair({
    database: fixture.database,
    evidenceA: fixture.evidenceA,
    evidenceB: fixture.evidenceB,
    workSessionA: SESSION_ID,
    workSessionB: SESSION_ID,
  });
  assert.deepEqual(report.aggregate, {
    controlledConflicts: 2,
    controlledConflictPairs: 2,
    duplicateEffects: 0,
    lostOperations: 0,
    recoveredSending: 1,
    replayed: 1,
    serverReceipts: 60,
    successfulActions: 60,
  });
  assert.equal(report.status, "PASA");
  assert.deepEqual(
    report.devices.map((device) => device.alias),
    ["A", "B"],
  );
  const serialized = JSON.stringify(report);
  for (const rawIdentifier of [
    CREW_ID,
    ROUTE_ID,
    SESSION_ID,
    DEVICE_A_ID,
    DEVICE_B_ID,
    MEMBER_A_ID,
    MEMBER_B_ID,
    ...fixture.operationsA,
    ...fixture.operationsB,
  ]) {
    assert.equal(serialized.includes(rawIdentifier), false);
  }
});

test("the first common change-sequence cutoff survives a later canonical effect", async (context) => {
  const fixture = await createDatabaseFixture({ postCutoffEffect: true });
  context.after(() => fixture.database.close());
  const report = await verifyH40EvidencePair({
    database: fixture.database,
    evidenceA: fixture.evidenceA,
    evidenceB: fixture.evidenceB,
    workSessionA: SESSION_ID,
    workSessionB: SESSION_ID,
  });
  assert.equal(report.status, "PASA");
  assert.equal(JSON.stringify(report).includes("2035-01-01"), false);
});

test("the pair verifier rejects projections with no common canonical sequence cutoff", async (context) => {
  const fixture = await createDatabaseFixture();
  context.after(() => fixture.database.close());
  const divergentB = structuredClone(fixture.evidenceB);
  divergentB.projectionHash = hashH40Projection(SALT_B, [
    PROJECTION[0],
    { ...PROJECTION[1], version: 28, state: "SIN_VISITAR" },
  ]);
  resignEvidence(divergentB);
  await rejectsCode(
    verifyH40EvidencePair({
      database: fixture.database,
      evidenceA: fixture.evidenceA,
      evidenceB: divergentB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "COMMON_CANONICAL_CUTOFF_NOT_FOUND",
  );
});

test("the pair verifier rejects a missing receipt and a duplicate canonical effect", async (context) => {
  const missing = await createDatabaseFixture({ omitReceipt: operationId(1, 29) });
  const duplicated = await createDatabaseFixture({ duplicateEffect: operationId(1, 1) });
  context.after(async () => {
    await Promise.all([missing.database.close(), duplicated.database.close()]);
  });
  await rejectsCode(
    verifyH40EvidencePair({
      database: missing.database,
      evidenceA: missing.evidenceA,
      evidenceB: missing.evidenceB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "SERVER_RECEIPT_MISSING",
  );
  await rejectsCode(
    verifyH40EvidencePair({
      database: duplicated.database,
      evidenceA: duplicated.evidenceA,
      evidenceB: duplicated.evidenceB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "SERVER_EFFECT_DUPLICATED",
  );
});

test("the pair verifier proves two physical devices and two participant identities", async (context) => {
  const sameDevice = await createDatabaseFixture({ sameDevice: true });
  const sameMembership = await createDatabaseFixture({ sameMembership: true });
  context.after(async () => {
    await Promise.all([sameDevice.database.close(), sameMembership.database.close()]);
  });
  await rejectsCode(
    verifyH40EvidencePair({
      database: sameDevice.database,
      evidenceA: sameDevice.evidenceA,
      evidenceB: sameDevice.evidenceB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "PHYSICAL_DEVICE_NOT_DISTINCT",
  );
  await rejectsCode(
    verifyH40EvidencePair({
      database: sameMembership.database,
      evidenceA: sameMembership.evidenceA,
      evidenceB: sameMembership.evidenceB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "PARTICIPANT_NOT_DISTINCT",
  );
});

test("the pair verifier requires the same crew, campaign route and work session", async (context) => {
  const differentCrew = await createDatabaseFixture({ differentCrew: true });
  const differentRoute = await createDatabaseFixture({ differentCampaignRoute: true });
  const differentSession = await createDatabaseFixture({ differentWorkSession: true });
  context.after(async () => {
    await Promise.all([
      differentCrew.database.close(),
      differentRoute.database.close(),
      differentSession.database.close(),
    ]);
  });
  for (const [fixture, code] of [
    [differentCrew, "DEVICES_NOT_IN_SAME_CREW"],
    [differentRoute, "DEVICES_NOT_IN_SAME_CAMPAIGN_ROUTE"],
    [differentSession, "DEVICES_NOT_IN_SAME_WORK_SESSION"],
  ]) {
    await rejectsCode(
      verifyH40EvidencePair({
        database: fixture.database,
        evidenceA: fixture.evidenceA,
        evidenceB: fixture.evidenceB,
        workSessionA: SESSION_ID,
        workSessionB: fixture.workSessionB,
      }),
      code,
    );
  }
});

test("every measured CONFLICT must be caused by a fingerprinted APPLIED event from the other device", async (context) => {
  const fixture = await createDatabaseFixture({ invalidCrossConflict: true });
  context.after(() => fixture.database.close());
  await rejectsCode(
    verifyH40EvidencePair({
      database: fixture.database,
      evidenceA: fixture.evidenceA,
      evidenceB: fixture.evidenceB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "CONTROLLED_CONFLICT_NOT_CROSS_DEVICE",
  );
});

test("pair-level conflict and SENDING recovery evidence cannot be omitted", async (context) => {
  const fixture = await createDatabaseFixture();
  context.after(() => fixture.database.close());
  const noConflictsA = structuredClone(fixture.evidenceA);
  const noConflictsB = structuredClone(fixture.evidenceB);
  noConflictsA.metricSummary.conflict = 0;
  noConflictsB.metricSummary.conflict = 0;
  resignEvidence(noConflictsA);
  resignEvidence(noConflictsB);
  await rejectsCode(
    verifyH40EvidencePair({
      database: fixture.database,
      evidenceA: noConflictsA,
      evidenceB: noConflictsB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "CONTROLLED_CONFLICTS_NOT_PROVEN",
  );

  const noRecoveryA = structuredClone(fixture.evidenceA);
  const noRecoveryB = structuredClone(fixture.evidenceB);
  noRecoveryA.recoveredSending = 0;
  noRecoveryA.metricSummary.replayed = 0;
  resignEvidence(noRecoveryA);
  resignEvidence(noRecoveryB);
  await rejectsCode(
    verifyH40EvidencePair({
      database: fixture.database,
      evidenceA: noRecoveryA,
      evidenceB: noRecoveryB,
      workSessionA: SESSION_ID,
      workSessionB: SESSION_ID,
    }),
    "SENDING_RECOVERY_NOT_PROVEN",
  );
});

test("CLI parsing is strict, absolute-path only and UUID validated", () => {
  const root = process.platform === "win32" ? "C:\\h40" : "/h40";
  const parsed = parseH40VerifierArguments([
    "--database-dir",
    `${root}\\db`,
    "--evidence-a",
    `${root}\\a.json`,
    "--work-session-a",
    SESSION_ID,
    "--evidence-b",
    `${root}\\b.json`,
    "--work-session-b",
    SESSION_ID,
    "--confirm-restart-gap",
  ]);
  assert.equal(parsed.confirmRestartGap, true);
  throwsCode(
    () => parseH40VerifierArguments(["--database-dir", "relative"]),
    "CLI_ARGUMENT_MISSING",
  );
  throwsCode(
    () =>
      parseH40VerifierArguments([
        "--database-dir",
        `${root}\\db`,
        "--database-dir",
        `${root}\\db2`,
      ]),
    "CLI_ARGUMENT_DUPLICATED",
  );
});
