import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createH40DelayProxy } from "./h40-sync-delay-proxy.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("retrasa una sola respuesta de sync después de aplicarla upstream", async () => {
  let applied = 0;
  const upstream = http.createServer((request, response) => {
    if (request.method === "POST" && request.url?.endsWith("/sync/commands")) applied += 1;
    response.writeHead(200, {
      "access-control-allow-origin": "http://127.0.0.1:4312",
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ applied }));
  });
  const upstreamAddress = await listen(upstream);
  assert.equal(typeof upstreamAddress, "object");

  const proxy = createH40DelayProxy({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  });
  const proxyAddress = await proxy.listen();
  assert.equal(typeof proxyAddress, "object");

  try {
    proxy.arm(120);
    const startedAt = performance.now();
    const delayed = fetch(`http://127.0.0.1:${proxyAddress.port}/api/crews/crew-a/sync/commands`, {
      body: "{}",
      method: "POST",
    });
    for (let attempt = 0; applied === 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(applied, 1, "el upstream ya debe haber aplicado la petición");
    const delayedResponse = await delayed;
    assert.ok(performance.now() - startedAt >= 100);
    assert.equal(
      delayedResponse.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:4312",
    );

    const immediateStartedAt = performance.now();
    const immediate = await fetch(
      `http://127.0.0.1:${proxyAddress.port}/api/crews/crew-a/sync/commands`,
      { body: "{}", method: "POST" },
    );
    assert.equal(immediate.status, 200);
    assert.ok(performance.now() - immediateStartedAt < 1_000);
    assert.equal(applied, 2);
    assert.deepEqual(proxy.status(), { armed: false, delayMs: null });
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("rechaza rutas ajenas a la API y configuración no loopback", async () => {
  assert.throws(
    () => createH40DelayProxy({ upstreamUrl: "https://example.com" }),
    /H40_PROXY_UPSTREAM_MUST_BE_LOOPBACK_HTTP/,
  );
  assert.throws(() => createH40DelayProxy({ host: "0.0.0.0" }), /H40_PROXY_MUST_BIND_LOOPBACK/);

  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamAddress = await listen(upstream);
  assert.equal(typeof upstreamAddress, "object");
  const proxy = createH40DelayProxy({
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
  });
  const proxyAddress = await proxy.listen();
  assert.equal(typeof proxyAddress, "object");
  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/not-api`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { code: "H40_PROXY_API_PATH_REQUIRED" });
  } finally {
    await proxy.close();
    await close(upstream);
  }
});
