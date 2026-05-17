import { describe, expect, it } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { createS256CodeChallenge } from '../../src/oauth/pkce';
import { getGrantById, upsertGrant } from '../../src/storage/grants';
import { parseConfig } from '../../src/config';
import { encryptJson } from '../../src/security/crypto';
import { decryptStoredGoogleTokenSet } from '../../src/google/oauth';

async function completeBaseFlow() {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
  const challenge = await createS256CodeChallenge(verifier);
  const googleMock = createGoogleFetchMock({
    'https://oauth2.googleapis.com/token': jsonResponse({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
      token_type: 'Bearer',
    }),
    'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({ sub: 'user-1', email: 'me@example.com' }),
  });

  const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
  const registration = await registerClient(ctx);
  const clientId = String(registration.json.client_id);
  const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.write offline_access')}`);
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
      scope: 'calendar.write offline_access',
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

  it('reissues tokens using the current stored grant scopes', async () => {
    const flow = await completeBaseFlow();
    const config = parseConfig(flow.ctx.env);
    const refreshClaims = JSON.parse(Buffer.from(flow.refreshToken.split('.')[1]!, 'base64url').toString('utf8')) as { grant_id: string; sub: string };
    const existingGrant = await getGrantById(flow.ctx.db, refreshClaims.grant_id);
    if (!existingGrant) {
      throw new Error('expected existing grant');
    }

    const existingTokenSet = await decryptStoredGoogleTokenSet(config, existingGrant);
    await upsertGrant(flow.ctx.db, {
      grantId: existingGrant.grant_id,
      subject: existingGrant.subject,
      encryptedGoogleTokens: await encryptJson(existingTokenSet, config.tokenEncryptionKey, {
        grant_id: existingGrant.grant_id,
        subject: existingGrant.subject,
        kind: 'google_tokens',
      }),
      grantedMcpScopes: 'calendar.read calendar.write',
      grantedGoogleScopes: existingGrant.granted_google_scopes,
    });

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
    expect(json.scope).toBe('calendar.read calendar.write');
    expect(json.refresh_token).toBeUndefined();
  });
});
