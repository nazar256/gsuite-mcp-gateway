import type { AppConfig } from '../config';
import { buildWwwAuthenticate } from '../oauth/metadata';
import { hasScope } from '../oauth/scopes';
import { HttpError } from '../security/errors';
import { verifyWorkerAccessToken } from '../oauth/token';
import type { DbLike } from '../storage/d1';
import { loadFreshGoogleTokenSet } from '../google/oauth';

export interface McpAuthContext {
  accessTokenClaims: Awaited<ReturnType<typeof verifyWorkerAccessToken>>;
  grantedScope: string;
  googleAccessToken: string;
}

function getBearerTokenFromAuthorizationHeader(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null;
  }

  const token = rest.join(' ').trim();
  return token || null;
}

export function unauthorizedResponse(config: AppConfig, scope = config.supportedScopes.join(' '), wwwAuthenticate?: string): Response {
  return new Response(
    JSON.stringify({
      error: 'invalid_token',
      error_description: 'A valid bearer token is required',
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate': wwwAuthenticate ?? buildWwwAuthenticate(config, scope),
      },
    },
  );
}

export function parseBearerToken(request: Request): string | null {
  return getBearerTokenFromAuthorizationHeader(request.headers.get('authorization'));
}

export async function loadMcpAuthContext(request: Request, config: AppConfig, db: DbLike): Promise<McpAuthContext> {
  const token = parseBearerToken(request);
  if (!token) {
    throw new HttpError(401, 'invalid_token', 'A valid bearer token is required', {
      headers: { 'www-authenticate': buildWwwAuthenticate(config) },
    });
  }

  const accessTokenClaims = await verifyWorkerAccessToken(token, config);
  const { grant, tokenSet } = await loadFreshGoogleTokenSet(db, config, accessTokenClaims.grant_id);

  return {
    accessTokenClaims,
    grantedScope: grant.granted_mcp_scopes,
    googleAccessToken: tokenSet.accessToken,
  };
}

export function ensureRequiredScope(config: AppConfig, grantedScope: string, requiredScope: string): void {
  if (!hasScope(grantedScope, requiredScope)) {
    throw new HttpError(403, 'insufficient_scope', `${requiredScope} scope is required`, {
      mcpWwwAuthenticate: [buildWwwAuthenticate(config, requiredScope, 'insufficient_scope', `${requiredScope} scope is required`)],
    });
  }
}
