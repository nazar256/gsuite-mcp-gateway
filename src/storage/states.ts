import type { EncryptedEnvelope } from '../security/crypto';
import { parseEnvelope, stringifyEnvelope } from '../security/crypto';
import type { DbLike } from './d1';
import { getFirst, isoNow, runStatement } from './d1';

export interface StoredStateRecord {
  state_id: string;
  encrypted_payload: string;
  expires_at: string;
  created_at: string;
}

export async function createOAuthState(
  db: DbLike,
  input: { stateId: string; encryptedPayload: EncryptedEnvelope; expiresAt: string },
): Promise<void> {
  await runStatement(
    db.prepare('INSERT INTO oauth_states (state_id, encrypted_payload, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(input.stateId, stringifyEnvelope(input.encryptedPayload), input.expiresAt, isoNow()),
  );
}

export async function getOAuthState(db: DbLike, stateId: string): Promise<(StoredStateRecord & { parsed_envelope: EncryptedEnvelope }) | null> {
  const row = await getFirst<StoredStateRecord>(
    db.prepare('SELECT state_id, encrypted_payload, expires_at, created_at FROM oauth_states WHERE state_id = ?').bind(stateId),
  );

  if (!row) return null;
  return { ...row, parsed_envelope: parseEnvelope(row.encrypted_payload) };
}

export async function deleteOAuthState(db: DbLike, stateId: string): Promise<void> {
  await runStatement(db.prepare('DELETE FROM oauth_states WHERE state_id = ?').bind(stateId));
}

export async function cleanupExpiredStates(db: DbLike, nowIso: string): Promise<void> {
  await runStatement(db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(nowIso));
}
