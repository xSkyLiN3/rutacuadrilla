import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const projectRoot = resolve(import.meta.dirname, "..");

export const DEMO_ENDPOINTS = Object.freeze({
  admin: "http://127.0.0.1:4311/",
  api: "http://127.0.0.1:4310/ready",
  field: "http://127.0.0.1:4312/",
});

const EXPECTED_DEMO_KEYS = Object.freeze([
  "NODE_ENV",
  "APP_PROFILE",
  "API_HOST",
  "API_PORT",
  "TRUST_PROXY",
  "DATABASE_DIR",
  "SESSION_SECRET",
  "SESSION_TTL_MINUTES",
  "CORS_ORIGIN",
  "VITE_API_URL",
  "VITE_MAP_STYLE_URL",
  "VITE_DEMO_MODE",
  "DEMO_ADMIN_PASSWORD",
  "DEMO_MEMBER_PASSWORD",
  "DEMO_OUTSIDER_PASSWORD",
]);

const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);

export class DemoInterruptedError extends Error {
  constructor(signal) {
    super(`Demostración detenida con ${signal}.`);
    this.name = "DemoInterruptedError";
  }
}

function isPathInside(parent, candidate) {
  const localPath = relative(parent, candidate);
  return localPath === "" || (!localPath.startsWith("..") && !isAbsolute(localPath));
}

export function validateDemoEnvironment(environment, root = projectRoot) {
  const keys = Object.keys(environment).sort();
  const expectedKeys = [...EXPECTED_DEMO_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      ".env.demo.example debe contener únicamente el contrato público de demostración.",
    );
  }

  const expectedOrigins = new Set([
    "http://127.0.0.1:4311",
    "http://localhost:4311",
    "http://127.0.0.1:4312",
    "http://localhost:4312",
  ]);
  const actualOrigins = new Set(environment.CORS_ORIGIN.split(",").map((value) => value.trim()));
  const databaseRoot = resolve(root, ".local");
  const databasePath = resolve(root, environment.DATABASE_DIR);
  const passwordValues = [
    environment.DEMO_ADMIN_PASSWORD,
    environment.DEMO_MEMBER_PASSWORD,
    environment.DEMO_OUTSIDER_PASSWORD,
  ];

  if (
    environment.NODE_ENV !== "development" ||
    environment.APP_PROFILE !== "simple" ||
    environment.API_HOST !== "127.0.0.1" ||
    environment.API_PORT !== "4310" ||
    environment.TRUST_PROXY !== "0" ||
    environment.DATABASE_DIR !== ".local/demo-db" ||
    !isPathInside(databaseRoot, databasePath) ||
    environment.SESSION_SECRET.length < 32 ||
    environment.SESSION_TTL_MINUTES !== "480" ||
    actualOrigins.size !== expectedOrigins.size ||
    [...expectedOrigins].some((origin) => !actualOrigins.has(origin)) ||
    environment.VITE_API_URL !== "" ||
    environment.VITE_MAP_STYLE_URL !== "" ||
    environment.VITE_DEMO_MODE !== "true" ||
    passwordValues.some(
      (password) =>
        password.length < 12 ||
        password.trim() !== password ||
        !password.toLocaleLowerCase("en").includes("demo"),
    )
  ) {
    throw new Error(
      ".env.demo.example dejó de ser una configuración localhost-only segura; no se inició nada.",
    );
  }

  return Object.freeze({ ...environment });
}

function assertMatchingEnvironment(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const sameKeys = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
  const sameValues = sameKeys && expectedKeys.every((key) => actual[key] === expected[key]);
  if (!sameValues) {
    throw new Error(
      "El .env existente no coincide exactamente con .env.demo.example. No se sobrescribió ni se inició ningún servicio; muévelo o ajústalo conscientemente antes de reintentar.",
    );
  }
}

export async function ensureDemoEnvironment(root = projectRoot) {
  const examplePath = resolve(root, ".env.demo.example");
  const environmentPath = resolve(root, ".env");
  const exampleText = await readFile(examplePath, "utf8");
  const expected = validateDemoEnvironment(parseEnv(exampleText), root);

  try {
    const existingText = await readFile(environmentPath, "utf8");
    assertMatchingEnvironment(parseEnv(existingText), expected);
    return { created: false, environment: expected };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await writeFile(environmentPath, exampleText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { created: true, environment: expected };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingText = await readFile(environmentPath, "utf8");
    assertMatchingEnvironment(parseEnv(existingText), expected);
    return { created: false, environment: expected };
  }
}

export function createDemoChildEnvironment(environment, inherited = process.env) {
  const childEnvironment = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && PASSTHROUGH_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      childEnvironment[key] = value;
    }
  }
  Object.assign(childEnvironment, environment, {
    RUTACUADRILLA_API_ORIGIN: "http://127.0.0.1:4310",
    RUTACUADRILLA_DEMO_ENV_ONLY: "1",
  });
  return childEnvironment;
}

function wait(milliseconds, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForHttp(
  url,
  {
    fetchImplementation = fetch,
    intervalMs = 200,
    signal,
    timeoutMs = 60_000,
    validate = (response) => response.ok,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const requestSignal = AbortSignal.timeout(
        Math.min(2_000, Math.max(1, deadline - Date.now())),
      );
      const response = await fetchImplementation(url, { cache: "no-store", signal: requestSignal });
      if (await validate(response)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs, signal);
  }
  throw new Error(
    `El servicio ${url} no quedó listo en ${timeoutMs / 1_000} s${lastError ? "." : ""}`,
  );
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function assertPortAvailable(host, port) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, resolvePromise);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `El puerto localhost ${port} ya está en uso. No se detuvo ningún proceso ajeno.`,
      );
    }
    throw error;
  } finally {
    if (server.listening) await closeServer(server);
  }
}

async function assertDemoPortsAvailable() {
  await Promise.all([4310, 4311, 4312].map((port) => assertPortAvailable("127.0.0.1", port)));
}

function outputWithPrefix(stream, label, write) {
  stream.setEncoding("utf8");
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line) write(`[${label}] ${line}`);
  });
  stream.on("end", () => {
    if (buffered) write(`[${label}] ${buffered}`);
  });
}

function spawnNode(script, argumentsList, { cwd = projectRoot, environment, label }) {
  const child = spawn(process.execPath, [script, ...argumentsList], {
    cwd,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (label) {
    outputWithPrefix(child.stdout, label, console.log);
    outputWithPrefix(child.stderr, label, console.error);
  }
  return child;
}

async function runNodeCommand(script, argumentsList, { cwd = projectRoot, environment, signal }) {
  signal?.throwIfAborted();
  const child = spawnNode(script, argumentsList, { cwd, environment });
  let standardOutput = "";
  let standardError = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    standardOutput = `${standardOutput}${chunk}`.slice(-16_000);
  });
  child.stderr.on("data", (chunk) => {
    standardError = `${standardError}${chunk}`.slice(-16_000);
  });

  return await new Promise((resolvePromise, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code, childSignal) => {
      signal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(signal.reason);
      } else if (code === 0) {
        resolvePromise({ standardError, standardOutput });
      } else {
        const details = standardError.trim() || standardOutput.trim();
        reject(
          new Error(
            `${basename(script)} terminó con ${childSignal ?? `código ${code}`}${details ? `: ${details}` : ""}`,
          ),
        );
      }
    });
  });
}

class ManagedProcesses {
  constructor() {
    this.children = new Map();
    this.stopping = false;
    this.failure = new Promise((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failure.catch(() => undefined);
  }

  start(name, script, argumentsList, options) {
    const child = spawnNode(script, argumentsList, { ...options, label: name });
    let resolveExit;
    const exited = new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    this.children.set(name, { child, exited });
    child.once("error", (error) => {
      resolveExit();
      if (!this.stopping)
        this.rejectFailure(new Error(`${name} no pudo iniciar: ${error.message}`));
    });
    child.once("exit", (code, childSignal) => {
      resolveExit();
      if (!this.stopping) {
        this.rejectFailure(
          new Error(`${name} se detuvo inesperadamente (${childSignal ?? `código ${code}`}).`),
        );
      }
    });
    return child;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    const entries = [...this.children.values()];
    for (const { child } of entries) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.race([Promise.all(entries.map(({ exited }) => exited)), wait(4_000)]);
    for (const { child } of entries) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.race([Promise.all(entries.map(({ exited }) => exited)), wait(1_000)]);
  }
}

async function startApi(root, environment) {
  const [domain, apiServerModule, apiConfigModule] = await Promise.all([
    import(pathToFileURL(resolve(root, "packages", "domain", "dist", "index.js"))),
    import(pathToFileURL(resolve(root, "apps", "api", "dist", "server.js"))),
    import(pathToFileURL(resolve(root, "apps", "api", "dist", "config.js"))),
  ]);
  const config = apiConfigModule.loadConfig({
    ...environment,
    DATABASE_DIR: resolve(root, environment.DATABASE_DIR),
  });
  const database = await domain.createDatabase({ dataDir: config.databaseDir });
  let server;
  try {
    await domain.migrateDatabase(database);
    await domain.seedDemoData(database, {
      adminPassword: environment.DEMO_ADMIN_PASSWORD,
      memberPassword: environment.DEMO_MEMBER_PASSWORD,
      outsiderPassword: environment.DEMO_OUTSIDER_PASSWORD,
    });
    server = await apiServerModule.buildServer({
      campaignService: new domain.CampaignService(database),
      config,
      database,
      routeService: new domain.RouteService(database),
      syncService: new domain.SyncService(database),
      workSessionService: new domain.WorkSessionService(database),
    });
    await server.listen({ host: config.apiHost, port: config.apiPort });
  } catch (error) {
    if (server) await server.close().catch(() => undefined);
    await domain.closeDatabase(database);
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await domain.closeDatabase(database);
    },
  };
}

export function demoReadyMessage(environment) {
  return [
    "",
    "DEMO LISTA · datos 100 % sintéticos",
    `Administración: ${DEMO_ENDPOINTS.admin}`,
    "  admin@demo.rutacuadrilla.local",
    `  ${environment.DEMO_ADMIN_PASSWORD}`,
    `Campo:          ${DEMO_ENDPOINTS.field}`,
    "  miembro@demo.rutacuadrilla.local",
    `  ${environment.DEMO_MEMBER_PASSWORD}`,
    `API readiness:  ${DEMO_ENDPOINTS.api}`,
    "Pulsa Ctrl+C para cerrar únicamente estos servicios.",
    "",
  ].join("\n");
}

async function run() {
  const abortController = new AbortController();
  let interruption;
  const interrupt = (signal) => {
    if (abortController.signal.aborted) return;
    interruption = signal;
    abortController.abort(new DemoInterruptedError(signal));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const managedProcesses = new ManagedProcesses();
  let api;
  let failed = false;
  try {
    const { created, environment } = await ensureDemoEnvironment(projectRoot);
    console.log(
      created
        ? "Se creó .env desde .env.demo.example (solo localhost y datos sintéticos)."
        : "Se validó el .env demo existente; no se modificó.",
    );
    await assertDemoPortsAvailable();
    const childEnvironment = createDemoChildEnvironment(environment);
    const typescriptCli = resolve(projectRoot, "node_modules", "typescript", "bin", "tsc");
    const viteCli = resolve(projectRoot, "node_modules", "vite", "bin", "vite.js");

    console.log("Validando dataset y compilando API…");
    await runNodeCommand(resolve(projectRoot, "tools", "generate-demo-route.mjs"), ["--check"], {
      environment: childEnvironment,
      signal: abortController.signal,
    });
    await runNodeCommand(
      typescriptCli,
      ["-p", resolve(projectRoot, "packages", "domain", "tsconfig.build.json")],
      { environment: childEnvironment, signal: abortController.signal },
    );
    await runNodeCommand(
      typescriptCli,
      ["-p", resolve(projectRoot, "apps", "api", "tsconfig.build.json")],
      { environment: childEnvironment, signal: abortController.signal },
    );

    abortController.signal.throwIfAborted();
    api = await startApi(projectRoot, environment);
    abortController.signal.throwIfAborted();
    managedProcesses.start("admin", viteCli, ["--mode", "demo"], {
      cwd: resolve(projectRoot, "apps", "admin"),
      environment: childEnvironment,
    });
    managedProcesses.start("campo", viteCli, ["--mode", "demo"], {
      cwd: resolve(projectRoot, "apps", "field"),
      environment: childEnvironment,
    });

    await Promise.race([
      Promise.all([
        waitForHttp(DEMO_ENDPOINTS.api, {
          signal: abortController.signal,
          validate: async (response) => response.ok && (await response.json()).status === "ready",
        }),
        waitForHttp(DEMO_ENDPOINTS.admin, { signal: abortController.signal }),
        waitForHttp(DEMO_ENDPOINTS.field, { signal: abortController.signal }),
      ]),
      managedProcesses.failure,
    ]);

    console.log("Servicios listos; importando la ruta sintética de forma idempotente…");
    const imported = await runNodeCommand(
      resolve(projectRoot, "tools", "import-demo-route.mjs"),
      ["--apply"],
      { environment: childEnvironment, signal: abortController.signal },
    );
    let importResult;
    try {
      importResult = JSON.parse(imported.standardOutput);
    } catch {
      throw new Error("El importador demo no devolvió su comprobante JSON.");
    }
    if (importResult.synthetic !== true || importResult.verified !== true) {
      throw new Error("El importador no confirmó una ruta sintética verificada.");
    }

    process.stdout.write(demoReadyMessage(environment));
    await Promise.race([
      managedProcesses.failure,
      new Promise((_, reject) => {
        if (abortController.signal.aborted) {
          reject(abortController.signal.reason);
          return;
        }
        abortController.signal.addEventListener(
          "abort",
          () => reject(abortController.signal.reason),
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    if (!(error instanceof DemoInterruptedError)) {
      failed = true;
      console.error(
        error instanceof Error ? `No se pudo iniciar la demo: ${error.message}` : error,
      );
    }
  } finally {
    if (interruption) console.log(`Cerrando la demo (${interruption})…`);
    await managedProcesses.stop();
    if (api) await api.close().catch((error) => console.error(`API: ${error.message}`));
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (interruption) console.log("Demo cerrada; no se tocaron otros procesos.");
    process.exitCode = failed ? 1 : 0;
  }
}

const launchedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (launchedDirectly) await run();
