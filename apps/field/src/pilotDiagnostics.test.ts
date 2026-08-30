import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPilotDiagnostics,
  EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
  PILOT_DIAGNOSTICS_CONTRACT_VERSION,
} from "./pilotDiagnostics";
import { queryFieldShellVersion } from "./serviceWorker";

vi.mock("./serviceWorker", () => ({
  queryFieldShellVersion: vi.fn(),
}));

const originalDescriptors = {
  crossOriginIsolated: Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated"),
  crypto: Object.getOwnPropertyDescriptor(globalThis, "crypto"),
  fileSystemFileHandle: Object.getOwnPropertyDescriptor(globalThis, "FileSystemFileHandle"),
  isSecureContext: Object.getOwnPropertyDescriptor(globalThis, "isSecureContext"),
  online: Object.getOwnPropertyDescriptor(navigator, "onLine"),
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
  storage: Object.getOwnPropertyDescriptor(navigator, "storage"),
};

function restoreProperty(target: object, key: PropertyKey, descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function setPilotRuntime(options?: {
  activated?: boolean;
  controlled?: boolean;
  crypto?: boolean;
  isolated?: boolean;
  online?: boolean;
  opfs?: boolean;
  persisted?: boolean | "reject";
  secure?: boolean;
  storageEstimate?: { quota?: number; usage?: number } | "reject";
  swSupported?: boolean;
}): void {
  const settings = {
    activated: true,
    controlled: true,
    crypto: true,
    isolated: true,
    online: true,
    opfs: true,
    persisted: true as boolean | "reject",
    secure: true,
    storageEstimate: {
      quota: 100.4 * 1_048_576,
      usage: 5.6 * 1_048_576,
    } as { quota?: number; usage?: number } | "reject",
    swSupported: true,
    ...options,
  };

  Object.defineProperty(globalThis, "isSecureContext", {
    configurable: true,
    value: settings.secure,
  });
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    configurable: true,
    value: settings.isolated,
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: settings.crypto
      ? {
          randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
          subtle: { digest: vi.fn() },
        }
      : {},
  });
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    configurable: true,
    value: settings.opfs
      ? class {
          createSyncAccessHandle() {}
        }
      : class {},
  });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: settings.online,
  });
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      ...(settings.opfs ? { getDirectory: vi.fn() } : {}),
      persisted:
        settings.persisted === "reject"
          ? vi.fn().mockRejectedValue(new Error("detalle no exportable"))
          : vi.fn().mockResolvedValue(settings.persisted),
      estimate:
        settings.storageEstimate === "reject"
          ? vi.fn().mockRejectedValue(new Error("detalle no exportable"))
          : vi.fn().mockResolvedValue(settings.storageEstimate),
    },
  });
  if (settings.swSupported) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: settings.controlled
          ? { state: settings.activated ? "activated" : "activating" }
          : null,
      },
    });
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
}

afterEach(() => {
  vi.clearAllMocks();
  restoreProperty(globalThis, "crossOriginIsolated", originalDescriptors.crossOriginIsolated);
  restoreProperty(globalThis, "crypto", originalDescriptors.crypto);
  restoreProperty(globalThis, "FileSystemFileHandle", originalDescriptors.fileSystemFileHandle);
  restoreProperty(globalThis, "isSecureContext", originalDescriptors.isSecureContext);
  restoreProperty(navigator, "onLine", originalDescriptors.online);
  restoreProperty(navigator, "serviceWorker", originalDescriptors.serviceWorker);
  restoreProperty(navigator, "storage", originalDescriptors.storage);
});

describe("collectPilotDiagnostics", () => {
  it("declara READY solo con todas las precondiciones críticas y agrega almacenamiento", async () => {
    setPilotRuntime();
    vi.mocked(queryFieldShellVersion).mockResolvedValue("2026-08-21.15");

    const report = await collectPilotDiagnostics({
      buildId: "2026-08-21.15",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });

    expect(report).toEqual({
      contractVersion: PILOT_DIAGNOSTICS_CONTRACT_VERSION,
      status: "READY",
      blockedCodes: [],
      buildId: "2026-08-21.15",
      isSecureContext: true,
      crossOriginIsolated: true,
      webCryptoSupported: true,
      randomUUIDSupported: true,
      serviceWorkerSupported: true,
      serviceWorkerControlled: true,
      serviceWorkerActivated: true,
      shellVersion: "2026-08-21.15",
      opfsSupported: true,
      storagePersisted: true,
      storageUsageMiB: 6,
      storageQuotaMiB: 100,
      localSchemaVersion: 8,
      expectedLocalSchemaVersion: 8,
      databasePersistent: true,
      online: true,
      identityCurrent: true,
    });
  });

  it("falla cerrado con códigos cerrados y sin propagar datos sensibles", async () => {
    setPilotRuntime({
      controlled: false,
      crypto: false,
      isolated: false,
      online: false,
      opfs: false,
      persisted: "reject",
      secure: false,
      storageEstimate: "reject",
    });

    const report = await collectPilotDiagnostics({
      buildId: "https://host.test/ruta?email=persona@example.test",
      databasePersistent: false,
      identityCurrent: false,
      localSchemaVersion: 6,
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.blockedCodes).toEqual([
      "BUILD_ID_UNAVAILABLE",
      "INSECURE_CONTEXT",
      "CROSS_ORIGIN_ISOLATION_UNAVAILABLE",
      "WEB_CRYPTO_UNAVAILABLE",
      "RANDOM_UUID_UNAVAILABLE",
      "SERVICE_WORKER_UNCONTROLLED",
      "OPFS_UNAVAILABLE",
      "DATABASE_NOT_PERSISTENT",
      "LOCAL_SCHEMA_VERSION_MISMATCH",
      "IDENTITY_NOT_CURRENT",
    ]);
    expect(report).toMatchObject({
      buildId: null,
      online: false,
      shellVersion: null,
      storagePersisted: null,
      storageQuotaMiB: null,
      storageUsageMiB: null,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("host.test");
    expect(serialized).not.toContain("persona@example.test");
    expect(queryFieldShellVersion).not.toHaveBeenCalled();
  });

  it("bloquea un worker no activado o sin versión exacta", async () => {
    setPilotRuntime({ activated: false });
    let report = await collectPilotDiagnostics({
      buildId: "build-7",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });
    expect(report.blockedCodes).toContain("SERVICE_WORKER_NOT_ACTIVATED");
    expect(queryFieldShellVersion).not.toHaveBeenCalled();

    setPilotRuntime();
    vi.mocked(queryFieldShellVersion).mockResolvedValue(null);
    report = await collectPilotDiagnostics({
      buildId: "build-7",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });
    expect(report.blockedCodes).toEqual(["SERVICE_WORKER_VERSION_UNAVAILABLE"]);

    vi.mocked(queryFieldShellVersion).mockResolvedValue("shell-a");
    report = await collectPilotDiagnostics({
      buildId: "shell-b",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });
    expect(report.blockedCodes).toEqual(["SHELL_BUILD_MISMATCH"]);
  });

  it("informa offline y persistencia no concedida sin invalidar una fase ya preparada", async () => {
    setPilotRuntime({ online: false, persisted: false });
    vi.mocked(queryFieldShellVersion).mockResolvedValue("build-7");

    const report = await collectPilotDiagnostics({
      buildId: "build-7",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });

    expect(report).toMatchObject({ status: "READY", online: false, storagePersisted: false });
  });

  it("acepta OPFS sin exigir createSyncAccessHandle en el contexto Window", async () => {
    setPilotRuntime();
    Reflect.deleteProperty(globalThis, "FileSystemFileHandle");
    vi.mocked(queryFieldShellVersion).mockResolvedValue("build-7");

    const report = await collectPilotDiagnostics({
      buildId: "build-7",
      databasePersistent: true,
      identityCurrent: true,
      localSchemaVersion: EXPECTED_PILOT_LOCAL_SCHEMA_VERSION,
    });

    expect(report).toMatchObject({ status: "READY", opfsSupported: true });
  });
});
