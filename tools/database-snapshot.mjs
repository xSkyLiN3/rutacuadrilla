import { createHash } from "node:crypto";
import { access, link, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MANIFEST_SCHEMA = "rutacuadrilla-pglite-snapshot-v1";
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("SNAPSHOT_ARGUMENTS_INVALID");
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeNewTarget(targetPath, label) {
  const parsed = resolve(targetPath);
  const root = resolve(parsed, "\\");
  if (parsed === root || dirname(parsed) === parsed) {
    throw new Error(`${label}_TARGET_TOO_BROAD`);
  }
  return parsed;
}

async function resolvePhysicalTarget(targetPath) {
  let cursor = resolve(targetPath);
  const missingSegments = [];
  while (true) {
    try {
      const physicalAncestor = await realpath(cursor);
      return resolve(physicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code") || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isInside(basePath, candidatePath) {
  const child = relative(basePath, candidatePath);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..\\`) && !child.startsWith("../"))
  );
}

async function writeAtomically(targetPath, bytes) {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  try {
    await link(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function collectInventory(database) {
  const tables = await database.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);

  const inventory = [];
  for (const item of tables.rows) {
    const table = item.table_name;
    if (typeof table !== "string" || !SAFE_IDENTIFIER.test(table)) {
      throw new Error("SNAPSHOT_UNSAFE_TABLE_IDENTIFIER");
    }
    const count = await database.query(`SELECT count(*)::text AS count FROM "${table}"`);
    const rows = await database.query(
      `SELECT to_jsonb(source_row)::text AS canonical_row FROM "${table}" AS source_row ORDER BY to_jsonb(source_row)::text`,
    );
    const canonicalRows = rows.rows.map((row) => row.canonical_row).join("\n");
    inventory.push({
      table,
      rowCount: Number(count.rows[0]?.count ?? 0),
      contentSha256: sha256(canonicalRows),
    });
  }
  return inventory;
}

function assertManifest(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schema !== MANIFEST_SCHEMA ||
    typeof value.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.archiveSha256) ||
    !Number.isSafeInteger(value.archiveBytes) ||
    !Array.isArray(value.inventory)
  ) {
    throw new Error("SNAPSHOT_MANIFEST_INVALID");
  }
  for (const entry of value.inventory) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.table !== "string" ||
      !SAFE_IDENTIFIER.test(entry.table) ||
      !Number.isSafeInteger(entry.rowCount) ||
      entry.rowCount < 0 ||
      typeof entry.contentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.contentSha256)
    ) {
      throw new Error("SNAPSHOT_MANIFEST_INVALID");
    }
  }
  return value;
}

function compareInventory(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("SNAPSHOT_RESTORE_INVARIANTS_MISMATCH");
  }
}

export async function createSnapshot({ databaseDir, archivePath, manifestPath }) {
  const source = await realpath(resolve(databaseDir));
  const archive = await resolvePhysicalTarget(assertSafeNewTarget(archivePath, "SNAPSHOT"));
  const manifest = await resolvePhysicalTarget(
    assertSafeNewTarget(manifestPath ?? `${archive}.manifest.json`, "SNAPSHOT_MANIFEST"),
  );
  if (archive === manifest) throw new Error("SNAPSHOT_ARCHIVE_MANIFEST_PATH_COLLISION");

  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) throw new Error("SNAPSHOT_DATABASE_DIR_INVALID");
  if (await pathExists(archive)) throw new Error("SNAPSHOT_ARCHIVE_ALREADY_EXISTS");
  if (await pathExists(manifest)) throw new Error("SNAPSHOT_MANIFEST_ALREADY_EXISTS");
  if (isInside(source, archive) || isInside(source, manifest)) {
    throw new Error("SNAPSHOT_OUTPUT_INSIDE_DATABASE_DIR");
  }

  const database = new PGlite(source);
  await database.waitReady;
  try {
    await database.exec("CHECKPOINT");
    const inventory = await collectInventory(database);
    const blob = await database.dumpDataDir("gzip");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const snapshotManifest = {
      schema: MANIFEST_SCHEMA,
      createdAt: new Date().toISOString(),
      archive: archive.split(/[\\/]/u).at(-1),
      archiveBytes: bytes.byteLength,
      archiveSha256: sha256(bytes),
      inventory,
    };
    await writeAtomically(archive, bytes);
    try {
      await writeAtomically(manifest, `${JSON.stringify(snapshotManifest, null, 2)}\n`);
    } catch (error) {
      try {
        await unlink(archive);
      } catch {
        throw new Error(
          `SNAPSHOT_PARTIAL_OUTPUT_PRESERVED:${archive}:${error instanceof Error ? error.message : "UNKNOWN"}`,
        );
      }
      throw error;
    }
    return { archivePath: archive, manifestPath: manifest, manifest: snapshotManifest };
  } finally {
    await database.close();
  }
}

export async function restoreSnapshot({ archivePath, manifestPath, targetDir }) {
  const archive = await realpath(resolve(archivePath));
  const manifestFile = await realpath(resolve(manifestPath ?? `${archive}.manifest.json`));
  const target = await resolvePhysicalTarget(assertSafeNewTarget(targetDir, "SNAPSHOT_RESTORE"));
  const [archiveBytes, manifestBytes] = await Promise.all([
    readFile(archive),
    readFile(manifestFile, "utf8"),
  ]);
  const manifest = assertManifest(JSON.parse(manifestBytes));
  if (
    archiveBytes.byteLength !== manifest.archiveBytes ||
    sha256(archiveBytes) !== manifest.archiveSha256
  ) {
    throw new Error("SNAPSHOT_ARCHIVE_CHECKSUM_MISMATCH");
  }

  await mkdir(dirname(target), { recursive: true });
  try {
    await mkdir(target);
  } catch (error) {
    if (error instanceof Error && Reflect.has(error, "code") && error.code === "EEXIST") {
      throw new Error("SNAPSHOT_RESTORE_TARGET_ALREADY_EXISTS");
    }
    throw error;
  }
  const database = new PGlite({
    dataDir: target,
    loadDataDir: new Blob([archiveBytes]),
  });
  try {
    await database.waitReady;
    const restoredInventory = await collectInventory(database);
    compareInventory(manifest.inventory, restoredInventory);
    await database.exec("CHECKPOINT");
    return { targetDir: target, inventory: restoredInventory };
  } catch (error) {
    throw new Error(
      `SNAPSHOT_RESTORE_FAILED_TARGET_PRESERVED:${target}:${error instanceof Error ? error.message : "UNKNOWN"}`,
    );
  } finally {
    await database.close().catch(() => undefined);
  }
}

async function runCli() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "create") {
    if (!options["database-dir"] || !options.archive) throw new Error("SNAPSHOT_ARGUMENTS_INVALID");
    const result = await createSnapshot({
      databaseDir: options["database-dir"],
      archivePath: options.archive,
      ...(options.manifest ? { manifestPath: options.manifest } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({
        status: "SNAPSHOT_CREATED",
        archivePath: result.archivePath,
        manifestPath: result.manifestPath,
        archiveSha256: result.manifest.archiveSha256,
        tableCount: result.manifest.inventory.length,
      })}\n`,
    );
    return;
  }
  if (command === "restore") {
    if (!options.archive || !options["target-dir"]) throw new Error("SNAPSHOT_ARGUMENTS_INVALID");
    const result = await restoreSnapshot({
      archivePath: options.archive,
      targetDir: options["target-dir"],
      ...(options.manifest ? { manifestPath: options.manifest } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({
        status: "SNAPSHOT_RESTORED",
        targetDir: result.targetDir,
        tableCount: result.inventory.length,
      })}\n`,
    );
    return;
  }
  throw new Error("SNAPSHOT_COMMAND_INVALID");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "SNAPSHOT_FAILED"}\n`);
    process.exitCode = 1;
  });
}
