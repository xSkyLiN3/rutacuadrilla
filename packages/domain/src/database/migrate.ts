import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../errors.js";
import type { DomainDatabase } from "./types.js";

type MigrationRow = {
  checksum: string;
  name: string;
};

export type MigrateDatabaseOptions = {
  migrationsDir?: string;
};

const defaultMigrationsDir = fileURLToPath(
  new URL("../../../../database/migrations/", import.meta.url),
);

export async function migrateDatabase(
  database: DomainDatabase,
  options: MigrateDatabaseOptions = {},
): Promise<void> {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name))
    .sort();

  for (const name of names) {
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await database.query<MigrationRow>(
      "SELECT name, checksum FROM schema_migration WHERE name = $1",
      [name],
    );

    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new DomainError("MIGRATION_CHECKSUM_MISMATCH", {
          details: { actual: checksum, expected: existing.rows[0].checksum, name },
          statusCode: 500,
        });
      }
      continue;
    }

    await database.transaction(async (transaction) => {
      await transaction.exec(sql);
      await transaction.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [
        name,
        checksum,
      ]);
    });
  }
}
