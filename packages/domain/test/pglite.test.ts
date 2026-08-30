import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type DomainDatabase } from "../src/index.js";

describe("PGlite database directory", () => {
  let database: DomainDatabase | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    if (database) {
      await closeDatabase(database);
      database = undefined;
    }
    if (temporaryRoot) {
      await rm(temporaryRoot, { force: true, recursive: true });
      temporaryRoot = undefined;
    }
  });

  it("creates missing parent directories before opening a persistent database", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "rutacuadrilla-pglite-"));
    const dataDir = join(temporaryRoot, "nested", ".local", "demo-db");

    database = await createDatabase({ dataDir });

    expect((await stat(dataDir)).isDirectory()).toBe(true);
    await expect(database.query("SELECT 1 AS ready")).resolves.toMatchObject({
      rows: [{ ready: 1 }],
    });
  });
});
