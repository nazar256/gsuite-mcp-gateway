import { describe, expect, it } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';

describe('root routes', () => {
  it('serves public pages and health', async () => {
    const ctx = createWorkerTestContext();
    const root = await ctx.callWorker('/');
    const privacy = await ctx.callWorker('/privacy');
    const terms = await ctx.callWorker('/terms');
    const support = await ctx.callWorker('/support');
    const demo = await ctx.callWorker('/demo');
    const health = await ctx.callWorker('/health');
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('is a self-hosted Cloudflare Worker MCP gateway');
    expect(privacy.status).toBe(200);
    expect(terms.status).toBe(200);
    expect(support.status).toBe(200);
    expect(demo.status).toBe(200);
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

    const resourceJson = await resource.json() as Record<string, unknown>;
    expect(resourceJson.resource_name).toBe('Google Workspace MCP Gateway');
    expect(resourceJson.scopes_supported).toEqual(['calendar.write', 'gmail.send', 'gmail.drafts', 'offline_access']);
  });

  it('keeps disconnect as post-only and truthful without a demo session', async () => {
    const ctx = createWorkerTestContext();
    const getResponse = await ctx.callWorker('/account/disconnect');
    expect(getResponse.status).toBe(404);

    const postResponse = await ctx.callWorker('/account/disconnect', {
      method: 'POST',
      redirect: 'manual',
    });
    expect(postResponse.status).toBe(302);
    expect(postResponse.headers.get('location')).toContain('/support?flash=No+current+demo-session+grant+was+connected+in+this+browser.');
  });
});
