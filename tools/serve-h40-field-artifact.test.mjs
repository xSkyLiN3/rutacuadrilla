import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createH40ArtifactServer } from "./serve-h40-field-artifact.mjs";

let directory;
let origin;
let server;

before(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "rutacuadrilla-h40-static-"));
  await mkdir(resolve(directory, "assets"));
  await writeFile(resolve(directory, "index.html"), "<!doctype html><main>Campo H40</main>");
  await writeFile(resolve(directory, "field-sw.js"), "self.addEventListener('fetch',()=>{});\n");
  await writeFile(resolve(directory, "assets", "app.js"), "export const ready = true;\n");
  await writeFile(resolve(directory, "assets", "sqlite.wasm"), new Uint8Array([0, 97, 115, 109]));
  server = await createH40ArtifactServer({ directory, port: 0 });
  const address = await server.listen();
  assert.equal(typeof address, "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
  await rm(directory, { force: true, recursive: true });
});

test("sirve shell, assets y fallback SPA con aislamiento y MIME correctos", async () => {
  const shell = await fetch(`${origin}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Campo H40/);
  assert.equal(shell.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(shell.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(shell.headers.get("cache-control"), "no-cache");

  const script = await fetch(`${origin}/assets/app.js`);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(script.headers.get("cache-control"), /immutable/);

  const wasm = await fetch(`${origin}/assets/sqlite.wasm`, { method: "HEAD" });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.equal((await wasm.arrayBuffer()).byteLength, 0);

  const navigation = await fetch(`${origin}/ruta/campo`, { headers: { accept: "text/html" } });
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /Campo H40/);
});

test("rechaza métodos, paths ausentes y cualquier bind no loopback", async () => {
  assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${origin}/`, { method: "POST" })).status, 405);
  await assert.rejects(
    createH40ArtifactServer({ directory, host: "0.0.0.0", port: 0 }),
    /H40_ARTIFACT_SERVER_MUST_BIND_LOOPBACK/,
  );
  await assert.rejects(
    createH40ArtifactServer({ directory: "relative", port: 0 }),
    /H40_ARTIFACT_DIRECTORY_MUST_BE_ABSOLUTE/,
  );
});
