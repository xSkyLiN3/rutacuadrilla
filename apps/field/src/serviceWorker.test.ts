/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateFieldServiceWorkerUpdate,
  FIELD_SERVICE_WORKER_SCOPE,
  FIELD_SERVICE_WORKER_URL,
  FIELD_SHELL_READY_EVENT,
  FIELD_SHELL_VERSION_MESSAGE,
  FIELD_UPDATE_AVAILABLE_EVENT,
  queryFieldShellVersion,
  registerFieldServiceWorker,
} from "./serviceWorker";

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalReadyState = Object.getOwnPropertyDescriptor(document, "readyState");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }
  if (originalReadyState) Object.defineProperty(document, "readyState", originalReadyState);
});

class TestMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  peer?: TestMessagePort;

  close(): void {
    this.onmessage = null;
  }

  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data } as MessageEvent<unknown>));
  }
}

function testMessageChannel(): MessageChannel {
  const port1 = new TestMessagePort();
  const port2 = new TestMessagePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 } as unknown as MessageChannel;
}

describe("registerFieldServiceWorker", () => {
  it("no registra el shell cuando la compilación no lo habilita", async () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    await expect(registerFieldServiceWorker({ enabled: false })).resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
  });

  it("registra desde una URL estable y anuncia una versión en espera", async () => {
    const waiting = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      waiting,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        controller: {},
        register,
      },
    });
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });
    const updateListener = vi.fn();
    window.addEventListener(FIELD_UPDATE_AVAILABLE_EVENT, updateListener);

    await expect(registerFieldServiceWorker({ enabled: true })).resolves.toBe(registration);

    expect(register).toHaveBeenCalledWith(FIELD_SERVICE_WORKER_URL, {
      scope: FIELD_SERVICE_WORKER_SCOPE,
      updateViaCache: "none",
    });
    expect(updateListener).toHaveBeenCalledOnce();
    window.removeEventListener(FIELD_UPDATE_AVAILABLE_EVENT, updateListener);
  });

  it("reexpone el mensaje de shell listo con una versión legible", async () => {
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
          if (type === "message") messageListener = listener;
        }),
        controller: {},
        register: vi.fn().mockResolvedValue(registration),
      },
    });
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });
    const readyListener = vi.fn();
    window.addEventListener(FIELD_SHELL_READY_EVENT, readyListener);

    await registerFieldServiceWorker({ enabled: true });
    messageListener?.({
      data: { type: "RUTACUADRILLA_FIELD_SHELL_READY", version: "test-2" },
    } as MessageEvent);

    expect(readyListener).toHaveBeenCalledOnce();
    const readyEvent = readyListener.mock.calls[0]?.[0];
    if (!(readyEvent instanceof CustomEvent)) throw new TypeError("READY_EVENT_MISSING");
    expect(readyEvent.detail).toEqual({
      version: "test-2",
    });
    window.removeEventListener(FIELD_SHELL_READY_EVENT, readyListener);
  });
});

describe("activateFieldServiceWorkerUpdate", () => {
  it("requiere una activación explícita para la versión en espera", () => {
    const postMessage = vi.fn();
    const registration = {
      waiting: { postMessage },
    } as unknown as ServiceWorkerRegistration;

    expect(activateFieldServiceWorkerUpdate(registration)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: "RUTACUADRILLA_ACTIVATE_FIELD_UPDATE",
    });
  });
});

describe("queryFieldShellVersion", () => {
  it("obtiene la versión exacta mediante un MessageChannel", async () => {
    const controller = {
      postMessage: vi.fn((message: unknown, transfer: Transferable[]) => {
        expect(message).toEqual({ type: FIELD_SHELL_VERSION_MESSAGE });
        const replyPort = transfer[0] as unknown as TestMessagePort;
        replyPort.postMessage({ type: FIELD_SHELL_VERSION_MESSAGE, version: "2026-08-21.15" });
      }),
    } as unknown as ServiceWorker;

    await expect(
      queryFieldShellVersion({
        controller,
        messageChannelFactory: testMessageChannel,
      }),
    ).resolves.toBe("2026-08-21.15");
  });

  it("falla cerrado ante payload malformado, excepción o timeout", async () => {
    const malformed = {
      postMessage: vi.fn((_message: unknown, transfer: Transferable[]) => {
        const replyPort = transfer[0] as unknown as TestMessagePort;
        replyPort.postMessage({
          type: FIELD_SHELL_VERSION_MESSAGE,
          version: "https://dato-no-permitido.test/",
        });
      }),
    } as unknown as ServiceWorker;
    await expect(
      queryFieldShellVersion({ controller: malformed, messageChannelFactory: testMessageChannel }),
    ).resolves.toBeNull();

    const throwing = {
      postMessage: vi.fn(() => {
        throw new Error("detalle sensible que no debe propagarse");
      }),
    } as unknown as ServiceWorker;
    await expect(
      queryFieldShellVersion({ controller: throwing, messageChannelFactory: testMessageChannel }),
    ).resolves.toBeNull();

    vi.useFakeTimers();
    const silent = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const pending = queryFieldShellVersion({
      controller: silent,
      messageChannelFactory: testMessageChannel,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBeNull();
  });
});

describe("field-sw retirement worker", () => {
  it("retira exclusivamente sus caches, toma control para la transición y se desregistra", async () => {
    const source = readFileSync(resolve(process.cwd(), "public/field-sw.js"), "utf8");
    const listeners = new Map<string, (event: unknown) => void>();
    const deleteCache = vi.fn().mockResolvedValue(true);
    const postMessage = vi.fn();
    const unregister = vi.fn().mockResolvedValue(true);
    const workerScope = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      },
      clients: {
        claim: vi.fn().mockResolvedValue(undefined),
        matchAll: vi.fn().mockResolvedValue([{ postMessage }]),
      },
      registration: { unregister },
      skipWaiting: vi.fn().mockResolvedValue(undefined),
    };
    const cacheStorage = {
      delete: deleteCache,
      keys: vi
        .fn()
        .mockResolvedValue([
          "rutacuadrilla-field-shell-old",
          "unrelated-shell-cache",
          "rutacuadrilla-field-shell-newer",
        ]),
    };
    runInNewContext(source, { caches: cacheStorage, self: workerScope });

    let installCompletion: Promise<unknown> | undefined;
    listeners.get("install")?.({
      waitUntil(completion: Promise<unknown>) {
        installCompletion = completion;
      },
    });
    await installCompletion;

    let activateCompletion: Promise<unknown> | undefined;
    listeners.get("activate")?.({
      waitUntil(completion: Promise<unknown>) {
        activateCompletion = completion;
      },
    });
    await activateCompletion;

    expect(workerScope.skipWaiting).toHaveBeenCalledOnce();
    expect(deleteCache.mock.calls).toEqual([
      ["rutacuadrilla-field-shell-old"],
      ["rutacuadrilla-field-shell-newer"],
    ]);
    expect(workerScope.clients.claim).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(workerScope.clients.matchAll).toHaveBeenCalledWith({
      includeUncontrolled: true,
      type: "window",
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "RUTACUADRILLA_FIELD_WORKER_RETIRED",
    });
    expect(listeners.has("fetch")).toBe(false);
    expect(source).not.toMatch(/indexedDB\s*\.|storage\s*\.\s*getDirectory/u);
  });

  it("no instala ningún protocolo de caché o navegación", () => {
    const source = readFileSync(resolve(process.cwd(), "public/field-sw.js"), "utf8");
    const listeners = new Map<string, (event: unknown) => void>();
    runInNewContext(source, {
      caches: {},
      self: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          listeners.set(type, listener);
        },
        clients: {},
        registration: {},
        skipWaiting: vi.fn(),
      },
    });

    expect([...listeners.keys()].sort()).toEqual(["activate", "install"]);
    expect(source).not.toMatch(/respondWith\s*\(/u);
  });
});
