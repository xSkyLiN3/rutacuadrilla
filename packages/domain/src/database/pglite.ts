import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import type { DomainDatabase, QueryResult, SqlExecutor } from "./types.js";

class PGliteExecutor implements SqlExecutor {
  constructor(protected readonly client: PGliteInterface | Transaction) {}

  async exec(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(sql, [...parameters]);
    return {
      affectedRows: result.affectedRows ?? result.rows.length,
      rows: result.rows,
    };
  }
}

export class PGliteDatabase extends PGliteExecutor implements DomainDatabase {
  constructor(readonly pglite: PGlite) {
    super(pglite);
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }

  async transaction<Result>(
    callback: (transaction: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.pglite.transaction(async (transaction) =>
      callback(new PGliteExecutor(transaction)),
    );
  }
}

export type CreateDatabaseOptions = {
  dataDir?: string;
};

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DomainDatabase> {
  const dataDir = options.dataDir ? resolve(options.dataDir) : undefined;
  if (dataDir) await mkdir(dataDir, { recursive: true });

  const pglite = dataDir ? new PGlite(dataDir) : new PGlite();
  await pglite.waitReady;
  return new PGliteDatabase(pglite);
}

export async function closeDatabase(database: DomainDatabase): Promise<void> {
  await database.close();
}
