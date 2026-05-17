import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { restoreTime, useFixedTime } from '../helpers/time';
import { createS256CodeChallenge } from '../../src/oauth/pkce';
import { getGrantBySubject, getGrantBySubjectNamespace } from '../../src/storage/grants';
import { upsertOAuthClient } from '../../src/storage/clients';

describe('oauth flow', () => {
  beforeEach(() => {
    useFixedTime();
  });

  afterEach(() => {
    restoreTime();
  });

  it('completes register -> authorize -> callback -> token exchange', async () => {
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
      'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
        sub: 'google-user-123',
        email: 'me@example.com',
      }),
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const registration = await registerClient(ctx);
    expect(registration.response.status).toBe(201);

    const clientId = String(registration.json.client_id);
    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=abc123&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.write offline_access')}`);
    expect(authorizeResponse.status).toBe(200);
    const authorizeHtml = await authorizeResponse.text();
    const csrfToken = extractHiddenInput(authorizeHtml, 'csrf_token');

    const postAuthorize = await ctx.callWorker('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        state: 'abc123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'http://localhost:8787/mcp',
        scope: 'calendar.write offline_access',
        csrf_token: csrfToken,
      }),
      redirect: 'manual',
    });
    expect(postAuthorize.status).toBe(302);
    const googleRedirect = new URL(postAuthorize.headers.get('location')!);
    const state = googleRedirect.searchParams.get('state');
    expect(state).toBeTruthy();

    const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state!)}&code=google-auth-code`, { redirect: 'manual' });
    expect(callbackResponse.status).toBe(302);
    const redirectBack = new URL(callbackResponse.headers.get('location')!);
    const authCode = redirectBack.searchParams.get('code');
    expect(authCode).toBeTruthy();
    expect(redirectBack.searchParams.get('state')).toBe('abc123');

    const tokenResponse = await ctx.callWorker('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode!,
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        code_verifier: verifier,
        resource: 'http://localhost:8787/mcp',
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenJson = await tokenResponse.json() as Record<string, unknown>;
    expect(tokenJson.access_token).toBeTypeOf('string');
    expect(tokenJson.refresh_token).toBeTypeOf('string');

    const reusedCodeResponse = await ctx.callWorker('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode!,
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        code_verifier: verifier,
      }),
    });
    const reusedJson = await reusedCodeResponse.json() as Record<string, unknown>;
    expect(reusedJson.error).toBe('invalid_grant');
  });

  it('fails the callback when stable userinfo identity cannot be resolved', async () => {
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
      'https://openidconnect.googleapis.com/v1/userinfo': () => {
        throw new Error('userinfo temporarily unavailable');
      },
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const registration = await registerClient(ctx);
    const clientId = String(registration.json.client_id);

    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=calendar-only&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.write offline_access')}`);
    const authorizeHtml = await authorizeResponse.text();
    const csrfToken = extractHiddenInput(authorizeHtml, 'csrf_token');

    const postAuthorize = await ctx.callWorker('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        state: 'calendar-only',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'http://localhost:8787/mcp',
        scope: 'calendar.write offline_access',
        csrf_token: csrfToken,
      }),
      redirect: 'manual',
    });

    const state = new URL(postAuthorize.headers.get('location')!).searchParams.get('state');
    const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state!)}&code=google-auth-code`, { redirect: 'manual' });

    expect(callbackResponse.status).toBe(400);
    const body = await callbackResponse.json() as Record<string, unknown>;
    expect(body.error).toBe('google_identity_error');
  });

  it('does not escalate issued MCP scopes when Google returns previously granted extra scopes', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
    const challenge = await createS256CodeChallenge(verifier);
    const googleMock = createGoogleFetchMock({
      'https://oauth2.googleapis.com/token': jsonResponse({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 3600,
        scope: [
          'openid',
          'email',
          'profile',
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/calendar.events',
        ].join(' '),
        token_type: 'Bearer',
      }),
      'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
        sub: 'google-user-drive-123',
        email: 'me@example.com',
      }),
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const registration = await registerClient(ctx);
    const clientId = String(registration.json.client_id);

    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=drive-only&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('drive.write offline_access')}`);
    const authorizeHtml = await authorizeResponse.text();
    const csrfToken = extractHiddenInput(authorizeHtml, 'csrf_token');

    const postAuthorize = await ctx.callWorker('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: registration.redirectUri,
          state: 'drive-only',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: 'http://localhost:8787/mcp',
          scope: 'drive.write offline_access',
          csrf_token: csrfToken,
        }),
      redirect: 'manual',
    });

    const state = new URL(postAuthorize.headers.get('location')!).searchParams.get('state');
    const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state!)}&code=google-auth-code`, { redirect: 'manual' });
    expect(callbackResponse.status).toBe(302);
    const redirectBack = new URL(callbackResponse.headers.get('location')!);
    const authCode = redirectBack.searchParams.get('code');
    expect(authCode).toBeTruthy();

    const tokenResponse = await ctx.callWorker('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode!,
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        code_verifier: verifier,
        resource: 'http://localhost:8787/mcp',
      }),
    });

    expect(tokenResponse.status).toBe(200);
    const tokenJson = await tokenResponse.json() as Record<string, unknown>;
    expect(tokenJson.scope).toBe('drive.read drive.write offline_access');
  });

  it('does not allow authorize form upgrades beyond the client-requested scope set', async () => {
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
      'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
        sub: 'google-user-123',
        email: 'me@example.com',
      }),
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const registration = await registerClient(ctx);
    const clientId = String(registration.json.client_id);

    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=abc123&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.write offline_access')}`);
    const authorizeHtml = await authorizeResponse.text();
    const csrfToken = extractHiddenInput(authorizeHtml, 'csrf_token');

    const postAuthorize = await ctx.callWorker('/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: registration.redirectUri,
        state: 'abc123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'http://localhost:8787/mcp',
        scope: 'calendar.write offline_access',
        upgrade_scope: 'drive.write',
        csrf_token: csrfToken,
      }),
      redirect: 'manual',
    });

    expect(postAuthorize.status).toBe(302);
    const googleRedirect = new URL(postAuthorize.headers.get('location')!);
    const googleScopes = new Set((googleRedirect.searchParams.get('scope') ?? '').split(' ').filter(Boolean));
    expect(googleScopes.has('https://www.googleapis.com/auth/drive')).toBe(false);
  });

  it('stores reviewer-demo grants in a separate namespace from normal subject grants', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
    const challenge = await createS256CodeChallenge(verifier);
    const googleMock = createGoogleFetchMock({
      'https://oauth2.googleapis.com/token': jsonResponse({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 3600,
        scope: 'openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      }),
      'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
        sub: 'google-user-demo-123',
        email: 'me@example.com',
      }),
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const normal = await registerClient(ctx, 'https://chatgpt.com/connector/oauth/normal');
    await upsertOAuthClient(ctx.db, {
      clientId: 'reviewer-demo',
      redirectUri: 'http://localhost:8787/demo/oauth/callback',
      clientName: 'Reviewer Demo Client',
    });

    for (const [clientId, redirectUri, state, grantNamespace] of [
      [String(normal.json.client_id), normal.redirectUri, 'normal-state', undefined],
      ['reviewer-demo', 'http://localhost:8787/demo/oauth/callback', 'demo-state', 'demo'],
    ] as const) {
      const authorizeUrl = new URL('/authorize', 'http://localhost:8787');
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('resource', 'http://localhost:8787/mcp');
      authorizeUrl.searchParams.set('scope', 'calendar.write offline_access');
      if (grantNamespace) authorizeUrl.searchParams.set('grant_namespace', grantNamespace);

      const authorizeResponse = await ctx.callWorker(`${authorizeUrl.pathname}${authorizeUrl.search}`);
      const csrfToken = extractHiddenInput(await authorizeResponse.text(), 'csrf_token');

      const body = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'http://localhost:8787/mcp',
        scope: 'calendar.write offline_access',
        csrf_token: csrfToken,
      });
      if (grantNamespace) body.set('grant_namespace', grantNamespace);

      const postAuthorize = await ctx.callWorker('/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });

      const oauthState = new URL(postAuthorize.headers.get('location')!).searchParams.get('state');
      await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(oauthState!)}&code=google-auth-code-${state}`, { redirect: 'manual' });
    }

    const normalGrant = await getGrantBySubject(ctx.db, 'google-user-demo-123');
    const demoGrant = await getGrantBySubjectNamespace(ctx.db, 'google-user-demo-123', 'demo');
    expect(normalGrant).not.toBeNull();
    expect(demoGrant).not.toBeNull();
    expect(normalGrant?.grant_id).not.toBe(demoGrant?.grant_id);
  });
});
