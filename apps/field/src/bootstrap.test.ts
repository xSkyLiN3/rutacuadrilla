import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapField, retireLegacyFieldShell } from "./bootstrap";

const FIELD_SERVICE_WORKER_URL = "/field-sw.js";
const FIELD_SHELL_CACHE_PREFIX = "rutacuadrilla-field-shell-";
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
  if (originalCaches) {
    Object.defineProperty(globalThis, "caches", originalCaches);
  } else {
    Reflect.deleteProperty(globalThis, "caches");
  }
  sessionStorage.clear();
});

describe("Field bootstrap after the legacy shell", () => {
  it("retira solo el worker y caches de Campo y recarga una sola vez si controlaban la pagina", async () => {
    const fieldWorker = {
      scriptURL: new URL(FIELD_SERVICE_WORKER_URL, window.location.href).href,
    } as ServiceWorker;
    const unrelatedWorker = {
      scriptURL: new URL("/other-sw.js", window.location.href).href,
    } as ServiceWorker;
    const unregisterField = vi.fn().mockResolvedValue(true);
    const unregisterUnrelated = vi.fn().mockResolvedValue(true);
    const serviceWorkerState = {
      controller: fieldWorker as ServiceWorker | null,
      getRegistrations: vi.fn().mockResolvedValue([
        {
          active: fieldWorker,
          installing: null,
          unregister: unregisterField,
          waiting: null,
        },
        {
          active: unrelatedWorker,
          installing: null,
          unregister: unregisterUnrelated,
          waiting: null,
        },
      ]),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorkerState,
    });
    const deleteCache = vi.fn().mockResolvedValue(true);
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        delete: deleteCache,
        keys: vi
          .fn()
          .mockResolvedValue([`${FIELD_SHELL_CACHE_PREFIX}old`, "unrelated-shell-cache"]),
      },
    });
    const reload = vi.fn();

    await expect(retireLegacyFieldShell({ reload })).resolves.toBe(true);
    serviceWorkerState.controller = null;
    await expect(retireLegacyFieldShell({ reload })).resolves.toBe(false);

    expect(unregisterField).toHaveBeenCalledTimes(2);
    expect(unregisterUnrelated).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenNthCalledWith(1, `${FIELD_SHELL_CACHE_PREFIX}old`);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("falla cerrado sin recargar cuando no puede retirar un controlador de Campo", async () => {
    const fieldWorker = {
      scriptURL: new URL(FIELD_SERVICE_WORKER_URL, window.location.href).href,
    } as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: fieldWorker,
        getRegistrations: vi.fn().mockResolvedValue([
          {
            active: fieldWorker,
            installing: null,
            unregister: vi.fn().mockRejectedValue(new Error("registration locked")),
            waiting: null,
          },
        ]),
      },
    });
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: { delete: vi.fn(), keys: vi.fn().mockResolvedValue([]) },
    });
    const reload = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(retireLegacyFieldShell({ reload })).rejects.toThrow(
      /FIELD_LEGACY_SHELL_RETIREMENT_FAILED/u,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("no importa la aplicacion cuando el rescate solicita recarga", async () => {
    const loadMain = vi.fn();

    await bootstrapField({
      loadMain,
      retireLegacyShell: vi.fn().mockResolvedValue(true),
    });

    expect(loadMain).not.toHaveBeenCalled();
  });

  it("importa la aplicacion solo despues de terminar el rescate", async () => {
    const order: string[] = [];

    await bootstrapField({
      loadMain: vi.fn(async () => {
        order.push("main");
      }),
      retireLegacyShell: vi.fn(async () => {
        order.push("cleanup");
        return false;
      }),
    });

    expect(order).toEqual(["cleanup", "main"]);
  });
});
