/*
 * Worker transitorio de retirada para el shell offline histórico de Campo.
 * No intercepta solicitudes ni toca OPFS, IndexedDB u otros almacenamientos.
 */

const FIELD_SHELL_CACHE_PREFIX = "rutacuadrilla-field-shell-";
const RETIRED_MESSAGE = "RUTACUADRILLA_FIELD_WORKER_RETIRED";

async function retireLegacyFieldShell() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(FIELD_SHELL_CACHE_PREFIX))
      .map((cacheName) => caches.delete(cacheName)),
  );

  try {
    await self.clients.claim();
  } finally {
    await self.registration.unregister();
  }

  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage({ type: RETIRED_MESSAGE });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(retireLegacyFieldShell());
});
