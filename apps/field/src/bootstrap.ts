const FIELD_SERVICE_WORKER_URL = "/field-sw.js";
const FIELD_SHELL_CACHE_PREFIX = "rutacuadrilla-field-shell-";
const RETIREMENT_RELOAD_MARKER = "rutacuadrilla:field-sw-retirement-reload";

interface FieldShellRetirementOptions {
  reload?: () => void;
}

interface FieldBootstrapOptions {
  loadMain?: () => Promise<unknown>;
  retireLegacyShell?: () => Promise<boolean>;
  renderError?: (error: unknown) => void;
}

function isFieldServiceWorker(worker: ServiceWorker | null | undefined): boolean {
  if (!worker) return false;
  try {
    const scriptUrl = new URL(worker.scriptURL);
    return (
      scriptUrl.origin === window.location.origin && scriptUrl.pathname === FIELD_SERVICE_WORKER_URL
    );
  } catch {
    return false;
  }
}

function registrationUsesFieldWorker(registration: ServiceWorkerRegistration): boolean {
  return [registration.active, registration.installing, registration.waiting].some(
    isFieldServiceWorker,
  );
}

/**
 * Retira el shell offline anterior antes de importar Campo. El alcance es
 * deliberadamente estrecho: solo la URL histórica del worker y sus cachés.
 * OPFS, IndexedDB y la outbox permanecen intactos.
 */
export async function retireLegacyFieldShell(
  options: FieldShellRetirementOptions = {},
): Promise<boolean> {
  const serviceWorkerSupported = "serviceWorker" in navigator;
  const hadFieldController =
    serviceWorkerSupported && isFieldServiceWorker(navigator.serviceWorker.controller);
  let cleanupFailed = false;
  if (serviceWorkerSupported) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const fieldRegistrations = registrations.filter(registrationUsesFieldWorker);
      const removed = await Promise.all(
        fieldRegistrations.map((registration) => registration.unregister()),
      );
      cleanupFailed = removed.some((registrationWasRemoved) => !registrationWasRemoved);
    } catch (error) {
      cleanupFailed = true;
      console.warn("RutaCuadrilla Campo: no fue posible desregistrar el shell anterior.", error);
    }
  }

  try {
    if ("caches" in globalThis) {
      const cacheNames = await globalThis.caches.keys();
      const removed = await Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith(FIELD_SHELL_CACHE_PREFIX))
          .map((cacheName) => globalThis.caches.delete(cacheName)),
      );
      cleanupFailed ||= removed.some((cacheWasRemoved) => !cacheWasRemoved);
    }
  } catch (error) {
    cleanupFailed = true;
    console.warn("RutaCuadrilla Campo: no fue posible retirar el cache de Campo anterior.", error);
  }

  if (cleanupFailed) {
    throw new Error(
      "FIELD_LEGACY_SHELL_RETIREMENT_FAILED: cierra todas las pestañas de Campo y recarga. OPFS, IndexedDB y la outbox no se borraron.",
    );
  }
  if (!hadFieldController) {
    sessionStorage.removeItem(RETIREMENT_RELOAD_MARKER);
    return false;
  }
  if (sessionStorage.getItem(RETIREMENT_RELOAD_MARKER) === "1") {
    throw new Error(
      "FIELD_LEGACY_SHELL_STILL_CONTROLS_PAGE: el shell anterior sigue activo tras una recarga. Cierra todas las pestañas de Campo; los datos locales no se borraron.",
    );
  }

  sessionStorage.setItem(RETIREMENT_RELOAD_MARKER, "1");
  (options.reload ?? (() => window.location.reload()))();
  return true;
}

function renderBootstrapError(caught: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;

  const main = document.createElement("main");
  main.className = "centered";
  const heading = document.createElement("h1");
  heading.textContent = "Actualización local bloqueada";
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent =
    caught instanceof Error ? caught.message : "No fue posible iniciar RutaCuadrilla Campo.";
  const detail = document.createElement("p");
  detail.textContent = "No se inició el almacenamiento y ningún dato local fue borrado.";
  main.append(heading, alert, detail);
  root.replaceChildren(main);
}

export async function bootstrapField(options: FieldBootstrapOptions = {}): Promise<void> {
  try {
    const retire = options.retireLegacyShell ?? retireLegacyFieldShell;
    if (await retire()) return;

    const loadMain =
      options.loadMain ??
      (async () => {
        const { mountField } = await import("./main");
        mountField();
      });
    await loadMain();
  } catch (error) {
    (options.renderError ?? renderBootstrapError)(error);
  }
}

if (import.meta.env.MODE !== "test") void bootstrapField();
