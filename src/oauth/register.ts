import type { AppConfig } from '../config';
import { sha256Hex } from '../security/crypto';
import { HttpError } from '../security/errors';
import { getOAuthClient, upsertOAuthClient } from '../storage/clients';
import type { DbLike } from '../storage/d1';
import { parseRegistrationRequest } from './validation';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function deriveClientId(redirectUri: string): Promise<string> {
  return `gsuite-public-${await sha256Hex(redirectUri)}`;
}

export async function handleRegister(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'invalid_client_metadata', 'Registration body must be valid JSON');
  }

  const parsed = parseRegistrationRequest(body, config);
  const clientId = await deriveClientId(parsed.redirectUris[0]);
  const existing = await getOAuthClient(db, clientId);
  const record = existing ?? await upsertOAuthClient(db, {
    clientId,
    redirectUri: parsed.redirectUris[0],
    ...(parsed.clientName ? { clientName: parsed.clientName } : {}),
  });

  return jsonResponse({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(record.created_at) / 1000),
    client_secret_expires_at: 0,
    redirect_uris: parsed.redirectUris,
    ...(parsed.clientName ? { client_name: parsed.clientName } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: parsed.grantTypes,
    response_types: parsed.responseTypes,
  }, 201);
}
