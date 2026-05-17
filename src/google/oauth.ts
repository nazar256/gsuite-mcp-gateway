import type { AppConfig } from '../config';
import { HttpError } from '../security/errors';
import { getGrantById, revokeGrant, upsertGrant, type GrantRecord } from '../storage/grants';
import type { DbLike } from '../storage/d1';
import { expectGoogleJson } from './errors';
import { inferGrantedMcpScopes, normalizeGrantedMcpScope } from '../oauth/scopes';
import { decryptJson, encryptJson } from '../security/crypto';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  refresh_token_expires_in?: number;
}

export interface StoredGoogleTokenSet {
  v: 1;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiryDate: string;
  grantedGoogleScopes: string[];
  googleSubject?: string;
  googleEmail?: string | null;
}

export interface GoogleIdentity {
  subject: string;
  email?: string | null;
}

function logIdentityProbeFailure(probe: string, error: unknown): void {
  console.warn('google_identity_probe_failed', {
    probe,
    error_name: error instanceof Error ? error.name : typeof error,
  });
}

export async function decryptStoredGoogleTokenSet(
  config: AppConfig,
  grant: Pick<GrantRecord, 'grant_id' | 'subject'> & { parsed_envelope: Parameters<typeof decryptJson>[0] },
): Promise<StoredGoogleTokenSet> {
  return decryptJson<StoredGoogleTokenSet>(grant.parsed_envelope, config.tokenEncryptionKey, {
    grant_id: grant.grant_id,
    subject: grant.subject,
    kind: 'google_tokens',
  });
}

function googleScopesFromResponse(response: GoogleTokenResponse, fallback: string[]): string[] {
  return [...new Set((response.scope?.split(/\s+/).filter(Boolean) ?? fallback))].sort();
}

function addSeconds(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

export function buildGoogleAuthorizationUrl(config: AppConfig, params: {
  state: string;
  googleScopes: string[];
  promptConsent?: boolean;
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', config.googleCallbackUrl);
  url.searchParams.set('scope', params.googleScopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', params.state);
  if (params.promptConsent ?? true) {
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(
  config: AppConfig,
  code: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: config.googleCallbackUrl,
    grant_type: 'authorization_code',
  });

  const response = await config.fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  return expectGoogleJson<GoogleTokenResponse>(response);
}

export async function refreshGoogleAccessToken(
  config: AppConfig,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await config.fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  return expectGoogleJson<GoogleTokenResponse>(response);
}

export async function resolveGoogleIdentity(
  config: AppConfig,
  accessToken: string,
): Promise<GoogleIdentity> {
  try {
    const tokenInfoResponse = await config.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (tokenInfoResponse.ok) {
        const tokenInfo = await expectGoogleJson<{ sub?: string; email?: string }>(tokenInfoResponse);
      const subject = tokenInfo.sub;
      if (subject) {
        return { subject, email: tokenInfo.email ?? null };
      }
    }
  } catch (error) {
    logIdentityProbeFailure('userinfo', error);
  }

  throw new HttpError(400, 'google_identity_error', 'Could not determine Google account identity from OpenID Connect userinfo');
}

export function createStoredGoogleTokenSet(
  response: GoogleTokenResponse,
  fallbackGoogleScopes: string[],
  identity?: GoogleIdentity,
  existing?: StoredGoogleTokenSet,
): StoredGoogleTokenSet {
  const grantedGoogleScopes = googleScopesFromResponse(response, fallbackGoogleScopes);

  const refreshToken = response.refresh_token ?? existing?.refreshToken;
  const googleSubject = identity?.subject ?? existing?.googleSubject;

  return {
    v: 1,
    accessToken: response.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    tokenType: response.token_type ?? existing?.tokenType ?? 'Bearer',
    expiryDate: addSeconds(response.expires_in ?? 3600),
    grantedGoogleScopes,
    ...(googleSubject ? { googleSubject } : {}),
    googleEmail: identity?.email ?? existing?.googleEmail ?? null,
  };
}

export function googleTokenSetNeedsRefresh(tokenSet: StoredGoogleTokenSet): boolean {
  return Date.parse(tokenSet.expiryDate) - Date.now() <= 60_000;
}

export async function refreshGrantGoogleTokens(
  db: DbLike,
  config: AppConfig,
  grant: GrantRecord,
  tokenSet: StoredGoogleTokenSet,
): Promise<StoredGoogleTokenSet> {
  if (!tokenSet.refreshToken) {
    throw new HttpError(401, 'invalid_token', 'Google grant cannot be refreshed without offline access');
  }

  try {
    const refreshed = await refreshGoogleAccessToken(config, tokenSet.refreshToken);
    const nextTokenSet = createStoredGoogleTokenSet(refreshed, tokenSet.grantedGoogleScopes, {
      subject: tokenSet.googleSubject ?? grant.subject,
      ...(tokenSet.googleEmail !== undefined ? { email: tokenSet.googleEmail } : {}),
    }, tokenSet);

    const existingGrantScopes = new Set(grant.granted_mcp_scopes.split(' ').filter(Boolean));
    const grantedMcpScopes = inferGrantedMcpScopes(config, nextTokenSet.grantedGoogleScopes)
      .filter((scope) => existingGrantScopes.has(scope));
    if (nextTokenSet.refreshToken && existingGrantScopes.has('offline_access')) {
      grantedMcpScopes.push('offline_access');
    }
    grantedMcpScopes.sort();

    await upsertGrant(db, {
      grantId: grant.grant_id,
      subject: grant.subject,
      encryptedGoogleTokens: await encryptJson(nextTokenSet, config.tokenEncryptionKey, {
        grant_id: grant.grant_id,
        subject: grant.subject,
        kind: 'google_tokens',
      }),
      grantedMcpScopes: normalizeGrantedMcpScope(grantedMcpScopes.join(' ')),
      grantedGoogleScopes: nextTokenSet.grantedGoogleScopes.join(' '),
    });

    return nextTokenSet;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'invalid_token') {
      await revokeGrant(db, grant.grant_id);
    }
    throw error;
  }
}

export async function loadFreshGoogleTokenSet(
  db: DbLike,
  config: AppConfig,
  grantId: string,
): Promise<{ grant: GrantRecord; tokenSet: StoredGoogleTokenSet }> {
  const grant = await getGrantById(db, grantId);
  if (!grant || grant.revoked_at) {
    throw new HttpError(401, 'invalid_token', 'Grant is not available');
  }

  const tokenSet = await decryptStoredGoogleTokenSet(config, grant);
  if (!googleTokenSetNeedsRefresh(tokenSet)) {
    return { grant, tokenSet };
  }

  const refreshed = await refreshGrantGoogleTokens(db, config, grant, tokenSet);
  const updatedGrant = await getGrantById(db, grantId);
  return { grant: updatedGrant ?? grant, tokenSet: refreshed };
}
