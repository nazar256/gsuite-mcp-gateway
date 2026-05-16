import { describe, expect, it } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';

describe('dynamic client registration', () => {
  it('rejects a non-allowlisted redirect uri', async () => {
    const ctx = createWorkerTestContext();
    const response = await ctx.callWorker('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://evil.example/callback'],
        client_name: 'Bad Client',
        token_endpoint_auth_method: 'none',
      }),
    });

    expect(response.status).toBe(400);
    const json = await response.json() as Record<string, unknown>;
    expect(json.error).toBe('invalid_redirect_uri');
  });
});
