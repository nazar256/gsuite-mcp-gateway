import { DatabaseSync } from 'node:sqlite';
import type { DbLike, DbLikePreparedStatement, DbLikeResult } from '../../src/storage/d1';

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

class SqlitePreparedStatement implements DbLikePreparedStatement {
  constructor(
    private readonly statement: SqliteStatement,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): DbLikePreparedStatement {
    return new SqlitePreparedStatement(this.statement, values);
  }

  async all<T = Record<string, unknown>>(): Promise<DbLikeResult<T>> {
    return { results: (this.values.length === 0 ? this.statement.all() : this.statement.all(...(this.values as never[]))) as T[] };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return ((this.values.length === 0 ? this.statement.get() : this.statement.get(...(this.values as never[]))) as T | undefined) ?? null;
  }

  async run(): Promise<DbLikeResult> {
    const result = this.values.length === 0 ? this.statement.run() : this.statement.run(...(this.values as never[]));
    return { meta: { changes: result.changes } };
  }
}

export class SqliteD1Database implements DbLike {
  constructor(public readonly sqlite: DatabaseSync) {}

  prepare(query: string): DbLikePreparedStatement {
    return new SqlitePreparedStatement(this.sqlite.prepare(query));
  }
}

export function applySchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      redirect_uri TEXT NOT NULL,
      client_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state_id TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      encrypted_google_tokens TEXT NOT NULL,
      granted_mcp_scopes TEXT NOT NULL,
      granted_google_scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
}

export function createTestDb(): SqliteD1Database {
  const sqlite = new DatabaseSync(':memory:');
  applySchema(sqlite);
  return new SqliteD1Database(sqlite);
}
