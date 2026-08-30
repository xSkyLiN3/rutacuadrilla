export const PILOT_EVIDENCE_STORAGE_KEY = "rutacuadrilla:h40-evidence:v1";
export const PILOT_EVIDENCE_VERSION = 1 as const;
export const PILOT_MINIMUM_SAMPLES = 30;
export const PILOT_MAXIMUM_SAMPLES = 500;
export const PILOT_MAXIMUM_METRICS = 5_000;
export const PILOT_MAXIMUM_ALIAS_LENGTH = 24;
export const PILOT_EXPECTED_SCHEMA_VERSION = 8;
export const PILOT_OPERATION_FINGERPRINT_DOMAIN = "rutacuadrilla:h40:operation:v1:";
export const PILOT_PROJECTION_HASH_DOMAIN = "rutacuadrilla:h40:projection:v1:";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ALIAS_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface PilotEvidenceSample {
  readonly visualLatencyMs: number;
  /**
   * A SHA-256 fingerprint produced with the run salt. Raw operation or domain
   * identifiers must never be stored here.
   */
  readonly operationFingerprint?: string;
}

export interface PilotEvidenceSession {
  readonly createdAt: string;
  /** Kept only in local state. Exports contain its digest, never the salt. */
  readonly runSalt: string;
  readonly samples: readonly PilotEvidenceSample[];
}

export interface PilotEvidenceState {
  readonly version: typeof PILOT_EVIDENCE_VERSION;
  readonly deviceAlias: string;
  readonly active: boolean;
  readonly session: PilotEvidenceSession | null;
}

export interface PilotEvidenceSummary {
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly minimumSampleSize: typeof PILOT_MINIMUM_SAMPLES;
  readonly minimumSampleSizeMet: boolean;
}

export interface PilotEvidenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PilotTechnicalEnvironment {
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly opfsPersistent: boolean;
  readonly serviceWorkerControlled: boolean;
  readonly online: boolean;
}

export interface PilotAggregateCounts {
  readonly pendingOperations: number;
  readonly conflicts: number;
  /** Unknown locally until an external verifier reconciles the server projection. */
  readonly lostOperations: number | null;
  /** Unknown locally until an external verifier reconciles the server projection. */
  readonly duplicateOperations: number | null;
}

export interface PilotEvidenceExportTechnicalInput {
  readonly appVersion: string;
  readonly shellVersion: string;
  readonly schemaVersion: number;
  readonly environment: PilotTechnicalEnvironment;
  readonly counts: PilotAggregateCounts;
}

export interface PilotEvidenceExportInput extends PilotEvidenceExportTechnicalInput {
  readonly state: PilotEvidenceState;
}

export type PilotRunStatus = "RUNNING" | "FINISHED" | "ABORTED";
export type PilotActionKind = "MARK" | "UNDO";
export type PilotMetricEventKind =
  | "OFFLINE_START"
  | "OFFLINE_END"
  | "BOOT"
  | "SYNC_START"
  | "SYNC_END"
  | "RECOVERY";

export interface PilotMetricRecord {
  readonly applied?: number;
  readonly conflict?: number;
  readonly errorCode?: string;
  readonly eventKind: PilotMetricEventKind;
  readonly monotonicMs?: number;
  readonly pending?: number;
  readonly recordedSequence: number;
  readonly rejected?: number;
  readonly replayed?: number;
  readonly wallAt: string;
}

export interface PilotMetricSummary {
  readonly offlineObservedMs: number;
  readonly restartGapMs: number;
  readonly offlineTotalMs: number;
  readonly syncDurationMs: number;
  readonly maxPending: number;
  readonly applied: number;
  readonly conflict: number;
  readonly rejected: number;
  readonly replayed: number;
  readonly errorEvents: number;
  readonly clockRollbackDetected: boolean;
  readonly manualConfirmationRequired: boolean;
}

export interface PilotFinalOutbox {
  readonly pending: number;
  readonly sending: number;
  readonly conflict: number;
  readonly rejected: number;
}

export interface PilotExternalOperationEvidence {
  readonly actionKind: PilotActionKind;
  readonly operationId?: string;
  readonly operationFingerprint?: string;
  readonly persistMs?: number;
  readonly recordedAt: string;
  readonly visualMs?: number;
}

/**
 * Projection expected from the authoritative SQLite v8 source. Raw operation
 * IDs are consumed only in memory to derive fingerprints and are never copied
 * to the exported DTO.
 */
export interface PilotExternalEvidenceSource {
  readonly finalOutbox: PilotFinalOutbox;
  readonly metrics: readonly PilotMetricRecord[];
  readonly operations: readonly PilotExternalOperationEvidence[];
  readonly projectionHash: string;
  readonly recoveredSending: number;
  readonly salt: string;
  readonly summary: {
    readonly actionCount: number;
    readonly buildId: string;
    readonly completedActionCount: number;
    readonly deviceAlias: string;
    readonly endedAt?: string;
    readonly startedAt: string;
    readonly status: PilotRunStatus;
  };
}

export interface PilotEvidenceExportFromSourceInput extends PilotEvidenceExportTechnicalInput {
  readonly evidence: PilotExternalEvidenceSource;
}

export interface PilotEvidenceExportV1 {
  readonly version: typeof PILOT_EVIDENCE_VERSION;
  readonly deviceAlias: string;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly status: PilotRunStatus;
  readonly measurementActive: boolean;
  readonly app: {
    readonly version: string;
    readonly shellVersion: string;
    readonly schemaVersion: number;
  };
  readonly environment: PilotTechnicalEnvironment;
  readonly counts: PilotAggregateCounts & {
    readonly successfulActions: number;
    readonly markActions: number;
    readonly undoActions: number;
  };
  readonly latenciesMs: readonly number[];
  readonly summary: PilotEvidenceSummary;
  readonly persistLatenciesMs: readonly number[];
  readonly persistenceSummary: PilotEvidenceSummary;
  readonly metricSummary: PilotMetricSummary;
  readonly finalOutbox: PilotFinalOutbox;
  readonly recoveredSending: number;
  readonly projectionHash: string;
  readonly operationFingerprints: readonly string[];
  /** Random, run-scoped and non-identifying; required by the server verifier. */
  readonly fingerprintSalt: string;
  readonly runSaltDigest: string;
  readonly manifestHash: string;
  readonly integrity: {
    readonly algorithm: "SHA-256";
    readonly canonicalContentHash: string;
  };
}

export type PilotRandomByteFiller = (bytes: Uint8Array) => void;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

function validateSample(value: unknown): value is PilotEvidenceSample {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !hasExactKeys(
      value,
      keys.includes("operationFingerprint")
        ? ["visualLatencyMs", "operationFingerprint"]
        : ["visualLatencyMs"],
    )
  ) {
    return false;
  }
  return (
    isLatency(value.visualLatencyMs) &&
    (value.operationFingerprint === undefined || isSha256Hex(value.operationFingerprint))
  );
}

function validateSession(value: unknown): value is PilotEvidenceSession {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["createdAt", "runSalt", "samples"])) {
    return false;
  }
  return (
    isCanonicalIsoTimestamp(value.createdAt) &&
    isSha256Hex(value.runSalt) &&
    Array.isArray(value.samples) &&
    value.samples.length <= PILOT_MAXIMUM_SAMPLES &&
    value.samples.every(validateSample)
  );
}

export function normalizePilotDeviceAlias(value: string): string {
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (
    normalized.length === 0 ||
    normalized.length > PILOT_MAXIMUM_ALIAS_LENGTH ||
    !SAFE_ALIAS_PATTERN.test(normalized)
  ) {
    throw new Error(
      `El alias debe tener entre 1 y ${PILOT_MAXIMUM_ALIAS_LENGTH} caracteres y solo letras, números, espacios, punto, guion o guion bajo.`,
    );
  }
  return normalized;
}

export function createPilotEvidenceState(deviceAlias: string): PilotEvidenceState {
  return {
    version: PILOT_EVIDENCE_VERSION,
    deviceAlias: normalizePilotDeviceAlias(deviceAlias),
    active: false,
    session: null,
  };
}

export function generatePilotRunSalt(fillRandomBytes: PilotRandomByteFiller): string {
  const bytes = new Uint8Array(32);
  fillRandomBytes(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function startPilotEvidenceSession(
  state: PilotEvidenceState,
  createdAt: string,
  runSalt: string,
): PilotEvidenceState {
  if (!validatePilotEvidenceState(state)) throw new Error("Estado de evidencia H40 inválido.");
  if (!isCanonicalIsoTimestamp(createdAt))
    throw new Error("createdAt debe ser una fecha ISO canónica.");
  if (!isSha256Hex(runSalt)) throw new Error("El salt H40 debe contener 32 bytes hexadecimales.");
  return {
    ...state,
    active: true,
    session: { createdAt, runSalt, samples: [] },
  };
}

export function stopPilotEvidenceSession(state: PilotEvidenceState): PilotEvidenceState {
  if (!validatePilotEvidenceState(state)) throw new Error("Estado de evidencia H40 inválido.");
  return { ...state, active: false };
}

export function recordSuccessfulPilotAction(
  state: PilotEvidenceState,
  visualLatencyMs: number,
  operationFingerprint?: string,
): PilotEvidenceState {
  if (!validatePilotEvidenceState(state)) throw new Error("Estado de evidencia H40 inválido.");
  if (!state.active || state.session === null) {
    throw new Error("La sesión de evidencia H40 no está activa.");
  }
  if (!isLatency(visualLatencyMs))
    throw new Error("La latencia debe ser finita y mayor o igual a 0.");
  if (operationFingerprint !== undefined && !isSha256Hex(operationFingerprint)) {
    throw new Error("La huella de operación debe ser un SHA-256 hexadecimal.");
  }
  const sample: PilotEvidenceSample = operationFingerprint
    ? { visualLatencyMs, operationFingerprint }
    : { visualLatencyMs };
  const samples = [...state.session.samples, sample].slice(-PILOT_MAXIMUM_SAMPLES);
  return { ...state, session: { ...state.session, samples } };
}

export function validatePilotEvidenceState(value: unknown): value is PilotEvidenceState {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version", "deviceAlias", "active", "session"])
  ) {
    return false;
  }
  if (value.version !== PILOT_EVIDENCE_VERSION || typeof value.active !== "boolean") return false;
  if (typeof value.deviceAlias !== "string") return false;
  try {
    if (normalizePilotDeviceAlias(value.deviceAlias) !== value.deviceAlias) return false;
  } catch {
    return false;
  }
  if (value.session !== null && !validateSession(value.session)) return false;
  return !value.active || value.session !== null;
}

export function loadPilotEvidenceState(
  storage: PilotEvidenceStorage,
  key = PILOT_EVIDENCE_STORAGE_KEY,
): PilotEvidenceState | null {
  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    return validatePilotEvidenceState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePilotEvidenceState(
  storage: PilotEvidenceStorage,
  state: PilotEvidenceState,
  key = PILOT_EVIDENCE_STORAGE_KEY,
): boolean {
  if (!validatePilotEvidenceState(state)) return false;
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearPilotEvidenceState(
  storage: PilotEvidenceStorage,
  key = PILOT_EVIDENCE_STORAGE_KEY,
): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic nearest-rank percentile. For n > 0 it sorts a copy ascending
 * and returns sorted[ceil(p * n) - 1]. This deliberately performs no
 * interpolation, so different phones produce the same result bit-for-bit.
 */
export function nearestRankPercentile(
  samples: readonly number[],
  percentile: number,
): number | null {
  if (samples.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error("El percentil debe estar en el intervalo (0, 1].");
  }
  if (!samples.every(isLatency)) throw new Error("Las muestras de latencia son inválidas.");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

export function summarizePilotLatencies(samples: readonly number[]): PilotEvidenceSummary {
  if (samples.length > PILOT_MAXIMUM_SAMPLES || !samples.every(isLatency)) {
    throw new Error("Las muestras de latencia son inválidas.");
  }
  return {
    sampleCount: samples.length,
    p50Ms: nearestRankPercentile(samples, 0.5),
    p95Ms: nearestRankPercentile(samples, 0.95),
    minimumSampleSize: PILOT_MINIMUM_SAMPLES,
    minimumSampleSizeMet: samples.length >= PILOT_MINIMUM_SAMPLES,
  };
}

export function canonicalPilotJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON canónico no admite números no finitos.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPilotJson(item)).join(",")}]`;
  }
  if (!isPlainRecord(value)) throw new Error("JSON canónico solo admite objetos simples.");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPilotJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

export async function sha256PilotHex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPilotOperationFingerprint(
  runSalt: string,
  operationId: string,
): Promise<string> {
  if (!isSha256Hex(runSalt)) throw new Error("El salt H40 debe contener 32 bytes hexadecimales.");
  if (operationId.length === 0 || operationId.length > 512)
    throw new Error("El identificador efímero de operación es inválido.");
  return sha256PilotHex(`${PILOT_OPERATION_FINGERPRINT_DOMAIN}${runSalt}${operationId}`);
}

export async function hashPilotProjection(
  runSalt: string,
  rows: readonly { readonly id: string; readonly state: string; readonly version: number }[],
): Promise<string> {
  if (!isSha256Hex(runSalt)) throw new Error("El salt H40 debe contener 32 bytes hexadecimales.");
  const canonicalRows = rows.map((row) => {
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      row.id.length > 512 ||
      typeof row.state !== "string" ||
      row.state.length === 0 ||
      row.state.length > 64 ||
      !isNonNegativeInteger(row.version)
    ) {
      throw new Error("Fila de proyección H40 inválida.");
    }
    return { id: row.id, state: row.state, version: row.version };
  });
  canonicalRows.sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    if (left.state !== right.state) return left.state < right.state ? -1 : 1;
    return left.version - right.version;
  });
  return sha256PilotHex(
    `${PILOT_PROJECTION_HASH_DOMAIN}${runSalt}${canonicalPilotJson(canonicalRows)}`,
  );
}

function validatePilotMetric(metric: PilotMetricRecord): void {
  if (
    !["OFFLINE_START", "OFFLINE_END", "BOOT", "SYNC_START", "SYNC_END", "RECOVERY"].includes(
      metric.eventKind,
    )
  ) {
    throw new Error("Tipo de métrica H40 inválido.");
  }
  if (!Number.isSafeInteger(metric.recordedSequence) || metric.recordedSequence < 1) {
    throw new Error("Secuencia de métrica H40 inválida.");
  }
  if (!isCanonicalIsoTimestamp(metric.wallAt)) throw new Error("wallAt de métrica inválido.");
  if (metric.monotonicMs !== undefined && !isLatency(metric.monotonicMs)) {
    throw new Error("Reloj monotónico inválido.");
  }
  for (const count of [
    metric.pending,
    metric.applied,
    metric.conflict,
    metric.rejected,
    metric.replayed,
  ]) {
    if (count !== undefined && !isNonNegativeInteger(count)) {
      throw new Error("Conteo de métrica H40 inválido.");
    }
  }
  if (
    metric.errorCode !== undefined &&
    (typeof metric.errorCode !== "string" || metric.errorCode.length > 80)
  ) {
    throw new Error("Código de error H40 inválido.");
  }
}

interface MetricPairStart {
  readonly boot: number;
  readonly monotonicMs?: number;
  readonly wallMs: number;
}

export function summarizePilotMetrics(metrics: readonly PilotMetricRecord[]): PilotMetricSummary {
  let boot = 0;
  let previousSequence = 0;
  let previousWallMs: number | null = null;
  let previousMonotonicMs: number | null = null;
  let offlineStart: MetricPairStart | null = null;
  let syncStart: MetricPairStart | null = null;
  let offlineObservedMs = 0;
  let restartGapMs = 0;
  let syncDurationMs = 0;
  let maxPending = 0;
  let applied = 0;
  let conflict = 0;
  let rejected = 0;
  let replayed = 0;
  let errorEvents = 0;
  let clockRollbackDetected = false;
  let manualConfirmationRequired = false;

  for (const metric of metrics) {
    validatePilotMetric(metric);
    if (metric.recordedSequence <= previousSequence) {
      throw new Error("Las métricas H40 deben estar ordenadas por recordedSequence.");
    }
    previousSequence = metric.recordedSequence;
    const wallMs = new Date(metric.wallAt).valueOf();
    if (previousWallMs !== null && wallMs < previousWallMs) {
      clockRollbackDetected = true;
      manualConfirmationRequired = true;
    }
    previousWallMs = wallMs;

    if (metric.eventKind === "BOOT") {
      if (offlineStart !== null) {
        const gap = wallMs - offlineStart.wallMs;
        if (gap < 0) clockRollbackDetected = true;
        else restartGapMs += gap;
        offlineStart = null;
        manualConfirmationRequired = true;
      }
      if (syncStart !== null) {
        const gap = wallMs - syncStart.wallMs;
        if (gap < 0) clockRollbackDetected = true;
        else syncDurationMs += gap;
        syncStart = null;
        manualConfirmationRequired = true;
      }
      boot += 1;
      previousMonotonicMs = metric.monotonicMs ?? null;
    } else if (metric.monotonicMs !== undefined) {
      if (previousMonotonicMs !== null && metric.monotonicMs < previousMonotonicMs) {
        clockRollbackDetected = true;
        manualConfirmationRequired = true;
      }
      previousMonotonicMs = metric.monotonicMs;
    }

    const pairPoint: MetricPairStart = {
      boot,
      ...(metric.monotonicMs === undefined ? {} : { monotonicMs: metric.monotonicMs }),
      wallMs,
    };

    if (metric.eventKind === "OFFLINE_START") {
      if (offlineStart !== null) manualConfirmationRequired = true;
      offlineStart = pairPoint;
    } else if (metric.eventKind === "OFFLINE_END") {
      if (offlineStart === null) {
        manualConfirmationRequired = true;
      } else if (offlineStart.boot !== boot) {
        const gap = wallMs - offlineStart.wallMs;
        if (gap < 0) clockRollbackDetected = true;
        else restartGapMs += gap;
        manualConfirmationRequired = true;
      } else if (
        offlineStart.monotonicMs !== undefined &&
        metric.monotonicMs !== undefined &&
        metric.monotonicMs >= offlineStart.monotonicMs
      ) {
        offlineObservedMs += metric.monotonicMs - offlineStart.monotonicMs;
      } else {
        if (
          offlineStart.monotonicMs !== undefined &&
          metric.monotonicMs !== undefined &&
          metric.monotonicMs < offlineStart.monotonicMs
        ) {
          clockRollbackDetected = true;
        }
        manualConfirmationRequired = true;
      }
      offlineStart = null;
    }

    if (metric.eventKind === "SYNC_START") {
      if (syncStart !== null) manualConfirmationRequired = true;
      syncStart = pairPoint;
    } else if (metric.eventKind === "SYNC_END") {
      if (syncStart === null) {
        manualConfirmationRequired = true;
      } else if (
        syncStart.boot === boot &&
        syncStart.monotonicMs !== undefined &&
        metric.monotonicMs !== undefined &&
        metric.monotonicMs >= syncStart.monotonicMs
      ) {
        syncDurationMs += metric.monotonicMs - syncStart.monotonicMs;
      } else {
        const gap = wallMs - syncStart.wallMs;
        if (gap < 0) clockRollbackDetected = true;
        else syncDurationMs += gap;
        manualConfirmationRequired = true;
      }
      syncStart = null;
    }

    maxPending = Math.max(maxPending, metric.pending ?? 0);
    applied += metric.applied ?? 0;
    conflict += metric.conflict ?? 0;
    rejected += metric.rejected ?? 0;
    replayed += metric.replayed ?? 0;
    if (metric.errorCode) errorEvents += 1;
  }

  if (offlineStart !== null || syncStart !== null) manualConfirmationRequired = true;
  return {
    offlineObservedMs,
    restartGapMs,
    offlineTotalMs: offlineObservedMs + restartGapMs,
    syncDurationMs,
    maxPending,
    applied,
    conflict,
    rejected,
    replayed,
    errorEvents,
    clockRollbackDetected,
    manualConfirmationRequired,
  };
}

function validateTechnicalEnvironment(value: PilotTechnicalEnvironment): void {
  const keys: (keyof PilotTechnicalEnvironment)[] = [
    "secureContext",
    "crossOriginIsolated",
    "opfsPersistent",
    "serviceWorkerControlled",
    "online",
  ];
  for (const key of keys) {
    if (typeof value[key] !== "boolean") throw new Error(`Entorno técnico inválido: ${key}.`);
  }
}

function validateAggregateCounts(value: PilotAggregateCounts): void {
  const localKeys: (keyof PilotAggregateCounts)[] = ["pendingOperations", "conflicts"];
  for (const key of localKeys) {
    if (!isNonNegativeInteger(value[key])) throw new Error(`Conteo agregado inválido: ${key}.`);
  }
  for (const key of ["lostOperations", "duplicateOperations"] as const) {
    if (value[key] !== null && !isNonNegativeInteger(value[key])) {
      throw new Error(`Resultado de conciliación inválido: ${key}.`);
    }
  }
}

/**
 * @deprecated localStorage state is not authoritative evidence. Kept so old
 * callers fail explicitly instead of silently fabricating SQLite-only fields.
 */
export async function createPilotEvidenceExport(
  input: PilotEvidenceExportInput,
): Promise<PilotEvidenceExportV1> {
  if (!validatePilotEvidenceState(input.state) || input.state.session === null) {
    throw new Error("No existe una sesión H40 válida para exportar.");
  }
  throw new Error("La exportación H40 exige la fuente autoritativa SQLite v8.");
}

export async function createPilotEvidenceExportFromSource(
  input: PilotEvidenceExportFromSourceInput,
): Promise<PilotEvidenceExportV1> {
  if (!SAFE_VERSION_PATTERN.test(input.appVersion))
    throw new Error("Versión de aplicación inválida.");
  if (!SAFE_VERSION_PATTERN.test(input.shellVersion)) throw new Error("Versión de shell inválida.");
  if (input.appVersion !== input.shellVersion) {
    throw new Error("La versión de aplicación y shell no coincide.");
  }
  if (input.schemaVersion !== PILOT_EXPECTED_SCHEMA_VERSION) {
    throw new Error("Versión de esquema H40 incompatible.");
  }
  validateTechnicalEnvironment(input.environment);
  validateAggregateCounts(input.counts);

  const evidence = input.evidence;
  if (!isPlainRecord(evidence)) throw new Error("Fuente SQLite H40 inválida.");
  let deviceAlias: string;
  try {
    deviceAlias = normalizePilotDeviceAlias(evidence.summary.deviceAlias);
  } catch {
    throw new Error("Alias de evidencia inválido.");
  }
  if (deviceAlias !== evidence.summary.deviceAlias)
    throw new Error("Alias de evidencia no canónico.");
  if (!isCanonicalIsoTimestamp(evidence.summary.startedAt)) throw new Error("startedAt inválido.");
  if (evidence.summary.status !== "FINISHED") throw new Error("La corrida H40 no está finalizada.");
  const endedAt = evidence.summary.endedAt ?? null;
  if (!isCanonicalIsoTimestamp(endedAt)) {
    throw new Error("endedAt no coincide con el estado de ejecución H40.");
  }
  if (
    endedAt !== null &&
    new Date(endedAt).valueOf() < new Date(evidence.summary.startedAt).valueOf()
  ) {
    throw new Error("endedAt precede a startedAt.");
  }
  if (!isSha256Hex(evidence.salt))
    throw new Error("El salt de huellas debe contener 32 bytes hexadecimales.");
  if (evidence.summary.buildId !== input.appVersion) {
    throw new Error("El build exportado no coincide con el build que inició la corrida.");
  }
  if (!Array.isArray(evidence.operations) || evidence.operations.length > PILOT_MAXIMUM_SAMPLES) {
    throw new Error("Operaciones de evidencia inválidas.");
  }

  const latenciesMs: number[] = [];
  const persistLatenciesMs: number[] = [];
  const operationFingerprints: string[] = [];
  let markActions = 0;
  let undoActions = 0;
  let previousRecordedAt = 0;
  for (const operation of evidence.operations) {
    if (!isPlainRecord(operation)) throw new Error("Operación de evidencia inválida.");
    if (operation.actionKind !== "MARK" && operation.actionKind !== "UNDO") {
      throw new Error("Tipo de acción H40 inválido.");
    }
    if (!isCanonicalIsoTimestamp(operation.recordedAt)) {
      throw new Error("recordedAt de operación inválido.");
    }
    const recordedAt = new Date(operation.recordedAt).valueOf();
    if (recordedAt < previousRecordedAt) {
      throw new Error("Las operaciones H40 deben estar ordenadas por recordedAt.");
    }
    previousRecordedAt = recordedAt;
    if (!isLatency(operation.visualMs) || !isLatency(operation.persistMs)) {
      throw new Error("La operación no tiene latencias visual/persistencia completas.");
    }
    const hasOperationId = operation.operationId !== undefined;
    const hasOperationFingerprint = operation.operationFingerprint !== undefined;
    if (hasOperationId === hasOperationFingerprint) {
      throw new Error("Cada operación requiere ID efímero o huella, pero no ambos.");
    }
    if (operation.operationId !== undefined) {
      if (typeof operation.operationId !== "string") {
        throw new Error("ID efímero de operación inválido.");
      }
      operationFingerprints.push(
        await hashPilotOperationFingerprint(evidence.salt, operation.operationId),
      );
    } else if (isSha256Hex(operation.operationFingerprint)) {
      operationFingerprints.push(operation.operationFingerprint);
    } else {
      throw new Error("Huella de operación inválida.");
    }
    latenciesMs.push(operation.visualMs);
    persistLatenciesMs.push(operation.persistMs);
    if (operation.actionKind === "MARK") markActions += 1;
    else undoActions += 1;
  }

  if (
    evidence.operations.length < PILOT_MINIMUM_SAMPLES ||
    evidence.summary.actionCount !== evidence.operations.length ||
    evidence.summary.completedActionCount !== evidence.operations.length
  ) {
    throw new Error("La corrida H40 no contiene 30 acciones completas y coherentes.");
  }

  if (!Array.isArray(evidence.metrics) || evidence.metrics.length > PILOT_MAXIMUM_METRICS) {
    throw new Error("Métricas H40 inválidas.");
  }
  const metricSummary = summarizePilotMetrics(evidence.metrics);
  if (!isPlainRecord(evidence.finalOutbox)) throw new Error("Outbox final inválida.");
  const finalOutboxKeys: (keyof PilotFinalOutbox)[] = [
    "pending",
    "sending",
    "conflict",
    "rejected",
  ];
  for (const key of finalOutboxKeys) {
    if (!isNonNegativeInteger(evidence.finalOutbox[key])) {
      throw new Error(`Conteo final de outbox inválido: ${key}.`);
    }
  }
  if (
    input.counts.pendingOperations !==
      evidence.finalOutbox.pending + evidence.finalOutbox.sending ||
    input.counts.conflicts !== evidence.finalOutbox.conflict ||
    input.counts.lostOperations !== null ||
    input.counts.duplicateOperations !== null
  ) {
    throw new Error("Los conteos agregados no coinciden con el snapshot final.");
  }
  if (Object.values(evidence.finalOutbox).some((count) => count !== 0)) {
    throw new Error("La evidencia H40 exige una outbox final sin atención.");
  }
  if (!isNonNegativeInteger(evidence.recoveredSending)) {
    throw new Error("Conteo recoveredSending inválido.");
  }
  if (!isSha256Hex(evidence.projectionHash)) throw new Error("Hash de proyección inválido.");

  const summary = summarizePilotLatencies(latenciesMs);
  const persistenceSummary = summarizePilotLatencies(persistLatenciesMs);
  const runSaltDigest = await sha256PilotHex(`rutacuadrilla:h40:run-salt:v1\n${evidence.salt}`);
  const manifestHash = await sha256PilotHex(
    canonicalPilotJson({
      fingerprintSalt: evidence.salt,
      operationFingerprints: [...operationFingerprints].sort(),
      projectionHash: evidence.projectionHash,
      runSaltDigest,
      version: PILOT_EVIDENCE_VERSION,
    }),
  );

  const canonicalContent = {
    version: PILOT_EVIDENCE_VERSION,
    deviceAlias,
    createdAt: evidence.summary.startedAt,
    endedAt,
    status: evidence.summary.status,
    measurementActive: false,
    app: {
      version: input.appVersion,
      shellVersion: input.shellVersion,
      schemaVersion: input.schemaVersion,
    },
    environment: {
      secureContext: input.environment.secureContext,
      crossOriginIsolated: input.environment.crossOriginIsolated,
      opfsPersistent: input.environment.opfsPersistent,
      serviceWorkerControlled: input.environment.serviceWorkerControlled,
      online: input.environment.online,
    },
    counts: {
      successfulActions: latenciesMs.length,
      markActions,
      undoActions,
      pendingOperations: input.counts.pendingOperations,
      conflicts: input.counts.conflicts,
      lostOperations: input.counts.lostOperations,
      duplicateOperations: input.counts.duplicateOperations,
    },
    latenciesMs,
    summary,
    persistLatenciesMs,
    persistenceSummary,
    metricSummary,
    finalOutbox: {
      pending: evidence.finalOutbox.pending,
      sending: evidence.finalOutbox.sending,
      conflict: evidence.finalOutbox.conflict,
      rejected: evidence.finalOutbox.rejected,
    },
    recoveredSending: evidence.recoveredSending,
    projectionHash: evidence.projectionHash,
    operationFingerprints,
    fingerprintSalt: evidence.salt,
    runSaltDigest,
    manifestHash,
  } satisfies Omit<PilotEvidenceExportV1, "integrity">;

  return {
    ...canonicalContent,
    integrity: {
      algorithm: "SHA-256",
      canonicalContentHash: await sha256PilotHex(
        canonicalPilotJson(canonicalContent as unknown as JsonValue),
      ),
    },
  };
}
