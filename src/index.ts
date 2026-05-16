import type { AppConfig, Env } from './config';
import { parseConfig } from './config';
import { handleAuthorizeGet, handleAuthorizePost } from './oauth/authorize';
import { handleGoogleCallback, handleGoogleStart } from './oauth/google';
import { getAuthorizationServerMetadata, getProtectedResourceMetadata, buildWwwAuthenticate } from './oauth/metadata';
import { handleRegister } from './oauth/register';
import { handleToken } from './oauth/token';
import { handleMcpRequest, withCors } from './mcp/handler';
import { asHttpError } from './security/errors';
import { redactUrl } from './security/redaction';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(headers ? Object.fromEntries(new Headers(headers).entries()) : {}),
    },
  });
}

function serviceInfoResponse(config?: AppConfig, error?: ReturnType<typeof asHttpError>): Response {
  return jsonResponse({
    service: 'gsuite-mcp-gateway',
    runtime: 'cloudflare-workers',
    transport: 'streamable-http',
    mcp_path: '/mcp',
    oauth_issuer: config?.issuer,
    healthy: !error,
    config_error: error ? { code: error.code, message: error.message } : undefined,
  });
}

function healthResponse(error?: ReturnType<typeof asHttpError>): Response {
  return jsonResponse(error ? { ok: false, error: { code: error.code, message: error.message } } : { ok: true }, error ? 500 : 200);
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  let config: AppConfig | undefined;
  let configError: ReturnType<typeof asHttpError> | undefined;

  try {
    config = parseConfig(env);
  } catch (error) {
    configError = asHttpError(error);
  }

  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }));
  }

  if (url.pathname === '/') {
    return serviceInfoResponse(config, configError);
  }

  if (url.pathname === '/health') {
    return healthResponse(configError);
  }

  if (!config || configError) {
    throw configError ?? new Error('Configuration is invalid');
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    return jsonResponse(getProtectedResourceMetadata(config), 200, { 'cache-control': 'no-store' });
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    return jsonResponse(getProtectedResourceMetadata(config), 200, { 'cache-control': 'no-store' });
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return jsonResponse(getAuthorizationServerMetadata(config), 200, { 'cache-control': 'no-store' });
  }

  if (request.method === 'POST' && url.pathname === '/register') {
    return handleRegister(request, config, env.DB);
  }

  if (request.method === 'GET' && url.pathname === '/authorize') {
    return handleAuthorizeGet(request, config, env.DB);
  }

  if (request.method === 'POST' && url.pathname === '/authorize') {
    return handleAuthorizePost(request, config, env.DB);
  }

  if (request.method === 'GET' && url.pathname === '/oauth/google/start') {
    return handleGoogleStart();
  }

  if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
    return handleGoogleCallback(request, config, env.DB);
  }

  if (request.method === 'POST' && url.pathname === '/token') {
    return handleToken(request, config, env.DB);
  }

  if (['GET', 'POST', 'DELETE'].includes(request.method) && url.pathname === '/mcp') {
    const auth = request.headers.get('authorization');
    if (!auth?.startsWith('Bearer ')) {
      return withCors(new Response(JSON.stringify({ error: 'invalid_token', error_description: 'A valid bearer token is required' }), {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': buildWwwAuthenticate(config),
        },
      }));
    }
    return handleMcpRequest(request, config, env.DB);
  }

  return jsonResponse({ error: 'not_found', error_description: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      const httpError = asHttpError(error);
      console.error('request_failed', {
        method: request.method,
        url: redactUrl(request.url),
        status: httpError.status,
        code: httpError.code,
      });
      return jsonResponse({ error: httpError.code, error_description: httpError.message }, httpError.status, httpError.headers);
    }
  },
};
