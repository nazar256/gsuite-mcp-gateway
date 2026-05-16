import worker from '../../src/index';
import type { Env } from '../../src/config';
import { createTestEnv } from './env';
import { createTestDb } from './sqlite-d1';

export function createWorkerTestContext(overrides: Partial<Env> = {}) {
  const db = createTestDb();
  const env = createTestEnv({ ...overrides, DB: db as unknown as D1Database });

  async function callWorker(path: string, init?: RequestInit): Promise<Response> {
    const request = new Request(`http://localhost:8787${path}`, init);
    return worker.fetch(request, env);
  }

  return {
    env,
    db,
    callWorker,
  };
}
