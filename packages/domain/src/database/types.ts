export type QueryResult<Row> = {
  affectedRows: number;
  rows: Row[];
};

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface DomainDatabase extends SqlExecutor {
  close(): Promise<void>;
  transaction<Result>(callback: (transaction: SqlExecutor) => Promise<Result>): Promise<Result>;
}
