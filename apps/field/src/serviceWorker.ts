export const FIELD_SERVICE_WORKER_URL = "/field-sw.js";
export const FIELD_SERVICE_WORKER_SCOPE = "/";
export const FIELD_SHELL_READY_EVENT = "rutacuadrilla:field-shell-ready";
export const FIELD_UPDATE_AVAILABLE_EVENT = "rutacuadrilla:field-update-available";
export const FIELD_SHELL_VERSION_MESSAGE = "RUTACUADRILLA_FIELD_SHELL_VERSION";

const ACTIVATE_UPDATE_MESSAGE = "RUTACUADRILLA_ACTIVATE_FIELD_UPDATE";
const SHELL_READY_MESSAGE = "RUTACUADRILLA_FIELD_SHELL_READY";
const DEFAULT_SHELL_VERSION_TIMEOUT_MS = 1_500;
const SAFE_SHELL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u;

export interface FieldServiceWorkerOptions {
  /** Permite probar el registro; en la aplicación real solo se habilita al compilar. */
  enabled?: boolean;
}

interface FieldShellMessage {
  type?: unknown;
  version?: unknown;
}

export interface FieldShellVersionQueryOptions {
  controller?: ServiceWorker | null;
  messageChannelFactory?: () => MessageChannel;
  timeoutMs?: number;
}

function shellVersionFromMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const message = value as FieldShellMessage;
  if (
    message.type !== FIELD_SHELL_VERSION_MESSAGE ||
    typeof message.version !== "string" ||
    !SAFE_SHELL_VERSION.test(message.version)
  ) {
    return null;
  }
  return message.version;
}

/**
 * Consulta al worker que controla esta pestaña. Una ausencia, excepción,
 * respuesta malformada o timeout se representa como `null` para que el
 * diagnóstico de piloto pueda fallar de forma cerrada sin filtrar detalles.
 */
export function queryFieldShellVersion(
  options: FieldShellVersionQueryOptions = {},
): Promise<string | null> {
  let controller: ServiceWorker | null;
  try {
    controller =
      options.controller === undefined
        ? (navigator.serviceWorker?.controller ?? null)
        : options.controller;
  } catch {
    return Promise.resolve(null);
  }
  if (!controller) return Promise.resolve(null);

  let channel: MessageChannel;
  try {
    channel = (options.messageChannelFactory ?? (() => new MessageChannel()))();
  } catch {
    return Promise.resolve(null);
  }

  const requestedTimeout = options.timeoutMs ?? DEFAULT_SHELL_VERSION_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(Math.trunc(requestedTimeout), 10_000)
      : DEFAULT_SHELL_VERSION_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(version);
    };
    const timeout = window.setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      finish(shellVersionFromMessage(event.data));
    };

    try {
      controller.postMessage({ type: FIELD_SHELL_VERSION_MESSAGE }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(null);
    }
  });
}

function dispatchFieldEvent<T>(name: string, detail: T): void {
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

function announceUpdate(registration: ServiceWorkerRegistration): void {
  console.info(
    "RutaCuadrilla Campo: hay una actualización lista. Se aplicará al cerrar las pestañas o al aceptar la actualización.",
  );
  dispatchFieldEvent(FIELD_UPDATE_AVAILABLE_EVENT, { registration });
}

function observeRegistration(registration: ServiceWorkerRegistration): void {
  if (registration.waiting) announceUpdate(registration);

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        announceUpdate(registration);
      }
    });
  });
}

async function registerNow(): Promise<ServiceWorkerRegistration | null> {
  try {
    const registration = await navigator.serviceWorker.register(FIELD_SERVICE_WORKER_URL, {
      scope: FIELD_SERVICE_WORKER_SCOPE,
      updateViaCache: "none",
    });
    observeRegistration(registration);
    return registration;
  } catch (error) {
    console.warn("RutaCuadrilla Campo: no fue posible preparar el acceso sin conexión.", error);
    return null;
  }
}

/**
 * Registra el shell una vez finalizada la carga. El service worker se omite en
 * desarrollo para no interferir con HMR ni servir módulos antiguos.
 */
export function registerFieldServiceWorker(
  options: FieldServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const enabled = options.enabled ?? import.meta.env.PROD;
  if (!enabled || !("serviceWorker" in navigator)) return Promise.resolve(null);

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<FieldShellMessage>) => {
    if (event.data?.type !== SHELL_READY_MESSAGE) return;

    const version = typeof event.data.version === "string" ? event.data.version : "desconocida";
    console.info(`RutaCuadrilla Campo: shell sin conexión listo (versión ${version}).`);
    dispatchFieldEvent(FIELD_SHELL_READY_EVENT, { version });
  });

  if (document.readyState === "complete") return registerNow();

  return new Promise((resolve) => {
    window.addEventListener(
      "load",
      () => {
        void registerNow().then(resolve);
      },
      { once: true },
    );
  });
}

/**
 * Activa una versión que está esperando. La recarga queda en manos del UI para
 * no perder una operación de terreno que todavía no se haya persistido.
 */
export function activateFieldServiceWorkerUpdate(registration: ServiceWorkerRegistration): boolean {
  if (!registration.waiting) return false;
  registration.waiting.postMessage({ type: ACTIVATE_UPDATE_MESSAGE });
  return true;
}
