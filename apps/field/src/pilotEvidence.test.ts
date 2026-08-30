import { describe, expect, it } from "vitest";
import {
  canonicalPilotJson,
  createPilotEvidenceExportFromSource,
  createPilotEvidenceState,
  generatePilotRunSalt,
  hashPilotOperationFingerprint,
  hashPilotProjection,
  loadPilotEvidenceState,
  nearestRankPercentile,
  PILOT_EVIDENCE_STORAGE_KEY,
  PILOT_MAXIMUM_SAMPLES,
  PILOT_OPERATION_FINGERPRINT_DOMAIN,
  type PilotEvidenceStorage,
  recordSuccessfulPilotAction,
  savePilotEvidenceState,
  sha256PilotHex,
  startPilotEvidenceSession,
  summarizePilotLatencies,
  summarizePilotMetrics,
  validatePilotEvidenceState,
} from "./pilotEvidence";

const CREATED_AT = "2026-08-21T12:34:56.000Z";
const RUN_SALT = "01".repeat(32);

function createMemoryStorage(): PilotEvidenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function createActiveState() {
  return startPilotEvidenceSession(createPilotEvidenceState("Teléfono A"), CREATED_AT, RUN_SALT);
}

describe("H40 latency evidence", () => {
  it("uses the deterministic nearest-rank percentile without mutating samples", () => {
    const samples = [40, 10, 30, 20];
    expect(nearestRankPercentile(samples, 0.5)).toBe(20);
    expect(nearestRankPercentile(samples, 0.95)).toBe(40);
    expect(samples).toEqual([40, 10, 30, 20]);
    expect(nearestRankPercentile([], 0.95)).toBeNull();
  });

  it("requires at least 30 samples in the summary", () => {
    const belowTarget = summarizePilotLatencies(Array.from({ length: 29 }, (_, index) => index));
    const target = summarizePilotLatencies(Array.from({ length: 30 }, (_, index) => index));
    expect(belowTarget.minimumSampleSizeMet).toBe(false);
    expect(target).toMatchObject({
      sampleCount: 30,
      p50Ms: 14,
      p95Ms: 28,
      minimumSampleSize: 30,
      minimumSampleSizeMet: true,
    });
  });

  it("rejects non-finite or negative latency values", () => {
    const state = createActiveState();
    expect(() => recordSuccessfulPilotAction(state, -1)).toThrow();
    expect(() => recordSuccessfulPilotAction(state, Number.NaN)).toThrow();
    expect(() => summarizePilotLatencies([Number.POSITIVE_INFINITY])).toThrow();
  });

  it("keeps only the latest 500 successful samples", () => {
    let state = createActiveState();
    for (let index = 0; index < PILOT_MAXIMUM_SAMPLES + 7; index += 1) {
      state = recordSuccessfulPilotAction(state, index);
    }
    expect(state.session?.samples).toHaveLength(500);
    expect(state.session?.samples[0]?.visualLatencyMs).toBe(7);
    expect(state.session?.samples.at(-1)?.visualLatencyMs).toBe(506);
  });
});

describe("H40 persisted state validation", () => {
  it("round-trips valid state through an injected storage adapter", () => {
    const storage = createMemoryStorage();
    const state = recordSuccessfulPilotAction(createActiveState(), 42, "ab".repeat(32));
    expect(savePilotEvidenceState(storage, state)).toBe(true);
    expect(storage.values.has(PILOT_EVIDENCE_STORAGE_KEY)).toBe(true);
    expect(loadPilotEvidenceState(storage)).toEqual(state);
  });

  it("fails closed for tampered state, extra keys and malformed fingerprints", () => {
    const storage = createMemoryStorage();
    const valid = recordSuccessfulPilotAction(createActiveState(), 42, "ab".repeat(32));
    const cases: unknown[] = [
      { ...valid, email: "persona@example.test" },
      { ...valid, active: true, session: null },
      { ...valid, deviceAlias: " persona@example.test " },
      { ...valid, session: { ...valid.session, runSalt: "not-a-salt" } },
      {
        ...valid,
        session: {
          ...valid.session,
          samples: [{ visualLatencyMs: 42, operationFingerprint: "raw-point-id" }],
        },
      },
      {
        ...valid,
        session: {
          ...valid.session,
          samples: [{ visualLatencyMs: 42, pointId: "point-secret" }],
        },
      },
      { ...valid, session: { ...valid.session, samples: [{ visualLatencyMs: -1 }] } },
    ];
    for (const candidate of cases) {
      expect(validatePilotEvidenceState(candidate)).toBe(false);
      storage.values.set(PILOT_EVIDENCE_STORAGE_KEY, JSON.stringify(candidate));
      expect(loadPilotEvidenceState(storage)).toBeNull();
    }
    storage.values.set(PILOT_EVIDENCE_STORAGE_KEY, "{invalid-json");
    expect(loadPilotEvidenceState(storage)).toBeNull();
  });

  it("creates a 256-bit run salt through an injected random source", () => {
    const salt = generatePilotRunSalt((bytes) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
    });
    expect(salt).toHaveLength(64);
    expect(salt).toBe(
      Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join(""),
    );
  });
});

describe("H40 redacted export", () => {
  it("exports only the allow-listed evidence and verifiable canonical hashes", async () => {
    const operationFingerprint = await hashPilotOperationFingerprint(
      RUN_SALT,
      "ephemeral-operation-key",
    );
    expect(operationFingerprint).toBe(
      await sha256PilotHex(
        `${PILOT_OPERATION_FINGERPRINT_DOMAIN}${RUN_SALT}ephemeral-operation-key`,
      ),
    );
    const projectionHash = await hashPilotProjection(RUN_SALT, [
      { id: "point-2", state: "PENDING", version: 2 },
      { id: "point-1", state: "COMPLETED", version: 1 },
    ]);
    const exported = await createPilotEvidenceExportFromSource({
      appVersion: "h40-20260821-a",
      shellVersion: "h40-20260821-a",
      schemaVersion: 8,
      evidence: {
        salt: RUN_SALT,
        summary: {
          actionCount: 30,
          buildId: "h40-20260821-a",
          completedActionCount: 30,
          deviceAlias: "A",
          startedAt: CREATED_AT,
          endedAt: "2026-08-21T13:00:00.000Z",
          status: "FINISHED",
        },
        operations: Array.from({ length: 30 }, (_, index) => ({
          actionKind: index % 2 === 0 ? ("MARK" as const) : ("UNDO" as const),
          operationFingerprint,
          persistMs: index + 1.5,
          recordedAt: new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString(),
          visualMs: index + 1,
        })),
        metrics: [
          {
            eventKind: "BOOT",
            monotonicMs: 0,
            pending: 0,
            recordedSequence: 1,
            wallAt: CREATED_AT,
          },
        ],
        finalOutbox: { pending: 0, sending: 0, conflict: 0, rejected: 0 },
        recoveredSending: 2,
        projectionHash,
      },
      environment: {
        secureContext: true,
        crossOriginIsolated: true,
        opfsPersistent: true,
        serviceWorkerControlled: true,
        online: false,
      },
      counts: {
        pendingOperations: 0,
        conflicts: 0,
        lostOperations: null,
        duplicateOperations: null,
      },
    });

    expect(exported).toMatchObject({
      version: 1,
      deviceAlias: "A",
      createdAt: CREATED_AT,
      status: "FINISHED",
      counts: {
        successfulActions: 30,
        markActions: 15,
        undoActions: 15,
        lostOperations: null,
        duplicateOperations: null,
      },
      summary: { sampleCount: 30, minimumSampleSizeMet: true, p50Ms: 15, p95Ms: 29 },
      persistenceSummary: { sampleCount: 30, p50Ms: 15.5, p95Ms: 29.5 },
      recoveredSending: 2,
      projectionHash,
    });
    expect(exported.operationFingerprints).toHaveLength(30);
    expect(exported.fingerprintSalt).toBe(RUN_SALT);
    expect(exported.runSaltDigest).not.toBe(RUN_SALT);
    expect(exported.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.integrity.canonicalContentHash).toBe(
      await sha256PilotHex(
        canonicalPilotJson(
          Object.fromEntries(
            Object.entries(exported).filter(([key]) => key !== "integrity"),
          ) as never,
        ),
      ),
    );
  });

  it("does not export raw PII, domain identifiers, locations or operational states", async () => {
    const sensitiveValues = [
      "persona@example.test",
      "token-secret",
      "user-secret",
      "membership-secret",
      "device-secret",
      "crew-secret",
      "campaign-secret",
      "route-secret",
      "point-secret",
      "Av. Siempre Viva 742",
      "-0.4489",
      "-0.6693",
      "COMPLETED",
    ];
    const rawOperationId = sensitiveValues.join("|");
    const projectionHash = await hashPilotProjection(RUN_SALT, [
      { id: "point-secret", state: "COMPLETED", version: 7 },
    ]);
    const exported = await createPilotEvidenceExportFromSource({
      appVersion: "h40-20260821-a",
      shellVersion: "h40-20260821-a",
      schemaVersion: 8,
      evidence: {
        salt: RUN_SALT,
        summary: {
          actionCount: 30,
          buildId: "h40-20260821-a",
          completedActionCount: 30,
          deviceAlias: "B",
          startedAt: CREATED_AT,
          endedAt: "2026-08-21T13:00:00.000Z",
          status: "FINISHED",
        },
        operations: Array.from({ length: 30 }, (_, index) => ({
          actionKind: "MARK",
          operationId: `${rawOperationId}|${index}`,
          persistMs: 12,
          recordedAt: new Date(Date.parse(CREATED_AT) + index * 1_000).toISOString(),
          visualMs: 42,
        })),
        metrics: [
          {
            errorCode: "token-secret",
            eventKind: "RECOVERY",
            recordedSequence: 1,
            replayed: 1,
            wallAt: "2026-08-21T12:36:00.000Z",
          },
        ],
        finalOutbox: { pending: 0, sending: 0, conflict: 0, rejected: 0 },
        recoveredSending: 1,
        projectionHash,
      },
      environment: {
        secureContext: true,
        crossOriginIsolated: true,
        opfsPersistent: true,
        serviceWorkerControlled: true,
        online: true,
      },
      counts: {
        pendingOperations: 0,
        conflicts: 0,
        lostOperations: null,
        duplicateOperations: null,
      },
    });
    const serialized = JSON.stringify(exported);
    const lowerSerialized = serialized.toLowerCase();
    for (const forbiddenKey of [
      "email",
      "token",
      "userid",
      "membershipid",
      "deviceid",
      "crewid",
      "campaignid",
      "routeid",
      "pointid",
      "address",
      "domicilio",
      "coordinate",
      "latitude",
      "longitude",
      "operationalstate",
    ]) {
      expect(lowerSerialized).not.toContain(forbiddenKey);
    }
    for (const sensitiveValue of sensitiveValues) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(exported.fingerprintSalt).toBe(RUN_SALT);
    expect(exported.operationFingerprints).toHaveLength(30);
    expect(exported.operationFingerprints[0]).toBe(
      await sha256PilotHex(`${PILOT_OPERATION_FINGERPRINT_DOMAIN}${RUN_SALT}${rawOperationId}|0`),
    );
    expect(serialized).not.toContain("eventKind");
    expect(serialized).not.toContain("recordedAt");
    expect(serialized).not.toContain("actionKind");
  });
});

describe("H40 timeline and projection evidence", () => {
  it("pairs offline and sync spans using the monotonic clock and aggregates counters", () => {
    const summary = summarizePilotMetrics([
      {
        eventKind: "BOOT",
        monotonicMs: 0,
        pending: 0,
        recordedSequence: 1,
        wallAt: "2026-08-21T12:00:00.000Z",
      },
      {
        eventKind: "OFFLINE_START",
        monotonicMs: 100,
        pending: 3,
        recordedSequence: 2,
        wallAt: "2026-08-21T12:00:01.000Z",
      },
      {
        applied: 2,
        eventKind: "OFFLINE_END",
        monotonicMs: 20_100,
        recordedSequence: 3,
        wallAt: "2026-08-21T12:00:21.000Z",
      },
      {
        eventKind: "SYNC_START",
        monotonicMs: 21_000,
        pending: 5,
        recordedSequence: 4,
        wallAt: "2026-08-21T12:00:22.000Z",
      },
      {
        applied: 1,
        conflict: 1,
        eventKind: "SYNC_END",
        monotonicMs: 23_000,
        rejected: 2,
        replayed: 4,
        recordedSequence: 5,
        wallAt: "2026-08-21T12:00:24.000Z",
      },
    ]);
    expect(summary).toEqual({
      offlineObservedMs: 20_000,
      restartGapMs: 0,
      offlineTotalMs: 20_000,
      syncDurationMs: 2_000,
      maxPending: 5,
      applied: 3,
      conflict: 1,
      rejected: 2,
      replayed: 4,
      errorEvents: 0,
      clockRollbackDetected: false,
      manualConfirmationRequired: false,
    });
  });

  it("uses wall time across BOOT, detects monotonic rollback and requests confirmation", () => {
    const summary = summarizePilotMetrics([
      {
        eventKind: "BOOT",
        monotonicMs: 0,
        recordedSequence: 1,
        wallAt: "2026-08-21T12:00:00.000Z",
      },
      {
        eventKind: "OFFLINE_START",
        monotonicMs: 100,
        recordedSequence: 2,
        wallAt: "2026-08-21T12:00:01.000Z",
      },
      {
        eventKind: "BOOT",
        monotonicMs: 0,
        recordedSequence: 3,
        wallAt: "2026-08-21T12:00:05.000Z",
      },
      {
        eventKind: "RECOVERY",
        monotonicMs: 100,
        recordedSequence: 4,
        wallAt: "2026-08-21T12:00:06.000Z",
      },
      {
        eventKind: "OFFLINE_END",
        monotonicMs: 50,
        recordedSequence: 5,
        wallAt: "2026-08-21T12:00:25.000Z",
      },
    ]);
    expect(summary).toMatchObject({
      offlineObservedMs: 0,
      restartGapMs: 4_000,
      offlineTotalMs: 4_000,
      clockRollbackDetected: true,
      manualConfirmationRequired: true,
    });
  });

  it("closes an open offline span at BOOT before accepting a new span", () => {
    const summary = summarizePilotMetrics([
      {
        eventKind: "OFFLINE_START",
        monotonicMs: 100,
        recordedSequence: 1,
        wallAt: "2026-08-21T12:00:00.000Z",
      },
      {
        eventKind: "BOOT",
        monotonicMs: 0,
        recordedSequence: 2,
        wallAt: "2026-08-21T12:10:00.000Z",
      },
      {
        eventKind: "OFFLINE_START",
        monotonicMs: 100,
        recordedSequence: 3,
        wallAt: "2026-08-21T12:10:00.000Z",
      },
      {
        eventKind: "OFFLINE_END",
        monotonicMs: 600_100,
        recordedSequence: 4,
        wallAt: "2026-08-21T12:20:00.000Z",
      },
    ]);
    expect(summary).toMatchObject({
      offlineObservedMs: 600_000,
      restartGapMs: 600_000,
      offlineTotalMs: 1_200_000,
      manualConfirmationRequired: true,
    });
  });

  it("preserves the wall-clock duration of an open sync span at BOOT", () => {
    const summary = summarizePilotMetrics([
      {
        eventKind: "SYNC_START",
        monotonicMs: 100,
        recordedSequence: 1,
        wallAt: "2026-08-21T12:00:00.000Z",
      },
      {
        eventKind: "BOOT",
        monotonicMs: 0,
        recordedSequence: 2,
        wallAt: "2026-08-21T12:05:00.000Z",
      },
    ]);
    expect(summary).toMatchObject({
      syncDurationMs: 300_000,
      manualConfirmationRequired: true,
    });
  });

  it("hashes a projection canonically without exposing IDs or point states", async () => {
    const first = await hashPilotProjection(RUN_SALT, [
      { id: "b-secret", state: "PENDING", version: 2 },
      { id: "a-secret", state: "COMPLETED", version: 1 },
    ]);
    const reordered = await hashPilotProjection(RUN_SALT, [
      { id: "a-secret", state: "COMPLETED", version: 1 },
      { id: "b-secret", state: "PENDING", version: 2 },
    ]);
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("a-secret");
    expect(first).not.toContain("COMPLETED");
  });
});
