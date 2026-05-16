import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerTestContext } from '../helpers/worker';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { restoreTime, useFixedTime } from '../helpers/time';
import { createS256CodeChallenge } from '../../src/oauth/pkce';

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
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events.freebusy',
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
    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=abc123&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.read offline_access')}`);
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
        scope: 'calendar.read offline_access',
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
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.events.freebusy',
        token_type: 'Bearer',
      }),
      'https://openidconnect.googleapis.com/v1/userinfo': () => {
        throw new Error('userinfo temporarily unavailable');
      },
    });

    const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
    const registration = await registerClient(ctx);
    const clientId = String(registration.json.client_id);

    const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&state=calendar-only&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent('calendar.read offline_access')}`);
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
        scope: 'calendar.read offline_access',
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
});
