import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AppConfig } from '../config';
import type { DbLike } from '../storage/d1';
import { validateOrigin } from '../oauth/validation';
import { asHttpError } from '../security/errors';
import { loadMcpAuthContext, unauthorizedResponse } from './auth';
import { createGatewayMcpServer } from './server';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age': '86400',
};

export function withCors(response: Response): Response {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!next.headers.has(key)) {
      next.headers.set(key, value);
    }
  }
  return next;
}

export async function handleMcpRequest(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  try {
    validateOrigin(request.headers.get('origin'), config);
    const authContext = await loadMcpAuthContext(request, config, db);
    const server = createGatewayMcpServer(config, {
      googleAccessToken: authContext.googleAccessToken,
      grantedScope: authContext.grantedScope,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const parsedBody = request.method === 'POST' ? await request.clone().json().catch(() => undefined) : undefined;
      const response = await transport.handleRequest(request, parsedBody !== undefined ? { parsedBody } : undefined);
      return withCors(response);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  } catch (error) {
    const httpError = asHttpError(error);
    if (httpError.status === 401) {
      return withCors(unauthorizedResponse(config));
    }
    const response = new Response(JSON.stringify({ error: httpError.code, error_description: httpError.message }), {
      status: httpError.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(httpError.headers ? Object.fromEntries(new Headers(httpError.headers).entries()) : {}),
      },
    });
    return withCors(response);
  }
}
