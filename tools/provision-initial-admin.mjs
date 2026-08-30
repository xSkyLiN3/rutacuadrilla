import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountEmailSchema,
  capabilityCodes,
  closeDatabase,
  createDatabase,
  createPostgresDatabase,
  hashPassword,
  migrateDatabase,
  newAccountPasswordSchema,
  verifyPassword,
} from "@rutacuadrilla/domain";

const optionNames = [
  "database-dir",
  "database-url",
  "email",
  "display-name",
  "crew-name",
  "crew-slug",
  "password-file",
];

const environmentNames = {
  "crew-name": "RUTACUADRILLA_INITIAL_CREW_NAME",
  "crew-slug": "RUTACUADRILLA_INITIAL_CREW_SLUG",
  "display-name": "RUTACUADRILLA_INITIAL_ADMIN_DISPLAY_NAME",
  email: "RUTACUADRILLA_INITIAL_ADMIN_EMAIL",
  "password-file": "RUTACUADRILLA_INITIAL_ADMIN_PASSWORD_FILE",
};

const databaseEnvironmentNames = {
  directory: ["RUTACUADRILLA_DATABASE_DIR", "DATABASE_DIR"],
  url: ["RUTACUADRILLA_DATABASE_URL", "DATABASE_URL"],
  urlFile: ["RUTACUADRILLA_DATABASE_URL_FILE", "DATABASE_URL_FILE"],
};

const publicErrorCodes = new Set([
  "INITIAL_ADMIN_ARGUMENTS_INVALID",
  "INITIAL_ADMIN_CAPABILITY_CATALOG_MISMATCH",
  "INITIAL_ADMIN_DATABASE_DIR_INVALID",
  "INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT",
  "INITIAL_ADMIN_DATABASE_SOURCE_REQUIRED",
  "INITIAL_ADMIN_DATABASE_URL_FILE_INVALID",
  "INITIAL_ADMIN_DATABASE_URL_INVALID",
  "INITIAL_ADMIN_DISPLAY_NAME_INVALID",
  "INITIAL_ADMIN_EMAIL_INVALID",
  "INITIAL_ADMIN_PASSWORD_FILE_INVALID",
  "INITIAL_ADMIN_PASSWORD_FILE_REQUIRED",
  "INITIAL_ADMIN_PASSWORD_INVALID",
  "INITIAL_ADMIN_PROVISION_LOCK_MISSING",
  "INITIAL_ADMIN_STATE_CONFLICT",
  "INITIAL_ADMIN_STATE_PARTIAL",
  "INITIAL_CREW_NAME_INVALID",
  "INITIAL_CREW_SLUG_INVALID",
]);

const forbiddenPasswordCodePoints = new Set([0, 10, 13, 133, 8_232, 8_233]);

function requiredText(value, code) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
  return value.trim();
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--") ||
      !optionNames.includes(key.slice(2)) ||
      Object.hasOwn(parsed, key.slice(2))
    ) {
      throw new Error("INITIAL_ADMIN_ARGUMENTS_INVALID");
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function assertDatabaseDirectory(value) {
  const databaseDir = requiredText(value, "INITIAL_ADMIN_DATABASE_DIR_INVALID");
  if (!isAbsolute(databaseDir)) throw new Error("INITIAL_ADMIN_DATABASE_DIR_INVALID");
  const normalized = resolve(databaseDir);
  if (normalized === parse(normalized).root) {
    throw new Error("INITIAL_ADMIN_DATABASE_DIR_INVALID");
  }
  return normalized;
}

function assertDatabaseUrl(value) {
  const databaseUrl = requiredText(value, "INITIAL_ADMIN_DATABASE_URL_INVALID");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("INITIAL_ADMIN_DATABASE_URL_INVALID");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    !parsed.username
  ) {
    throw new Error("INITIAL_ADMIN_DATABASE_URL_INVALID");
  }
  return databaseUrl;
}

function assertAbsoluteDatabaseUrlFile(value) {
  const databaseUrlFile = requiredText(value, "INITIAL_ADMIN_DATABASE_URL_FILE_INVALID");
  if (!isAbsolute(databaseUrlFile)) {
    throw new Error("INITIAL_ADMIN_DATABASE_URL_FILE_INVALID");
  }
  return resolve(databaseUrlFile);
}

function assertAbsolutePasswordFile(value) {
  const passwordFile = requiredText(value, "INITIAL_ADMIN_PASSWORD_FILE_REQUIRED");
  if (!isAbsolute(passwordFile)) throw new Error("INITIAL_ADMIN_PASSWORD_FILE_INVALID");
  return resolve(passwordFile);
}

function assertEmail(value) {
  const email = requiredText(value, "INITIAL_ADMIN_EMAIL_INVALID").toLowerCase();
  if (!accountEmailSchema.safeParse(email).success) {
    throw new Error("INITIAL_ADMIN_EMAIL_INVALID");
  }
  return email;
}

function assertName(value, code) {
  const name = requiredText(value, code);
  const hasControlCharacter = [...name].some((character) => {
    const characterCode = character.charCodeAt(0);
    return characterCode <= 31 || characterCode === 127;
  });
  if (name.length > 120 || hasControlCharacter) throw new Error(code);
  return name;
}

function assertCrewSlug(value) {
  const crewSlug = requiredText(value, "INITIAL_CREW_SLUG_INVALID");
  if (crewSlug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(crewSlug)) {
    throw new Error("INITIAL_CREW_SLUG_INVALID");
  }
  return crewSlug;
}

function resolveEnvironmentValue(environment, names) {
  const configured = names
    .filter((name) => environment[name] !== undefined)
    .map((name) => environment[name]);
  if (configured.length > 1) throw new Error("INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT");
  return configured[0];
}

export function resolveProvisionOptions(argv, environment = process.env) {
  const argumentsByName = parseArguments(argv);
  const valueFor = (name) => argumentsByName[name] ?? environment[environmentNames[name]];
  const databaseDirValue =
    argumentsByName["database-dir"] ??
    resolveEnvironmentValue(environment, databaseEnvironmentNames.directory);
  const databaseUrlValue =
    argumentsByName["database-url"] ??
    resolveEnvironmentValue(environment, databaseEnvironmentNames.url);
  const databaseUrlFileValue = resolveEnvironmentValue(
    environment,
    databaseEnvironmentNames.urlFile,
  );
  const configuredDatabaseSources = [
    databaseDirValue,
    databaseUrlValue,
    databaseUrlFileValue,
  ].filter((value) => value !== undefined);
  if (configuredDatabaseSources.length === 0) {
    throw new Error("INITIAL_ADMIN_DATABASE_SOURCE_REQUIRED");
  }
  if (configuredDatabaseSources.length > 1) {
    throw new Error("INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT");
  }

  return {
    crewName: assertName(valueFor("crew-name"), "INITIAL_CREW_NAME_INVALID"),
    crewSlug: assertCrewSlug(valueFor("crew-slug")),
    ...(databaseDirValue !== undefined
      ? { databaseDir: assertDatabaseDirectory(databaseDirValue) }
      : {}),
    ...(databaseUrlValue !== undefined ? { databaseUrl: assertDatabaseUrl(databaseUrlValue) } : {}),
    ...(databaseUrlFileValue !== undefined
      ? { databaseUrlFile: assertAbsoluteDatabaseUrlFile(databaseUrlFileValue) }
      : {}),
    displayName: assertName(valueFor("display-name"), "INITIAL_ADMIN_DISPLAY_NAME_INVALID"),
    email: assertEmail(valueFor("email")),
    passwordFile: assertAbsolutePasswordFile(valueFor("password-file")),
  };
}

export async function readProvisionPassword(passwordFile) {
  let fileInformation;
  try {
    fileInformation = await stat(passwordFile);
  } catch {
    throw new Error("INITIAL_ADMIN_PASSWORD_FILE_INVALID");
  }
  if (!fileInformation.isFile()) throw new Error("INITIAL_ADMIN_PASSWORD_FILE_INVALID");

  const content = await readFile(passwordFile, "utf8");
  const password = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  if (
    !newAccountPasswordSchema.safeParse(password).success ||
    !/\S/u.test(password) ||
    [...password].some((character) =>
      forbiddenPasswordCodePoints.has(character.codePointAt(0) ?? -1),
    )
  ) {
    throw new Error("INITIAL_ADMIN_PASSWORD_INVALID");
  }
  return password;
}

export async function readProvisionDatabaseUrl(databaseUrlFile) {
  let fileInformation;
  try {
    fileInformation = await stat(databaseUrlFile);
  } catch {
    throw new Error("INITIAL_ADMIN_DATABASE_URL_FILE_INVALID");
  }
  if (!fileInformation.isFile()) {
    throw new Error("INITIAL_ADMIN_DATABASE_URL_FILE_INVALID");
  }
  return assertDatabaseUrl(await readFile(databaseUrlFile, "utf8"));
}

function sameValues(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

async function assertCapabilityCatalog(transaction) {
  const available = await transaction.query("SELECT code FROM capability ORDER BY code");
  const availableCodes = available.rows.map((row) => row.code);
  const requiredCodes = [...capabilityCodes].sort();
  if (!sameValues(availableCodes, requiredCodes)) {
    throw new Error("INITIAL_ADMIN_CAPABILITY_CATALOG_MISMATCH");
  }
  return requiredCodes;
}

async function inspectExistingProvision(transaction, input, requiredCapabilities) {
  const [users, crews] = await Promise.all([
    transaction.query(
      `SELECT id, email, display_name, password_hash, status
       FROM app_user
       WHERE lower(email) = lower($1)`,
      [input.email],
    ),
    transaction.query(
      `SELECT id, name, slug, timezone, currency, status
       FROM crew
       WHERE slug = $1`,
      [input.crewSlug],
    ),
  ]);
  const user = users.rows[0];
  const crew = crews.rows[0];

  if (!user && !crew) {
    const existingState = await transaction.query(
      `SELECT
         (SELECT count(*)::int FROM app_user) AS users,
         (SELECT count(*)::int FROM crew) AS crews,
         (SELECT count(*)::int FROM crew_membership) AS memberships,
         (SELECT count(*)::int FROM membership_capability) AS grants`,
    );
    const counts = existingState.rows[0];
    if (
      counts?.users !== 0 ||
      counts.crews !== 0 ||
      counts.memberships !== 0 ||
      counts.grants !== 0
    ) {
      throw new Error("INITIAL_ADMIN_STATE_CONFLICT");
    }
    return { status: "EMPTY" };
  }
  if (!user || !crew) throw new Error("INITIAL_ADMIN_STATE_PARTIAL");
  if (
    users.rows.length !== 1 ||
    crews.rows.length !== 1 ||
    user.email !== input.email ||
    user.display_name !== input.displayName ||
    user.status !== "ACTIVE" ||
    crew.name !== input.crewName ||
    crew.slug !== input.crewSlug ||
    crew.timezone !== "America/Santiago" ||
    crew.currency !== "CLP" ||
    crew.status !== "ACTIVE"
  ) {
    throw new Error("INITIAL_ADMIN_STATE_CONFLICT");
  }

  const memberships = await transaction.query(
    `SELECT id, role, profile, status
     FROM crew_membership
     WHERE crew_id = $1 AND user_id = $2`,
    [crew.id, user.id],
  );
  const membership = memberships.rows[0];
  if (!membership) throw new Error("INITIAL_ADMIN_STATE_PARTIAL");
  if (
    memberships.rows.length !== 1 ||
    membership.role !== "ADMIN" ||
    membership.profile !== "OTHER" ||
    membership.status !== "ACTIVE"
  ) {
    throw new Error("INITIAL_ADMIN_STATE_CONFLICT");
  }

  const grants = await transaction.query(
    `SELECT capability_code
     FROM membership_capability
     WHERE crew_id = $1 AND membership_id = $2
     ORDER BY capability_code`,
    [crew.id, membership.id],
  );
  const grantedCapabilities = grants.rows.map((row) => row.capability_code);
  if (!sameValues(grantedCapabilities, requiredCapabilities)) {
    throw new Error("INITIAL_ADMIN_STATE_PARTIAL");
  }
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new Error("INITIAL_ADMIN_STATE_CONFLICT");
  }
  return { status: "EXACT" };
}

export async function provisionInitialAdmin(database, input) {
  return database.transaction(async (transaction) => {
    const provisionLock = await transaction.query(
      `SELECT id
       FROM system_lock
       WHERE id = 'INITIAL_ADMIN_PROVISION'
       FOR UPDATE`,
    );
    if (provisionLock.rows.length !== 1) {
      throw new Error("INITIAL_ADMIN_PROVISION_LOCK_MISSING");
    }
    const requiredCapabilities = await assertCapabilityCatalog(transaction);
    const existing = await inspectExistingProvision(transaction, input, requiredCapabilities);
    if (existing.status === "EXACT") {
      return { capabilityCount: requiredCapabilities.length, status: "ALREADY_PROVISIONED" };
    }

    const userId = randomUUID();
    const crewId = randomUUID();
    const membershipId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    await transaction.query(
      `INSERT INTO app_user (id, email, display_name, password_hash, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [userId, input.email, input.displayName, passwordHash],
    );
    await transaction.query(
      `INSERT INTO crew (id, name, slug, timezone, currency, status)
       VALUES ($1, $2, $3, 'America/Santiago', 'CLP', 'ACTIVE')`,
      [crewId, input.crewName, input.crewSlug],
    );
    await transaction.query(
      `INSERT INTO crew_membership
         (crew_id, id, user_id, role, profile, status)
       VALUES ($1, $2, $3, 'ADMIN', 'OTHER', 'ACTIVE')`,
      [crewId, membershipId, userId],
    );
    for (const capability of requiredCapabilities) {
      await transaction.query(
        `INSERT INTO membership_capability
           (crew_id, membership_id, capability_code, granted_by_membership_id)
         VALUES ($1, $2, $3, $2)`,
        [crewId, membershipId, capability],
      );
    }
    return { capabilityCount: requiredCapabilities.length, status: "PROVISIONED" };
  });
}

export async function openProvisionDatabase(options, dependencies = {}) {
  const sources = [options.databaseDir, options.databaseUrl, options.databaseUrlFile].filter(
    (value) => value !== undefined,
  );
  if (sources.length === 0) throw new Error("INITIAL_ADMIN_DATABASE_SOURCE_REQUIRED");
  if (sources.length > 1) throw new Error("INITIAL_ADMIN_DATABASE_SOURCE_CONFLICT");

  if (options.databaseDir !== undefined) {
    const openPglite = dependencies.createDatabase ?? createDatabase;
    return openPglite({ dataDir: assertDatabaseDirectory(options.databaseDir) });
  }

  const connectionString =
    options.databaseUrl !== undefined
      ? assertDatabaseUrl(options.databaseUrl)
      : await readProvisionDatabaseUrl(assertAbsoluteDatabaseUrlFile(options.databaseUrlFile));
  const openPostgres = dependencies.createPostgresDatabase ?? createPostgresDatabase;
  return openPostgres({
    applicationName: "rutacuadrilla-initial-admin",
    connectionTimeoutMillis: 10_000,
    connectionString,
    lockTimeoutMillis: 30_000,
    maxConnections: 1,
  });
}

export async function runProvision(options) {
  const password = await readProvisionPassword(options.passwordFile);
  const database = await openProvisionDatabase(options);
  try {
    await migrateDatabase(database);
    return await provisionInitialAdmin(database, { ...options, password });
  } finally {
    await closeDatabase(database);
  }
}

async function runCli() {
  const options = resolveProvisionOptions(process.argv.slice(2));
  const result = await runProvision(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : "INITIAL_ADMIN_PROVISION_FAILED";
    process.stderr.write(
      `${publicErrorCodes.has(message) ? message : "INITIAL_ADMIN_PROVISION_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
}
