import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createWorkerTestContext } from '../helpers/worker';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { createS256CodeChallenge } from '../../src/oauth/pkce';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

async function completeFlow(scope = 'calendar.write gmail.send offline_access') {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
  const challenge = await createS256CodeChallenge(verifier);
  const googleScopesByRequestedScope: Record<string, string> = {
    'calendar.write': 'https://www.googleapis.com/auth/calendar.events',
    'drive.read': 'https://www.googleapis.com/auth/drive',
    'drive.write': 'https://www.googleapis.com/auth/drive',
    'gmail.read': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
    'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.drafts': 'https://www.googleapis.com/auth/gmail.compose',
  };
  const googleScopeSet = new Set(['openid', 'email', 'profile']);
  for (const requestedScope of scope.split(' ').filter(Boolean)) {
    const googleScope = googleScopesByRequestedScope[requestedScope];
    if (googleScope) {
      googleScopeSet.add(googleScope);
    }
  }
  const googleMock = createGoogleFetchMock({
    'https://oauth2.googleapis.com/token': jsonResponse({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      scope: [...googleScopeSet].join(' '),
      token_type: 'Bearer',
    }),
    'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
      sub: 'google-user-123',
      email: 'me@example.com',
    }),
  });

  const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
  const registration = await registerClient(ctx);
  const clientId = String(registration.json.client_id);

  const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent(scope)}`);
  const csrfToken = extractHiddenInput(await authorizeResponse.text(), 'csrf_token');
  const postAuthorize = await ctx.callWorker('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'http://localhost:8787/mcp',
      scope,
      csrf_token: csrfToken,
    }),
    redirect: 'manual',
  });

  const state = new URL(postAuthorize.headers.get('location')!).searchParams.get('state')!;
  const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=google-auth-code`, { redirect: 'manual' });
  const authCode = new URL(callbackResponse.headers.get('location')!).searchParams.get('code')!;
  const tokenResponse = await ctx.callWorker('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_verifier: verifier,
      resource: 'http://localhost:8787/mcp',
    }),
  });

  return {
    ctx,
    token: String((await tokenResponse.json() as Record<string, unknown>).access_token),
  };
}

async function listToolNames(ctx: ReturnType<typeof createWorkerTestContext>, token: string): Promise<string[]> {
  const response = await ctx.callWorker('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  const json = await response.json() as { result?: { tools?: Array<{ name: string }> } };
  return (json.result?.tools ?? []).map((tool) => tool.name);
}

describe('mcp auth and tool registration', () => {
  it('accepts lowercase bearer authorization scheme on /mcp', async () => {
    const flow = await completeFlow();
    const response = await flow.ctx.callWorker('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `bearer ${flow.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).not.toBe(401);
  });

  it('only registers tools for granted scopes', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'calendar.read calendar.write gmail.send',
    });

    const toolNames = Object.keys((server as any)._registeredTools ?? {});
    expect(toolNames).toContain('calendar_list_calendars');
    expect(toolNames).toContain('calendar_create_event');
    expect(toolNames).toContain('gmail_send_email');
    expect(toolNames).not.toContain('gmail_reply_to_message');
    expect(toolNames).not.toContain('gmail_get_profile');
    expect(toolNames).not.toContain('drive_list_files');
  });

  it('exposes calendar, drive, and gmail tools after a widened grant', async () => {
    const flow = await completeFlow('calendar.write drive.write gmail.modify gmail.drafts offline_access');
    const toolNames = await listToolNames(flow.ctx, flow.token);

    expect(toolNames).toEqual(expect.arrayContaining([
      'calendar_create_event',
      'drive_list_files',
      'drive_update_file',
      'gmail_get_profile',
      'gmail_modify_message_labels',
      'gmail_create_draft',
    ]));
  });
});
