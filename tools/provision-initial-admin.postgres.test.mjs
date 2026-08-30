import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  closeDatabase,
  createPostgresDatabase,
  migrateDatabase,
  verifyPassword,
} from "@rutacuadrilla/domain";
import { runProvision } from "./provision-initial-admin.mjs";

const databaseUrl = process.env.RUTACUADRILLA_TEST_POSTGRES_URL?.trim();
const adminPassword = "Postgres-Smoke-Admin-2026!";

function assertDisposableLocalDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "PostgreSQL smoke test requires a PostgreSQL URL",
  );
  assert.equal(parsed.search, "", "PostgreSQL smoke test rejects connection query overrides");
  assert.equal(parsed.hash, "", "PostgreSQL smoke test rejects URL fragments");
  assert.ok(
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost",
    "PostgreSQL smoke test only accepts a local disposable server",
  );
  assert.equal(
    parsed.pathname,
    "/rutacuadrilla_test",
    "PostgreSQL smoke test requires the dedicated rutacuadrilla_test database",
  );
}

test("PostgreSQL smoke guard rejects remote or non-test databases", () => {
  assert.throws(
    () =>
      assertDisposableLocalDatabase(
        "postgresql://rutacuadrilla:test@database.example/rutacuadrilla_test",
      ),
    /only accepts a local disposable server/u,
  );
  assert.throws(
    () => assertDisposableLocalDatabase("postgresql://rutacuadrilla:test@127.0.0.1/production"),
    /requires the dedicated rutacuadrilla_test database/u,
  );
  assert.throws(
    () =>
      assertDisposableLocalDatabase(
        "postgresql://rutacuadrilla:test@127.0.0.1/rutacuadrilla_test?host=database.example",
      ),
    /rejects connection query overrides/u,
  );
  assert.throws(
    () =>
      assertDisposableLocalDatabase(
        "postgresql://rutacuadrilla:test@127.0.0.1/rutacuadrilla_test#unexpected",
      ),
    /rejects URL fragments/u,
  );
});

test("migrates and provisions a disposable PostgreSQL 18 database", {
  skip: databaseUrl ? false : "RUTACUADRILLA_TEST_POSTGRES_URL is not configured",
}, async (context) => {
  if (!databaseUrl) return;
  assertDisposableLocalDatabase(databaseUrl);

  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-postgres-smoke-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const passwordFile = resolve(directory, "initial-admin-password");
  await writeFile(passwordFile, `${adminPassword}\n`, { mode: 0o600 });
  const options = {
    crewName: "Cuadrilla CI",
    crewSlug: "cuadrilla-ci",
    databaseUrl,
    displayName: "Administración CI",
    email: "admin@ci.example",
    passwordFile,
  };

  const migrationDatabase = createPostgresDatabase({
    applicationName: "rutacuadrilla-provision-smoke-migration",
    connectionString: databaseUrl,
    maxConnections: 1,
  });
  try {
    await migrateDatabase(migrationDatabase);
  } finally {
    await closeDatabase(migrationDatabase);
  }

  const concurrentResults = await Promise.all([runProvision(options), runProvision(options)]);
  assert.deepEqual(concurrentResults.map((result) => result.status).sort(), [
    "ALREADY_PROVISIONED",
    "PROVISIONED",
  ]);
  assert.deepEqual(await runProvision(options), {
    capabilityCount: 17,
    status: "ALREADY_PROVISIONED",
  });

  const database = createPostgresDatabase({
    applicationName: "rutacuadrilla-provision-smoke-verification",
    connectionString: databaseUrl,
    maxConnections: 1,
  });
  try {
    const result = await database.query(
      `SELECT u.email, u.password_hash, c.slug AS crew_slug,
                count(mc.capability_code)::int AS capability_count
         FROM app_user AS u
         JOIN crew_membership AS m ON m.user_id = u.id
         JOIN crew AS c ON c.id = m.crew_id
         LEFT JOIN membership_capability AS mc
           ON mc.crew_id = m.crew_id AND mc.membership_id = m.id
         GROUP BY u.id, c.id`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].email, options.email);
    assert.equal(result.rows[0].crew_slug, options.crewSlug);
    assert.equal(result.rows[0].capability_count, 17);
    assert.equal(await verifyPassword(adminPassword, result.rows[0].password_hash), true);
  } finally {
    await closeDatabase(database);
  }
});
