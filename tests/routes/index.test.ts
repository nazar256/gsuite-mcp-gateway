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
    expect(await support.text()).toContain('GitHub issues');
    expect(demo.status).toBe(200);
    expect(health.status).toBe(200);
  });

  it('allows local authorize form posts under CSP', async () => {
    const ctx = createWorkerTestContext();
    const registration = await ctx.callWorker('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://localhost:8002/callback'],
        client_name: 'CSP Test Client',
        token_endpoint_auth_method: 'none',
      }),
    });
    const { client_id: clientId } = await registration.json() as Record<string, string>;
    expect(clientId).toBeTypeOf('string');

    const authorize = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId!)}&redirect_uri=${encodeURIComponent('http://localhost:8002/callback')}&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.read')}`);
    const csp = authorize.headers.get('content-security-policy') ?? '';
    expect(authorize.status).toBe(200);
    expect(csp).toContain("form-action 'self' https://accounts.google.com");
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
    expect(resourceJson.scopes_supported).toEqual(['calendar.read', 'calendar.write', 'drive.read', 'drive.write', 'gmail.read', 'gmail.send', 'gmail.modify', 'gmail.drafts', 'offline_access']);
    expect(mcp.headers.get('www-authenticate')).toContain('scope="calendar.read calendar.write drive.read drive.write gmail.read gmail.send gmail.modify gmail.drafts offline_access"');
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
    expect(postResponse.headers.get('location')).toContain('/support?flash=No+demo+grant+was+connected+for+this+Google+account+on+this+deployment.');
  });
});
