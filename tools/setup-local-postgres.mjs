import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDir = join(workspaceRoot, ".local");
const runtimeConfigPath = join(localDir, "postgres-runtime.json");
const savedRuntime = existsSync(runtimeConfigPath)
  ? JSON.parse(readFileSync(runtimeConfigPath, "utf8"))
  : undefined;
const runtimeHome = resolve(
  process.env.RUTACUADRILLA_POSTGRES_HOME ??
    savedRuntime?.runtimeHome ??
    join(localDir, "postgresql-18"),
);
const dataDir = resolve(
  process.env.RUTACUADRILLA_POSTGRES_DATA ?? savedRuntime?.dataDir ?? join(runtimeHome, "data"),
);
const port = Number(process.env.RUTACUADRILLA_POSTGRES_PORT ?? savedRuntime?.port ?? "55432");
const username = "rutacuadrilla";
const databaseName = "rutacuadrilla";
const binDir = join(runtimeHome, "bin");
const envPath = join(workspaceRoot, ".env");
const credentialsPath = join(localDir, "credenciales-locales.txt");

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("RUTACUADRILLA_POSTGRES_PORT debe ser un puerto válido desde 1024.");
}

const executables = {
  createdb: join(binDir, "createdb.exe"),
  initdb: join(binDir, "initdb.exe"),
  pgCtl: join(binDir, "pg_ctl.exe"),
  psql: join(binDir, "psql.exe"),
};
for (const [name, executable] of Object.entries(executables)) {
  if (!existsSync(executable)) {
    throw new Error(`No se encontró ${name} en ${runtimeHome}.`);
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "sin detalle").trim();
    throw new Error(`${executable} terminó con error: ${detail}`);
  }
  return result.stdout.trim();
}

function parseEnvironment(content) {
  return new Map(
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

await mkdir(localDir, { recursive: true });

let databasePassword;
let sessionSecret;
let adminPassword;
let memberPassword;
let outsiderPassword;
if (existsSync(envPath)) {
  const environment = parseEnvironment(await readFile(envPath, "utf8"));
  const databaseUrl = environment.get("DATABASE_URL");
  if (!databaseUrl) throw new Error("El .env existente no contiene DATABASE_URL.");
  const parsedUrl = new URL(databaseUrl);
  databasePassword = decodeURIComponent(parsedUrl.password);
  sessionSecret = environment.get("SESSION_SECRET");
  adminPassword = environment.get("DEMO_ADMIN_PASSWORD");
  memberPassword = environment.get("DEMO_MEMBER_PASSWORD");
  outsiderPassword = environment.get("DEMO_OUTSIDER_PASSWORD");
  if (
    !databasePassword ||
    !sessionSecret ||
    !adminPassword ||
    !memberPassword ||
    !outsiderPassword
  ) {
    throw new Error("El .env existente no contiene todas las credenciales locales requeridas.");
  }
} else {
  databasePassword = randomBytes(30).toString("base64url");
  sessionSecret = randomBytes(48).toString("base64url");
  adminPassword = `Admin-${randomBytes(18).toString("base64url")}!`;
  memberPassword = `Campo-${randomBytes(18).toString("base64url")}!`;
  outsiderPassword = `Externo-${randomBytes(18).toString("base64url")}!`;
}

if (!existsSync(join(dataDir, "PG_VERSION"))) {
  await mkdir(dataDir, { recursive: true });
  const passwordFile = join(runtimeHome, `.init-password-${randomUUID()}.tmp`);
  await writeFile(passwordFile, `${databasePassword}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    run(executables.initdb, [
      "--pgdata",
      dataDir,
      "--username",
      username,
      "--encoding",
      "UTF8",
      "--locale",
      "C",
      "--auth-local",
      "scram-sha-256",
      "--auth-host",
      "scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
  } finally {
    if (existsSync(passwordFile)) await unlink(passwordFile);
  }
}

const status = spawnSync(executables.pgCtl, ["status", "--pgdata", dataDir], {
  encoding: "utf8",
  windowsHide: true,
});
if (status.status !== 0) {
  const started = spawnSync(
    executables.pgCtl,
    [
      "start",
      "--pgdata",
      dataDir,
      "--log",
      join(runtimeHome, "postgres.log"),
      "--options",
      `-p ${port} -h 127.0.0.1`,
      "--wait",
      "--timeout",
      "30",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  if (started.status !== 0) {
    throw new Error("PostgreSQL no pudo iniciar dentro del plazo esperado.");
  }
}

const postgresEnvironment = { ...process.env, PGPASSWORD: databasePassword };
const exists = run(
  executables.psql,
  [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--username",
    username,
    "--dbname",
    "postgres",
    "--tuples-only",
    "--no-align",
    "--command",
    `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`,
  ],
  { env: postgresEnvironment },
);
if (exists !== "1") {
  run(
    executables.createdb,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      username,
      "--encoding",
      "UTF8",
      databaseName,
    ],
    { env: postgresEnvironment },
  );
}

if (!existsSync(envPath)) {
  const databaseUrl = `postgresql://${username}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${databaseName}`;
  await writeFile(
    envPath,
    [
      "NODE_ENV=development",
      "APP_PROFILE=simple",
      "API_HOST=127.0.0.1",
      "API_PORT=4310",
      "TRUST_PROXY=0",
      `DATABASE_URL=${databaseUrl}`,
      `SESSION_SECRET=${sessionSecret}`,
      "SESSION_TTL_MINUTES=480",
      "CORS_ORIGIN=http://127.0.0.1:4311,http://localhost:4311,http://127.0.0.1:4312,http://localhost:4312",
      "VITE_API_URL=",
      "VITE_MAP_STYLE_URL=",
      "VITE_DEMO_MODE=false",
      `DEMO_ADMIN_PASSWORD=${adminPassword}`,
      `DEMO_MEMBER_PASSWORD=${memberPassword}`,
      `DEMO_OUTSIDER_PASSWORD=${outsiderPassword}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

await writeFile(
  runtimeConfigPath,
  `${JSON.stringify({ dataDir, port, runtimeHome }, null, 2)}\n`,
  "utf8",
);
await writeFile(
  credentialsPath,
  [
    "RutaCuadrilla local",
    "",
    "Administración: http://127.0.0.1:4311/",
    "Correo: admin@demo.rutacuadrilla.local",
    `Contraseña: ${adminPassword}`,
    "",
    "Campo: http://127.0.0.1:4312/",
    "Correo: miembro@demo.rutacuadrilla.local",
    `Contraseña: ${memberPassword}`,
    "",
  ].join("\n"),
  { encoding: "utf8", mode: 0o600 },
);

console.log(`PostgreSQL local listo en 127.0.0.1:${port}.`);
console.log(`Credenciales guardadas en ${credentialsPath}.`);
