import { Pool, type PoolClient } from "pg";
import type { DomainDatabase, QueryResult, SqlExecutor } from "./types.js";

type PostgresQueryable = {
  query(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<{
    rowCount: number | null;
    rows: unknown[];
  }>;
};

class PostgresExecutor implements SqlExecutor {
  constructor(protected readonly client: PostgresQueryable) {}

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.client.query(sql, parameters);
    return {
      affectedRows: result.rowCount ?? result.rows.length,
      rows: result.rows as Row[],
    };
  }
}

export class PostgresDatabase extends PostgresExecutor implements DomainDatabase {
  constructor(readonly pool: Pool) {
    super(pool as unknown as PostgresQueryable);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<Result>(
    callback: (transaction: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresExecutor(client as unknown as PostgresQueryable));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export type CreatePostgresDatabaseOptions = {
  applicationName?: string;
  connectionTimeoutMillis?: number;
  connectionString: string;
  lockTimeoutMillis?: number;
  maxConnections?: number;
};

export function createPostgresDatabase(options: CreatePostgresDatabaseOptions): DomainDatabase {
  return new PostgresDatabase(
    new Pool({
      application_name: options.applicationName ?? "rutacuadrilla-api",
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      connectionString: options.connectionString,
      lock_timeout: options.lockTimeoutMillis,
      max: options.maxConnections ?? 10,
    }),
  );
}
