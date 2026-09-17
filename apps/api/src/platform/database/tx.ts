import type { QueryResultRow } from 'pg';

/**
 * A handle for running SQL. Repositories take one as a parameter instead of
 * holding a connection, so the same repository works inside and outside a
 * transaction and the transaction boundary stays visible in call signatures.
 */
export interface Tx {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';
