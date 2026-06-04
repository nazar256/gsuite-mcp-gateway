import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/env';
import { parseConfig } from '../../src/config';
import { buildGoogleAuthorizationUrl, createStoredGoogleTokenSet, googleTokenSetNeedsRefresh, resolveGoogleIdentity } from '../../src/google/oauth';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';

describe('google oauth helpers', () => {
  const config = parseConfig(createTestEnv());

  it('builds google auth url', () => {
    const url = new URL(buildGoogleAuthorizationUrl(config, {
      state: 'state123',
      googleScopes: ['email', 'openid', 'scope:a', 'scope:b'],
    }));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('scope')).toBe('email openid scope:a scope:b');
    expect(url.searchParams.get('access_type')).toBeNull();
  });

  it('requests offline google access only when asked', () => {
    const url = new URL(buildGoogleAuthorizationUrl(config, {
      state: 'state123',
      googleScopes: ['email', 'openid'],
      requestOfflineAccess: true,
    }));

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('merges stored token state', () => {
    const tokenSet = createStoredGoogleTokenSet({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'scope:a scope:b',
      token_type: 'Bearer',
    }, ['scope:a'], { subject: 'abc', email: 'me@example.com' });

    expect(tokenSet.refreshToken).toBe('refresh-1');
    expect(tokenSet.grantedGoogleScopes).toEqual(['scope:a', 'scope:b']);
  });

  it('does not retain broader existing scopes when a new token response is narrower', () => {
    const tokenSet = createStoredGoogleTokenSet({
      access_token: 'access-2',
      expires_in: 3600,
      scope: 'scope:a',
      token_type: 'Bearer',
    }, ['scope:a'], { subject: 'abc', email: 'me@example.com' }, {
      v: 1,
      accessToken: 'old-access',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiryDate: new Date(Date.now() + 3600_000).toISOString(),
      grantedGoogleScopes: ['scope:a', 'scope:b'],
      googleSubject: 'abc',
      googleEmail: 'me@example.com',
    });

    expect(tokenSet.grantedGoogleScopes).toEqual(['scope:a']);
    expect(tokenSet.refreshToken).toBe('refresh-1');
  });

  it('detects refresh window', () => {
    expect(googleTokenSetNeedsRefresh({
      v: 1,
      accessToken: 'x',
      tokenType: 'Bearer',
      expiryDate: new Date(Date.now() + 30_000).toISOString(),
      grantedGoogleScopes: [],
      googleEmail: null,
    })).toBe(true);
  });

  it('fails if stable userinfo identity cannot be fetched', async () => {
    const googleMock = createGoogleFetchMock({
      'https://openidconnect.googleapis.com/v1/userinfo': () => {
        throw new Error('userinfo network failure');
      },
    });

    await expect(resolveGoogleIdentity(
      parseConfig(createTestEnv({ fetch: googleMock.fetch })),
      'google-access-token',
    )).rejects.toThrow(/Could not determine Google account identity from OpenID Connect userinfo/);

    expect(googleMock.requests[0]?.url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(googleMock.requests[0]?.headers.authorization).toBe('Bearer google-access-token');
    expect(googleMock.requests[0]?.url).not.toContain('google-access-token');
  });
});
