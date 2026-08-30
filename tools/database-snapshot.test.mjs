import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createSnapshot, restoreSnapshot } from "./database-snapshot.mjs";

test("creates and restores a checksum-verified PGlite snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-snapshot-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const archive = join(directory, "snapshot.tgz");
  const restored = join(directory, "restored");

  const database = new PGlite(source);
  await database.waitReady;
  await database.exec("CREATE TABLE sample(id integer PRIMARY KEY, value text NOT NULL)");
  await database.query("INSERT INTO sample(id, value) VALUES ($1, $2), ($3, $4)", [
    1,
    "uno",
    2,
    "dos",
  ]);
  await database.close();

  const created = await createSnapshot({ databaseDir: source, archivePath: archive });
  assert.equal(created.manifest.inventory.length, 1);
  assert.equal(created.manifest.inventory[0]?.table, "sample");
  assert.equal(created.manifest.inventory[0]?.rowCount, 2);

  await restoreSnapshot({ archivePath: archive, targetDir: restored });
  const restoredDatabase = new PGlite(restored);
  await restoredDatabase.waitReady;
  const result = await restoredDatabase.query("SELECT id, value FROM sample ORDER BY id");
  await restoredDatabase.close();
  assert.deepEqual(result.rows, [
    { id: 1, value: "uno" },
    { id: 2, value: "dos" },
  ]);

  await assert.rejects(
    restoreSnapshot({ archivePath: archive, targetDir: restored }),
    /SNAPSHOT_RESTORE_TARGET_ALREADY_EXISTS/u,
  );

  const concurrentTarget = join(directory, "concurrent-restored");
  const attempts = await Promise.allSettled([
    restoreSnapshot({ archivePath: archive, targetDir: concurrentTarget }),
    restoreSnapshot({ archivePath: archive, targetDir: concurrentTarget }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.match(String(rejected?.reason), /SNAPSHOT_RESTORE_TARGET_ALREADY_EXISTS/u);
});

test("rejects a corrupted archive and an incompatible manifest before restoring", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-snapshot-invalid-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const archive = join(directory, "snapshot.tgz");

  const database = new PGlite(source);
  await database.waitReady;
  await database.exec("CREATE TABLE sample(id integer PRIMARY KEY)");
  await database.close();

  const created = await createSnapshot({ databaseDir: source, archivePath: archive });
  const corruptedArchive = join(directory, "corrupted.tgz");
  const corruptedBytes = await readFile(archive);
  corruptedBytes[0] = (corruptedBytes[0] ?? 0) ^ 0xff;
  await writeFile(corruptedArchive, corruptedBytes);
  await assert.rejects(
    restoreSnapshot({
      archivePath: corruptedArchive,
      manifestPath: created.manifestPath,
      targetDir: join(directory, "corrupted-target"),
    }),
    /SNAPSHOT_ARCHIVE_CHECKSUM_MISMATCH/u,
  );

  const incompatibleManifest = join(directory, "incompatible.manifest.json");
  await writeFile(
    incompatibleManifest,
    JSON.stringify({ ...created.manifest, schema: "rutacuadrilla-future-snapshot-v99" }),
  );
  await assert.rejects(
    restoreSnapshot({
      archivePath: archive,
      manifestPath: incompatibleManifest,
      targetDir: join(directory, "incompatible-target"),
    }),
    /SNAPSHOT_MANIFEST_INVALID/u,
  );

  const collision = join(directory, "collision.tgz");
  await assert.rejects(
    createSnapshot({
      archivePath: collision,
      databaseDir: source,
      manifestPath: collision,
    }),
    /SNAPSHOT_ARCHIVE_MANIFEST_PATH_COLLISION/u,
  );
});

test("resolves junctions before rejecting output paths inside the database", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rutacuadrilla-snapshot-link-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const linkedSource = join(directory, "linked-source");
  const database = new PGlite(source);
  await database.waitReady;
  await database.exec("CREATE TABLE sample(id integer PRIMARY KEY)");
  await database.close();
  await symlink(source, linkedSource, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    createSnapshot({
      archivePath: join(linkedSource, "snapshot-inside-source.tgz"),
      databaseDir: source,
    }),
    /SNAPSHOT_OUTPUT_INSIDE_DATABASE_DIR/u,
  );
});
