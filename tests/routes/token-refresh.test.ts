import { describe, expect, it } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { createS256CodeChallenge } from '../../src/oauth/pkce';

async function completeBaseFlow() {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
  const challenge = await createS256CodeChallenge(verifier);
  const googleMock = createGoogleFetchMock({
    'https://oauth2.googleapis.com/token': jsonResponse({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events.freebusy',
      token_type: 'Bearer',
    }),
    'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({ sub: 'user-1', email: 'me@example.com' }),
  });

  const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
  const registration = await registerClient(ctx);
  const clientId = String(registration.json.client_id);
  const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.read offline_access')}`);
  const html = await authorizeResponse.text();
  const csrf = extractHiddenInput(html, 'csrf_token');
  const continueResponse = await ctx.callWorker('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'http://localhost:8787/mcp',
      scope: 'calendar.read offline_access',
      csrf_token: csrf,
    }),
    redirect: 'manual',
  });
  const state = new URL(continueResponse.headers.get('location')!).searchParams.get('state')!;
  const callback = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=test-google-code`, { redirect: 'manual' });
  const authCode = new URL(callback.headers.get('location')!).searchParams.get('code')!;
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
    clientId,
    refreshToken: String((await tokenResponse.json() as Record<string, unknown>).refresh_token),
  };
}

describe('token refresh', () => {
  it('issues a new access token from refresh token', async () => {
    const flow = await completeBaseFlow();
    const refreshResponse = await flow.ctx.callWorker('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: flow.refreshToken,
        client_id: flow.clientId,
      }),
    });
    const json = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshResponse.status).toBe(200);
    expect(json.access_token).toBeTypeOf('string');
    expect(json.refresh_token).toBeTypeOf('string');
  });
});
