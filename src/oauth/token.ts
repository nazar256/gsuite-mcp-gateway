import type { AppConfig } from '../config';
import { decryptJson, sha256Hex } from '../security/crypto';
import { HttpError } from '../security/errors';
import { signJwt, verifyJwt } from '../security/jwt';
import { consumeOAuthCode, getOAuthCode } from '../storage/codes';
import type { DbLike } from '../storage/d1';
import { getGrantById } from '../storage/grants';
import { decryptStoredGoogleTokenSet } from '../google/oauth';
import { validateCodeVerifier, createS256CodeChallenge } from './pkce';
import type { AuthorizationCodePayload, WorkerAccessTokenClaims, WorkerRefreshTokenClaims } from './types';
import { getOAuthClient } from '../storage/clients';
import { intersectMcpScopes } from './scopes';

async function parseTokenFields(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await request.text());
  }

  if (contentType.includes('application/json')) {
    const body = await request.json() as Record<string, unknown>;
    const fields = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        fields.set(key, String(value));
      }
    }
    return fields;
  }

  throw new HttpError(400, 'invalid_request', 'Unsupported token request content type');
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function issueAccessToken(config: AppConfig, claims: Omit<WorkerAccessTokenClaims, 'iss' | 'aud' | 'typ' | 'iat' | 'exp'>): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: WorkerAccessTokenClaims = {
    typ: 'access_token',
    iss: config.issuer,
    aud: config.mcpAudience,
    iat: now,
    exp: now + config.accessTokenTtlSeconds,
    ...claims,
  };
  return {
    token: await signJwt(payload as unknown as Record<string, unknown>, config.jwtSigningKey),
    expiresIn: config.accessTokenTtlSeconds,
  };
}

async function issueRefreshToken(config: AppConfig, claims: Omit<WorkerRefreshTokenClaims, 'iss' | 'aud' | 'typ' | 'iat' | 'exp'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: WorkerRefreshTokenClaims = {
    typ: 'refresh_token',
    iss: config.issuer,
    aud: `${config.issuer}/token`,
    iat: now,
    exp: now + config.refreshTokenTtlSeconds,
    ...claims,
  };
  return signJwt(payload as unknown as Record<string, unknown>, config.jwtSigningKey);
}

export async function verifyWorkerAccessToken(token: string, config: AppConfig): Promise<WorkerAccessTokenClaims> {
  const claims = await verifyJwt<WorkerAccessTokenClaims & Record<string, unknown>>(token, config.jwtSigningKey, {
    issuer: config.issuer,
    audience: config.mcpAudience,
    typ: 'access_token',
  });
  if (claims.resource !== config.mcpResource) {
    throw new HttpError(401, 'invalid_token', 'Token resource is invalid');
  }
  return claims;
}

async function handleAuthorizationCodeGrant(fields: URLSearchParams, config: AppConfig, db: DbLike): Promise<Response> {
  const code = fields.get('code');
  const clientId = fields.get('client_id');
  const redirectUri = fields.get('redirect_uri');
  const codeVerifier = fields.get('code_verifier');
  const requestedResource = fields.get('resource') ?? config.mcpResource;

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    throw new HttpError(400, 'invalid_request', 'code, client_id, redirect_uri, and code_verifier are required');
  }

  const client = await getOAuthClient(db, clientId);
  if (!client || client.redirect_uri !== redirectUri) {
    throw new HttpError(400, 'invalid_client', 'client_id or redirect_uri is invalid');
  }

  const codeHash = await sha256Hex(code);
  const storedCode = await getOAuthCode(db, codeHash);
  if (!storedCode) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code is invalid');
  }
  if (storedCode.used_at) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code was already used');
  }
  if (Date.parse(storedCode.expires_at) <= Date.now()) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code is expired');
  }

  const payload = await decryptJson<AuthorizationCodePayload>(storedCode.parsed_envelope, config.tokenEncryptionKey, {
    kind: 'oauth_code',
    code_hash: codeHash,
    client_id: clientId,
  });

  if (payload.redirectUri !== redirectUri || payload.clientId !== clientId) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code does not match the client');
  }
  if (payload.resource !== requestedResource) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code resource does not match');
  }

  let verifier: string;
  try {
    verifier = validateCodeVerifier(codeVerifier);
  } catch {
    throw new HttpError(400, 'invalid_request', 'code_verifier is invalid');
  }
  const expectedChallenge = await createS256CodeChallenge(verifier);
  if (payload.codeChallengeMethod !== 'S256' || payload.codeChallenge !== expectedChallenge) {
    console.warn('pkce_verification_failed', {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_hash: codeHash,
      method: payload.codeChallengeMethod,
    });
    throw new HttpError(400, 'invalid_grant', 'PKCE verification failed');
  }

  const consumed = await consumeOAuthCode(db, codeHash);
  if (!consumed) {
    throw new HttpError(400, 'invalid_grant', 'Authorization code was already used');
  }

  const grant = await getGrantById(db, payload.grantId);
  if (!grant || grant.revoked_at) {
    throw new HttpError(400, 'invalid_grant', 'Grant is not active');
  }

  const access = await issueAccessToken(config, {
    sub: payload.subject,
    client_id: clientId,
    scope: payload.scope,
    resource: payload.resource,
    grant_id: payload.grantId,
  });

  const tokenSet = await decryptStoredGoogleTokenSet(config, grant);
  const response: Record<string, unknown> = {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    scope: payload.scope,
  };

  if (tokenSet?.refreshToken && payload.scope.split(' ').includes('offline_access')) {
    response.refresh_token = await issueRefreshToken(config, {
      sub: payload.subject,
      client_id: clientId,
      grant_id: payload.grantId,
      scope: payload.scope,
      resource: payload.resource,
    });
  }

  return tokenResponse(response);
}

async function handleRefreshTokenGrant(fields: URLSearchParams, config: AppConfig, db: DbLike): Promise<Response> {
  const refreshToken = fields.get('refresh_token');
  const clientId = fields.get('client_id');
  if (!refreshToken || !clientId) {
    throw new HttpError(400, 'invalid_request', 'refresh_token and client_id are required');
  }

  const client = await getOAuthClient(db, clientId);
  if (!client) {
    throw new HttpError(400, 'invalid_client', 'Unknown client_id');
  }

  const claims = await verifyJwt<WorkerRefreshTokenClaims & Record<string, unknown>>(refreshToken, config.jwtSigningKey, {
    issuer: config.issuer,
    audience: `${config.issuer}/token`,
    typ: 'refresh_token',
    status: 400,
    code: 'invalid_grant',
    message: 'Refresh token is invalid',
  });
  if (claims.client_id !== clientId) {
    throw new HttpError(400, 'invalid_grant', 'Refresh token client does not match');
  }
  if (claims.resource !== config.mcpResource) {
    throw new HttpError(400, 'invalid_grant', 'Refresh token resource does not match');
  }

  const grant = await getGrantById(db, claims.grant_id);
  if (!grant || grant.revoked_at) {
    throw new HttpError(400, 'invalid_grant', 'Grant is no longer active');
  }

  const currentScope = intersectMcpScopes(claims.scope, grant.granted_mcp_scopes);
  if (!currentScope) {
    throw new HttpError(400, 'invalid_grant', 'Refresh token no longer grants any active scope');
  }

  const access = await issueAccessToken(config, {
    sub: claims.sub,
    client_id: clientId,
    scope: currentScope,
    resource: claims.resource,
    grant_id: claims.grant_id,
  });

  const response: Record<string, unknown> = {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
    scope: currentScope,
  };

  const tokenSet = await decryptStoredGoogleTokenSet(config, grant);
  if (tokenSet?.refreshToken && currentScope.split(' ').includes('offline_access')) {
    response.refresh_token = await issueRefreshToken(config, {
      sub: claims.sub,
      client_id: clientId,
      grant_id: claims.grant_id,
      scope: currentScope,
      resource: claims.resource,
    });
  }

  return tokenResponse(response);
}

export async function handleToken(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  try {
    const fields = await parseTokenFields(request);
    const grantType = fields.get('grant_type');
    if (grantType === 'authorization_code') {
      return handleAuthorizationCodeGrant(fields, config, db);
    }
    if (grantType === 'refresh_token') {
      return handleRefreshTokenGrant(fields, config, db);
    }
    throw new HttpError(400, 'unsupported_grant_type', 'Unsupported grant_type');
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Internal server error');
    return tokenResponse({ error: httpError.code, error_description: httpError.message }, httpError.status);
  }
}
