import type { AppConfig } from '../config';
import { matchesPattern } from '../config';
import { HttpError } from '../security/errors';
import { normalizeMcpScope } from './scopes';
import { validateCodeChallenge, validateCodeChallengeMethod } from './pkce';

export interface OAuthAuthorizationRequest {
  responseType: 'code';
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  scope: string;
  grantNamespace?: string;
}

export interface RegistrationRequest {
  redirectUris: [string];
  clientName?: string;
  tokenEndpointAuthMethod: 'none';
  grantTypes: ('authorization_code' | 'refresh_token')[];
  responseTypes: ['code'];
}

export function validateRedirectUri(raw: string, config: AppConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_redirect_uri', 'redirect_uri must be a valid URL');
  }

  const isLoopback = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new HttpError(400, 'invalid_redirect_uri', 'redirect_uri must use HTTPS or localhost HTTP');
  }

  const sameOriginDemoCallback = url.origin === config.issuerUrl.origin && url.pathname === '/demo/oauth/callback';
  if (sameOriginDemoCallback) {
    return url;
  }

  if (!matchesPattern(url.toString(), config.redirectUriAllowlist)) {
    throw new HttpError(400, 'invalid_redirect_uri', 'redirect_uri is not allowlisted');
  }

  return url;
}

export function validateOrigin(origin: string | null, config: AppConfig): void {
  if (!origin) {
    return;
  }

  if (!matchesPattern(origin, config.allowedOrigins)) {
    throw new HttpError(403, 'forbidden_origin', 'Origin is not allowed');
  }
}

export function validateResource(resource: string | null | undefined, config: AppConfig): string {
  const requested = resource?.trim() || config.mcpResource;
  if (requested !== config.mcpResource) {
    throw new HttpError(400, 'invalid_target', 'Requested resource is not supported');
  }
  return requested;
}

export function validateClientIdentifier(clientId: string | null | undefined): string {
  const normalized = clientId?.trim();
  if (!normalized) {
    throw new HttpError(400, 'invalid_client', 'client_id is required');
  }
  return normalized;
}

export function validateResponseType(responseType: string | null | undefined): 'code' {
  if (responseType !== 'code') {
    throw new HttpError(400, 'unsupported_response_type', 'response_type must be code');
  }
  return 'code';
}

export function validateOptionalState(state: string | null | undefined): string | undefined {
  const normalized = state?.trim();
  return normalized ? normalized : undefined;
}

export function parseAuthorizationRequest(request: Request, config: AppConfig): OAuthAuthorizationRequest {
  const url = new URL(request.url);

  try {
    const state = validateOptionalState(url.searchParams.get('state'));
    const grantNamespace = validateOptionalState(url.searchParams.get('grant_namespace'));
    return {
      responseType: validateResponseType(url.searchParams.get('response_type')),
      clientId: validateClientIdentifier(url.searchParams.get('client_id')),
      redirectUri: validateRedirectUri(url.searchParams.get('redirect_uri') ?? '', config).toString(),
      ...(state ? { state } : {}),
      codeChallenge: validateCodeChallenge(url.searchParams.get('code_challenge')),
      codeChallengeMethod: validateCodeChallengeMethod(url.searchParams.get('code_challenge_method')),
      resource: validateResource(url.searchParams.get('resource'), config),
      scope: normalizeMcpScope(url.searchParams.get('scope')),
      ...(grantNamespace ? { grantNamespace } : {}),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_request', error instanceof Error ? error.message : 'Authorization request is invalid');
  }
}

export function parseAuthorizationForm(fields: URLSearchParams, config: AppConfig): OAuthAuthorizationRequest {
  try {
    const state = validateOptionalState(fields.get('state'));
    const grantNamespace = validateOptionalState(fields.get('grant_namespace'));
    return {
      responseType: validateResponseType(fields.get('response_type')),
      clientId: validateClientIdentifier(fields.get('client_id')),
      redirectUri: validateRedirectUri(fields.get('redirect_uri') ?? '', config).toString(),
      ...(state ? { state } : {}),
      codeChallenge: validateCodeChallenge(fields.get('code_challenge')),
      codeChallengeMethod: validateCodeChallengeMethod(fields.get('code_challenge_method')),
      resource: validateResource(fields.get('resource'), config),
      scope: normalizeMcpScope(fields.get('scope')),
      ...(grantNamespace ? { grantNamespace } : {}),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_request', error instanceof Error ? error.message : 'Authorization form is invalid');
  }
}

export function parseRegistrationRequest(body: unknown, config: AppConfig): RegistrationRequest {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'invalid_client_metadata', 'Registration body must be a JSON object');
  }

  const redirectUris = (body as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length !== 1 || typeof redirectUris[0] !== 'string') {
    throw new HttpError(400, 'invalid_redirect_uri', 'Exactly one redirect URI is required');
  }

  validateRedirectUri(redirectUris[0], config);

  const tokenEndpointAuthMethod = ((body as { token_endpoint_auth_method?: unknown }).token_endpoint_auth_method ?? 'none');
  if (tokenEndpointAuthMethod !== 'none') {
    throw new HttpError(400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none');
  }

  const clientName = typeof (body as { client_name?: unknown }).client_name === 'string'
    ? (body as { client_name?: string }).client_name?.trim() || undefined
    : undefined;

  return {
    redirectUris: [redirectUris[0]],
    ...(clientName ? { clientName } : {}),
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  };
}
