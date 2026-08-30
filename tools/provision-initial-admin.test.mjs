import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  closeDatabase,
  createDatabase,
  hashPassword,
  migrateDatabase,
  verifyPassword,
} from "@rutacuadrilla/domain";
import {
  openProvisionDatabase,
  provisionInitialAdmin,
  readProvisionPassword,
  resolveProvisionOptions,
  runProvision,
} from "./provision-initial-admin.mjs";

const firstPassword = "Pilot-Admin-Password-2026!";
const secondPassword = "Different-Pilot-Password-2026!";
const execFileAsync = promisify(execFile);

function baseOptions(directory, passwordFile) {
  return {
    crewName: "Cuadrilla Piloto Norte",
    crewSlug: "piloto-norte",
    databaseDir: resolve(directory, "database"),
    displayName: "Administración Piloto",
    email: "admin@piloto.example",
    passwordFile,
  };
}

test("provisions one ADMIN with every capability and replays without changing its password", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  await writeFile(passwordFile, `${firstPassword}\n`, { mode: 0o600 });
  const options = baseOptions(directory, passwordFile);

  const created = await runProvision(options);
  assert.deepEqual(created, { capabilityCount: 17, status: "PROVISIONED" });

  let database = await createDatabase({ dataDir: options.databaseDir });
  const initial = await database.query(
    `SELECT u.email, u.display_name, u.password_hash,
            c.name AS crew_name, c.slug AS crew_slug,
            m.role, m.profile, m.status,
            count(mc.capability_code)::int AS capability_count
     FROM app_user u
     JOIN crew_membership m ON m.user_id = u.id
     JOIN crew c ON c.id = m.crew_id
     LEFT JOIN membership_capability mc
       ON mc.crew_id = m.crew_id AND mc.membership_id = m.id
     GROUP BY u.id, c.id, m.crew_id, m.id`,
  );
  const row = initial.rows[0];
  assert.deepEqual(
    { ...row, password_hash: undefined },
    {
      capability_count: 17,
      crew_name: options.crewName,
      crew_slug: options.crewSlug,
      display_name: options.displayName,
      email: options.email,
      password_hash: undefined,
      profile: "OTHER",
      role: "ADMIN",
      status: "ACTIVE",
    },
  );
  assert.equal(await verifyPassword(firstPassword, row.password_hash), true);
  const initialHash = row.password_hash;
  assert.equal(
    (await database.query("SELECT count(*)::int AS count FROM app_user")).rows[0].count,
    1,
  );
  await closeDatabase(database);

  const replay = await runProvision(options);
  assert.deepEqual(replay, { capabilityCount: 17, status: "ALREADY_PROVISIONED" });

  await writeFile(passwordFile, secondPassword, { mode: 0o600 });
  await assert.rejects(runProvision(options), /INITIAL_ADMIN_STATE_CONFLICT/u);
  database = await createDatabase({ dataDir: options.databaseDir });
  const afterConflict = await database.query(
    "SELECT password_hash FROM app_user WHERE lower(email) = lower($1)",
    [options.email],
  );
  assert.equal(afterConflict.rows[0].password_hash, initialHash);
  assert.equal(await verifyPassword(secondPassword, afterConflict.rows[0].password_hash), false);
  await closeDatabase(database);
});

test("rejects partial state atomically instead of completing it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-partial-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  await writeFile(passwordFile, firstPassword, { mode: 0o600 });
  const options = baseOptions(directory, passwordFile);
  const database = await createDatabase({ dataDir: options.databaseDir });
  await migrateDatabase(database);
  await database.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, status)
     VALUES ('00000000-0000-4000-8000-000000000001', $1, $2, $3, 'ACTIVE')`,
    [options.email, options.displayName, await hashPassword(firstPassword)],
  );
  await closeDatabase(database);

  await assert.rejects(runProvision(options), /INITIAL_ADMIN_STATE_PARTIAL/u);
  const inspected = await createDatabase({ dataDir: options.databaseDir });
  const counts = await inspected.query(
    `SELECT
       (SELECT count(*)::int FROM app_user) AS users,
       (SELECT count(*)::int FROM crew) AS crews,
       (SELECT count(*)::int FROM crew_membership) AS memberships,
       (SELECT count(*)::int FROM membership_capability) AS grants`,
  );
  assert.deepEqual(counts.rows[0], { crews: 0, grants: 0, memberships: 0, users: 1 });
  await closeDatabase(inspected);
});

test("rejects a second bootstrap identity when unrelated tenant state already exists", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-existing-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  await writeFile(passwordFile, firstPassword, { mode: 0o600 });
  const options = baseOptions(directory, passwordFile);
  const database = await createDatabase({ dataDir: options.databaseDir });
  await migrateDatabase(database);
  await database.query(
    `INSERT INTO app_user (id, email, display_name, password_hash, status)
     VALUES ('00000000-0000-4000-8000-000000000011',
             'existing@example.com', 'Existing Admin', $1, 'ACTIVE')`,
    [await hashPassword(firstPassword)],
  );
  await database.query(
    `INSERT INTO crew (id, name, slug, status)
     VALUES ('00000000-0000-4000-8000-000000000012',
             'Existing Crew', 'existing-crew', 'ACTIVE')`,
  );
  await database.query(
    `INSERT INTO crew_membership (crew_id, id, user_id, role, profile, status)
     VALUES ('00000000-0000-4000-8000-000000000012',
             '00000000-0000-4000-8000-000000000013',
             '00000000-0000-4000-8000-000000000011',
             'ADMIN', 'OTHER', 'ACTIVE')`,
  );
  await database.query(
    `INSERT INTO membership_capability
       (crew_id, membership_id, capability_code, granted_by_membership_id)
     VALUES ('00000000-0000-4000-8000-000000000012',
             '00000000-0000-4000-8000-000000000013',
             'ROUTE_VIEW',
             '00000000-0000-4000-8000-000000000013')`,
  );
  await closeDatabase(database);

  await assert.rejects(runProvision(options), /INITIAL_ADMIN_STATE_CONFLICT/u);
  const inspected = await createDatabase({ dataDir: options.databaseDir });
  const counts = await inspected.query(
    `SELECT
       (SELECT count(*)::int FROM app_user) AS users,
       (SELECT count(*)::int FROM crew) AS crews,
       (SELECT count(*)::int FROM crew_membership) AS memberships,
       (SELECT count(*)::int FROM membership_capability) AS grants`,
  );
  assert.deepEqual(counts.rows[0], { crews: 1, grants: 1, memberships: 1, users: 1 });
  assert.equal(
    (
      await inspected.query("SELECT count(*)::int AS count FROM app_user WHERE email = $1", [
        options.email,
      ])
    ).rows[0].count,
    0,
  );
  await closeDatabase(inspected);
});

test("rejects a capability catalog that differs from the application contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-catalog-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  await writeFile(passwordFile, firstPassword, { mode: 0o600 });
  const options = baseOptions(directory, passwordFile);
  const database = await createDatabase({ dataDir: options.databaseDir });
  await migrateDatabase(database);
  await database.query(
    "INSERT INTO capability (code, description) VALUES ('UNRECOGNIZED_CAPABILITY', 'Test only')",
  );
  await closeDatabase(database);

  await assert.rejects(runProvision(options), /INITIAL_ADMIN_CAPABILITY_CATALOG_MISMATCH/u);
  const inspected = await createDatabase({ dataDir: options.databaseDir });
  assert.equal(
    (await inspected.query("SELECT count(*)::int AS count FROM app_user")).rows[0].count,
    0,
  );
  await closeDatabase(inspected);
});

test("serializes concurrent bootstrap attempts in PGlite", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-concurrent-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const database = await createDatabase({ dataDir: resolve(directory, "database") });
  context.after(async () => closeDatabase(database));
  await migrateDatabase(database);
  const input = {
    crewName: "Cuadrilla Concurrente",
    crewSlug: "cuadrilla-concurrente",
    displayName: "Administración Concurrente",
    email: "admin-concurrente@pilot.example",
    password: firstPassword,
  };

  const results = await Promise.all([
    provisionInitialAdmin(database, input),
    provisionInitialAdmin(database, input),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "ALREADY_PROVISIONED",
    "PROVISIONED",
  ]);
  assert.equal(
    (await database.query("SELECT count(*)::int AS count FROM app_user")).rows[0].count,
    1,
  );
});

test("removes one final line terminator without trimming meaningful password whitespace", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-password-file-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  const password = "  Exact Password 2026!  ";
  await writeFile(passwordFile, `${password}\r\n`, { mode: 0o600 });
  assert.equal(await readProvisionPassword(passwordFile), password);

  await writeFile(passwordFile, `${password}\n\n`, { mode: 0o600 });
  await assert.rejects(readProvisionPassword(passwordFile), /INITIAL_ADMIN_PASSWORD_INVALID/u);
  await writeFile(passwordFile, "                \n", { mode: 0o600 });
  await assert.rejects(readProvisionPassword(passwordFile), /INITIAL_ADMIN_PASSWORD_INVALID/u);

  const maximumPassword = "A".repeat(256);
  await writeFile(passwordFile, maximumPassword, { mode: 0o600 });
  assert.equal(await readProvisionPassword(passwordFile), maximumPassword);
  await writeFile(passwordFile, "A".repeat(257), { mode: 0o600 });
  await assert.rejects(readProvisionPassword(passwordFile), /INITIAL_ADMIN_PASSWORD_INVALID/u);
});

test("accepts environment input but rejects relative database and password paths", () => {
  const environment = {
    RUTACUADRILLA_DATABASE_DIR: resolve("absolute-database"),
    RUTACUADRILLA_INITIAL_ADMIN_DISPLAY_NAME: "Admin Inicial",
    RUTACUADRILLA_INITIAL_ADMIN_EMAIL: "ADMIN@PILOT.EXAMPLE",
    RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE: resolve("absolute-password"),
    RUTACUADRILLA_INITIAL_CREW_NAME: "Cuadrilla Inicial",
    RUTACUADRILLA_INITIAL_CREW_SLUG: "cuadrilla-inicial",
  };
  const parsed = resolveProvisionOptions([], environment);
  assert.equal(parsed.email, "admin@pilot.example");
  assert.equal(parsed.databaseDir, environment.RUTACUADRILLA_DATABASE_DIR);

  assert.throws(
    () =>
      resolveProvisionOptions([], {
        ...environment,
        RUTACUADRILLA_INITIAL_ADMIN_EMAIL: "a@b..com",
      }),
    /INITIAL_ADMIN_EMAIL_INVALID/u,
  );

  assert.throws(
    () => resolveProvisionOptions(["--database-dir", "relative-database"], environment),
    /INITIAL_ADMIN_DATABASE_DIR_INVALID/u,
  );
  assert.throws(
    () => resolveProvisionOptions(["--password-file", "relative-password"], environment),
    /INITIAL_ADMIN_PASSWORD_FILE_INVALID/u,
  );
});

test("requires exactly one PGlite or PostgreSQL source", () => {
  const identityEnvironment = {
    RUTACUADRILLA_INITIAL_ADMIN_DISPLAY_NAME: "Admin Inicial",
    RUTACUADRILLA_INITIAL_ADMIN_EMAIL: "admin@pilot.example",
    RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE: resolve("absolute-password"),
    RUTACUADRILLA_INITIAL_CREW_NAME: "Cuadrilla Inicial",
    RUTACUADRILLA_INITIAL_CREW_SLUG: "cuadrilla-inicial",
  };
  assert.throws(
    () => resolveProvisionOptions([], identityEnvironment),
    /INITIAL_ADMIN_DATABASE_SOURCE_REQUIRED/u,
  );
  assert.throws(
    () =>
      resolveProvisionOptions([], {
        ...identityEnvironment,
        DATABASE_DIR: resolve("absolute-database"),
        DATABASE_URL: "postgresql://operator:secret@database/rutacuadrilla",
      }),
    /INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT/u,
  );
  assert.throws(
    () =>
      resolveProvisionOptions([], {
        ...identityEnvironment,
        DATABASE_URL: "postgresql://operator:secret@database/rutacuadrilla",
        RUTACUADRILLA_DATABASE_URL: "postgresql://operator:other@database/rutacuadrilla",
      }),
    /INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT/u,
  );
});

test("accepts a PostgreSQL URL or an absolute URL secret file", () => {
  const identityEnvironment = {
    RUTACUADRILLA_INITIAL_ADMIN_DISPLAY_NAME: "Admin Inicial",
    RUTACUADRILLA_INITIAL_ADMIN_EMAIL: "ADMIN@PILOT.EXAMPLE",
    RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE: resolve("absolute-password"),
    RUTACUADRILLA_INITIAL_CREW_NAME: "Cuadrilla Inicial",
    RUTACUADRILLA_INITIAL_CREW_SLUG: "cuadrilla-inicial",
  };
  const databaseUrl = "postgresql://operator:secret@database/rutacuadrilla";
  const parsedUrl = resolveProvisionOptions(["--database-url", databaseUrl], identityEnvironment);
  assert.equal(parsedUrl.databaseUrl, databaseUrl);
  assert.equal(parsedUrl.databaseDir, undefined);

  const databaseUrlFile = resolve("database-url-secret");
  const parsedFile = resolveProvisionOptions([], {
    ...identityEnvironment,
    DATABASE_URL_FILE: databaseUrlFile,
  });
  assert.equal(parsedFile.databaseUrlFile, databaseUrlFile);
  assert.equal(parsedFile.databaseUrl, undefined);

  assert.throws(
    () =>
      resolveProvisionOptions(["--database-url", "https://database.invalid"], identityEnvironment),
    /INITIAL_ADMIN_DATABASE_URL_INVALID/u,
  );
  assert.throws(
    () =>
      resolveProvisionOptions([], {
        ...identityEnvironment,
        DATABASE_URL_FILE: "relative-secret",
      }),
    /INITIAL_ADMIN_DATABASE_URL_FILE_INVALID/u,
  );
});

test("opens PostgreSQL with one connection and bounded waits from either source", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-postgres-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const databaseUrlFile = resolve(directory, "database-url");
  const databaseUrl = "postgresql://operator:secret@database/rutacuadrilla";
  await writeFile(databaseUrlFile, `${databaseUrl}\n`, { mode: 0o600 });

  const calls = [];
  const database = { kind: "postgres-test-double" };
  const dependencies = {
    createDatabase() {
      throw new Error("PGlite must not be opened for a PostgreSQL source");
    },
    createPostgresDatabase(options) {
      calls.push(options);
      return database;
    },
  };

  assert.equal(await openProvisionDatabase({ databaseUrl }, dependencies), database);
  assert.equal(await openProvisionDatabase({ databaseUrlFile }, dependencies), database);
  assert.deepEqual(calls, [
    {
      applicationName: "rutacuadrilla-initial-admin",
      connectionTimeoutMillis: 10_000,
      connectionString: databaseUrl,
      lockTimeoutMillis: 30_000,
      maxConnections: 1,
    },
    {
      applicationName: "rutacuadrilla-initial-admin",
      connectionTimeoutMillis: 10_000,
      connectionString: databaseUrl,
      lockTimeoutMillis: 30_000,
      maxConnections: 1,
    },
  ]);
});

test("CLI reads the secret from a file without printing it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-provision-cli-test-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-password");
  await writeFile(passwordFile, firstPassword, { mode: 0o600 });
  const databaseDir = resolve(directory, "database");
  const cliPath = resolve(import.meta.dirname, "provision-initial-admin.mjs");

  const result = await execFileAsync(process.execPath, [
    cliPath,
    "--database-dir",
    databaseDir,
    "--email",
    "cli-admin@pilot.example",
    "--display-name",
    "CLI Admin",
    "--crew-name",
    "CLI Crew",
    "--crew-slug",
    "cli-crew",
    "--password-file",
    passwordFile,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { capabilityCount: 17, status: "PROVISIONED" });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(firstPassword), false);
});
