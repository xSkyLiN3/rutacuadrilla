import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createDemoChildEnvironment,
  demoReadyMessage,
  ensureDemoEnvironment,
  validateDemoEnvironment,
  waitForHttp,
} from "./start-demo.mjs";

const demoEnvironment = {
  NODE_ENV: "development",
  APP_PROFILE: "simple",
  API_HOST: "127.0.0.1",
  API_PORT: "4310",
  TRUST_PROXY: "0",
  DATABASE_DIR: ".local/demo-db",
  SESSION_SECRET: "local-demo-only-session-secret-32-characters-minimum",
  SESSION_TTL_MINUTES: "480",
  CORS_ORIGIN:
    "http://127.0.0.1:4311,http://localhost:4311,http://127.0.0.1:4312,http://localhost:4312",
  VITE_API_URL: "",
  VITE_MAP_STYLE_URL: "",
  VITE_DEMO_MODE: "true",
  DEMO_ADMIN_PASSWORD: "LocalDemoAdmin-2026!",
  DEMO_MEMBER_PASSWORD: "LocalDemoField-2026!",
  DEMO_OUTSIDER_PASSWORD: "LocalDemoOutside-2026!",
};

function environmentText(environment = demoEnvironment) {
  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

async function temporaryProject() {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-demo-start-"));
  await writeFile(join(directory, ".env.demo.example"), environmentText(), "utf8");
  return directory;
}

describe("demo:start", () => {
  it("acepta únicamente el contrato localhost-only", () => {
    assert.deepEqual(validateDemoEnvironment(demoEnvironment), demoEnvironment);
    assert.throws(
      () =>
        validateDemoEnvironment({
          ...demoEnvironment,
          API_HOST: "0.0.0.0",
        }),
      /localhost-only/u,
    );
  });

  it("crea .env desde el ejemplo solo cuando falta", async (context) => {
    const directory = await temporaryProject();
    context.after(() => rm(directory, { force: true, recursive: true }));
    const result = await ensureDemoEnvironment(directory);
    assert.equal(result.created, true);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), environmentText());
  });

  it("conserva un .env demo que coincide exactamente", async (context) => {
    const directory = await temporaryProject();
    context.after(() => rm(directory, { force: true, recursive: true }));
    await writeFile(join(directory, ".env"), environmentText(), "utf8");
    const result = await ensureDemoEnvironment(directory);
    assert.equal(result.created, false);
  });

  it("no sobrescribe ni mezcla un .env arbitrario", async (context) => {
    const directory = await temporaryProject();
    context.after(() => rm(directory, { force: true, recursive: true }));
    const original = `${environmentText()}DATABASE_URL=postgresql://external.example/db\n`;
    await writeFile(join(directory, ".env"), original, "utf8");
    await assert.rejects(() => ensureDemoEnvironment(directory), /No se sobrescribió/u);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), original);
  });

  it("pasa solo variables del sistema y el entorno demo a los hijos", () => {
    const child = createDemoChildEnvironment(demoEnvironment, {
      PATH: "test-path",
      DATABASE_URL: "postgresql://external.example/db",
      UNRELATED_SECRET: "do-not-forward",
      VITE_API_URL: "https://external.example",
    });
    assert.equal(child.PATH, "test-path");
    assert.equal(child.DATABASE_URL, undefined);
    assert.equal(child.UNRELATED_SECRET, undefined);
    assert.equal(child.VITE_API_URL, "");
    assert.equal(child.RUTACUADRILLA_DEMO_ENV_ONLY, "1");
  });

  it("reintenta readiness y acepta una respuesta validada", async () => {
    let attempts = 0;
    const response = await waitForHttp("http://127.0.0.1:4310/ready", {
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("aún iniciando");
        return new Response('{"status":"ready"}', {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      intervalMs: 1,
      timeoutMs: 500,
      validate: async (current) => (await current.json()).status === "ready",
    });
    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
  });

  it("muestra solo las credenciales públicas necesarias", () => {
    const message = demoReadyMessage(demoEnvironment);
    assert.match(message, /DEMO LISTA/u);
    assert.match(message, /LocalDemoAdmin-2026!/u);
    assert.match(message, /LocalDemoField-2026!/u);
    assert.doesNotMatch(message, /SESSION_SECRET|LocalDemoOutside/u);
  });
});
