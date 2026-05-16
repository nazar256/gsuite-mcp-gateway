import { HttpError } from '../security/errors';

export interface DbLikeResult<T = Record<string, unknown>> {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

export interface DbLikePreparedStatement {
  bind(...values: unknown[]): DbLikePreparedStatement;
  all<T = Record<string, unknown>>(): Promise<DbLikeResult<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run(): Promise<DbLikeResult>;
}

export interface DbLike {
  prepare(query: string): DbLikePreparedStatement;
  batch?(statements: DbLikePreparedStatement[]): Promise<DbLikeResult[]>;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function runStatement(statement: DbLikePreparedStatement): Promise<void> {
  await statement.run();
}

export async function getFirst<T = Record<string, unknown>>(statement: DbLikePreparedStatement): Promise<T | null> {
  return statement.first<T>();
}

export async function getAll<T = Record<string, unknown>>(statement: DbLikePreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

export async function expectAffected(statement: DbLikePreparedStatement, message: string): Promise<void> {
  const result = await statement.run();
  const changed = Number((result.meta?.changes as number | undefined) ?? 0);
  if (changed < 1) {
    throw new HttpError(404, 'not_found', message);
  }
}
