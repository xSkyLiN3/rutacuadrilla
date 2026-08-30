import { queryFieldShellVersion } from "./serviceWorker";

export const PILOT_DIAGNOSTICS_CONTRACT_VERSION = "h40-pilot-diagnostics-v1";
export const EXPECTED_PILOT_LOCAL_SCHEMA_VERSION = 8;

export const PILOT_DIAGNOSTIC_BLOCK_CODES = [
  "BUILD_ID_UNAVAILABLE",
  "INSECURE_CONTEXT",
  "CROSS_ORIGIN_ISOLATION_UNAVAILABLE",
  "WEB_CRYPTO_UNAVAILABLE",
  "RANDOM_UUID_UNAVAILABLE",
  "SERVICE_WORKER_UNSUPPORTED",
  "SERVICE_WORKER_UNCONTROLLED",
  "SERVICE_WORKER_NOT_ACTIVATED",
  "SERVICE_WORKER_VERSION_UNAVAILABLE",
  "SHELL_BUILD_MISMATCH",
  "OPFS_UNAVAILABLE",
  "DATABASE_NOT_PERSISTENT",
  "LOCAL_SCHEMA_VERSION_MISMATCH",
  "IDENTITY_NOT_CURRENT",
] as const;

export type PilotDiagnosticBlockCode = (typeof PILOT_DIAGNOSTIC_BLOCK_CODES)[number];
export type PilotDiagnosticStatus = "READY" | "BLOCKED";

export interface PilotDiagnosticsInput {
  readonly buildId: string;
  readonly databasePersistent: boolean;
  readonly identityCurrent: boolean;
  readonly localSchemaVersion: number;
  readonly shellVersionTimeoutMs?: number;
}

/**
 * DTO deliberadamente agregado: no contiene user agent, URL, identidad,
 * correo, ids operativos, coordenadas ni mensajes de excepción.
 */
export interface PilotDiagnosticsReport {
  readonly contractVersion: typeof PILOT_DIAGNOSTICS_CONTRACT_VERSION;
  readonly status: PilotDiagnosticStatus;
  readonly blockedCodes: readonly PilotDiagnosticBlockCode[];
  readonly buildId: string | null;
  readonly isSecureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly webCryptoSupported: boolean;
  readonly randomUUIDSupported: boolean;
  readonly serviceWorkerSupported: boolean;
  readonly serviceWorkerControlled: boolean;
  readonly serviceWorkerActivated: boolean;
  readonly shellVersion: string | null;
  readonly opfsSupported: boolean;
  readonly storagePersisted: boolean | null;
  readonly storageUsageMiB: number | null;
  readonly storageQuotaMiB: number | null;
  readonly localSchemaVersion: number | null;
  readonly expectedLocalSchemaVersion: typeof EXPECTED_PILOT_LOCAL_SCHEMA_VERSION;
  readonly databasePersistent: boolean;
  readonly online: boolean;
  readonly identityCurrent: boolean;
}

interface PilotStorageManager {
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  getDirectory?: () => Promise<unknown>;
  persisted?: () => Promise<boolean>;
}

const SAFE_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const BYTES_PER_MIB = 1_048_576;

function safeBoolean(probe: () => unknown): boolean {
  try {
    return probe() === true;
  } catch {
    return false;
  }
}

function safeBuildId(value: unknown): string | null {
  return typeof value === "string" && SAFE_BUILD_ID.test(value) ? value : null;
}

function safeSchemaVersion(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function storageManager(): PilotStorageManager | null {
  try {
    if (typeof navigator === "undefined") return null;
    return (navigator.storage as PilotStorageManager | undefined) ?? null;
  } catch {
    return null;
  }
}

function aggregatedMiB(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value / BYTES_PER_MIB);
}

async function readStoragePersisted(storage: PilotStorageManager | null): Promise<boolean | null> {
  if (typeof storage?.persisted !== "function") return null;
  try {
    const result = await storage.persisted();
    return typeof result === "boolean" ? result : null;
  } catch {
    return null;
  }
}

async function readStorageEstimate(
  storage: PilotStorageManager | null,
): Promise<{ quotaMiB: number | null; usageMiB: number | null }> {
  if (typeof storage?.estimate !== "function") return { quotaMiB: null, usageMiB: null };
  try {
    const estimate = await storage.estimate();
    return {
      quotaMiB: aggregatedMiB(estimate?.quota),
      usageMiB: aggregatedMiB(estimate?.usage),
    };
  } catch {
    return { quotaMiB: null, usageMiB: null };
  }
}

function serviceWorkerSnapshot(): {
  activated: boolean;
  controlled: boolean;
  controller: ServiceWorker | null;
  supported: boolean;
} {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return { activated: false, controlled: false, controller: null, supported: false };
    }
    const container = navigator.serviceWorker;
    if (!container) {
      return { activated: false, controlled: false, controller: null, supported: false };
    }
    const controller = container.controller ?? null;
    const controlled = controller !== null;
    return {
      activated: controlled && controller.state === "activated",
      controlled,
      controller,
      supported: true,
    };
  } catch {
    return { activated: false, controlled: false, controller: null, supported: false };
  }
}

function opfsAvailable(storage: PilotStorageManager | null): boolean {
  try {
    // createSyncAccessHandle puede exponerse solo dentro del DedicatedWorker.
    // `databasePersistent` confirma después que SQLite abrió realmente OPFS.
    return typeof storage?.getDirectory === "function";
  } catch {
    return false;
  }
}

export async function collectPilotDiagnostics(
  input: PilotDiagnosticsInput,
): Promise<PilotDiagnosticsReport> {
  const buildId = safeBuildId(input.buildId);
  const localSchemaVersion = safeSchemaVersion(input.localSchemaVersion);
  const databasePersistent = input.databasePersistent === true;
  const identityCurrent = input.identityCurrent === true;
  const isSecureContext = safeBoolean(
    () => (globalThis as typeof globalThis & { isSecureContext?: unknown }).isSecureContext,
  );
  const crossOriginIsolated = safeBoolean(
    () => (globalThis as typeof globalThis & { crossOriginIsolated?: unknown }).crossOriginIsolated,
  );
  const webCryptoSupported = safeBoolean(
    () => typeof globalThis.crypto?.subtle?.digest === "function",
  );
  const randomUUIDSupported = safeBoolean(
    () => typeof globalThis.crypto?.randomUUID === "function",
  );
  const online = safeBoolean(() => navigator.onLine);
  const storage = storageManager();
  const opfsSupported = opfsAvailable(storage);
  const serviceWorker = serviceWorkerSnapshot();

  const [shellVersion, storagePersisted, storageEstimate] = await Promise.all([
    serviceWorker.activated
      ? queryFieldShellVersion({
          controller: serviceWorker.controller,
          timeoutMs: input.shellVersionTimeoutMs,
        })
      : Promise.resolve(null),
    readStoragePersisted(storage),
    readStorageEstimate(storage),
  ]);

  const blockedCodes: PilotDiagnosticBlockCode[] = [];
  if (!buildId) blockedCodes.push("BUILD_ID_UNAVAILABLE");
  if (!isSecureContext) blockedCodes.push("INSECURE_CONTEXT");
  if (!crossOriginIsolated) blockedCodes.push("CROSS_ORIGIN_ISOLATION_UNAVAILABLE");
  if (!webCryptoSupported) blockedCodes.push("WEB_CRYPTO_UNAVAILABLE");
  if (!randomUUIDSupported) blockedCodes.push("RANDOM_UUID_UNAVAILABLE");
  if (!serviceWorker.supported) {
    blockedCodes.push("SERVICE_WORKER_UNSUPPORTED");
  } else if (!serviceWorker.controlled) {
    blockedCodes.push("SERVICE_WORKER_UNCONTROLLED");
  } else if (!serviceWorker.activated) {
    blockedCodes.push("SERVICE_WORKER_NOT_ACTIVATED");
  } else if (!shellVersion) {
    blockedCodes.push("SERVICE_WORKER_VERSION_UNAVAILABLE");
  } else if (buildId && shellVersion !== buildId) {
    blockedCodes.push("SHELL_BUILD_MISMATCH");
  }
  if (!opfsSupported) blockedCodes.push("OPFS_UNAVAILABLE");
  if (!databasePersistent) blockedCodes.push("DATABASE_NOT_PERSISTENT");
  if (localSchemaVersion !== EXPECTED_PILOT_LOCAL_SCHEMA_VERSION) {
    blockedCodes.push("LOCAL_SCHEMA_VERSION_MISMATCH");
  }
  if (!identityCurrent) blockedCodes.push("IDENTITY_NOT_CURRENT");

  return {
    contractVersion: PILOT_DIAGNOSTICS_CONTRACT_VERSION,
    status: blockedCodes.length === 0 ? "READY" : "BLOCKED",
    blockedCodes,
    buildId,
    isSecureContext,
    crossOriginIsolated,
    webCryptoSupported,
    randomUUIDSupported,
    serviceWorkerSupported: serviceWorker.supported,
    serviceWorkerControlled: serviceWorker.controlled,
    serviceWorkerActivated: serviceWorker.activated,
    shellVersion,
    opfsSupported,
    storagePersisted,
    storageUsageMiB: storageEstimate.usageMiB,
    storageQuotaMiB: storageEstimate.quotaMiB,
    localSchemaVersion,
    expectedLocalSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    databasePersistent,
    online,
    identityCurrent,
  };
}
