import { describe, expect, it } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';

describe('root routes', () => {
  it('serves service info and health', async () => {
    const ctx = createWorkerTestContext();
    const root = await ctx.callWorker('/');
    const health = await ctx.callWorker('/health');
    expect(root.status).toBe(200);
    expect(health.status).toBe(200);
  });

  it('returns oauth metadata and mcp challenge', async () => {
    const ctx = createWorkerTestContext();
    const resource = await ctx.callWorker('/.well-known/oauth-protected-resource');
    const authz = await ctx.callWorker('/.well-known/oauth-authorization-server');
    const mcp = await ctx.callWorker('/mcp');
    expect(resource.status).toBe(200);
    expect(authz.status).toBe(200);
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('www-authenticate')).toContain('resource_metadata');
  });
});
