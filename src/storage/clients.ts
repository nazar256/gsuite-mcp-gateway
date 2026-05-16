import type { DbLike } from './d1';
import { getFirst, isoNow, runStatement } from './d1';

export interface OAuthClientRecord {
  client_id: string;
  redirect_uri: string;
  client_name: string | null;
  created_at: string;
}

export async function getOAuthClient(db: DbLike, clientId: string): Promise<OAuthClientRecord | null> {
  return getFirst<OAuthClientRecord>(
    db.prepare('SELECT client_id, redirect_uri, client_name, created_at FROM oauth_clients WHERE client_id = ?').bind(clientId),
  );
}

export async function upsertOAuthClient(
  db: DbLike,
  input: { clientId: string; redirectUri: string; clientName?: string },
): Promise<OAuthClientRecord> {
  const createdAt = isoNow();
  await runStatement(
    db.prepare(`
      INSERT INTO oauth_clients (client_id, redirect_uri, client_name, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        redirect_uri = excluded.redirect_uri,
        client_name = excluded.client_name
    `).bind(input.clientId, input.redirectUri, input.clientName ?? null, createdAt),
  );

  return {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    client_name: input.clientName ?? null,
    created_at: createdAt,
  };
}
