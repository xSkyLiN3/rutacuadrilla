export type QueryResult<Row> = {
  rows: Row[];
};

export interface SqlDatabase {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<QueryResult<Row>>;
}
