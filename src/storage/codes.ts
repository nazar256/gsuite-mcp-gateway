import type { EncryptedEnvelope } from '../security/crypto';
import { parseEnvelope, stringifyEnvelope } from '../security/crypto';
import type { DbLike } from './d1';
import { getFirst, isoNow, runStatement } from './d1';

export interface OAuthCodeRecord {
  code_hash: string;
  encrypted_payload: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export async function createOAuthCode(
  db: DbLike,
  input: { codeHash: string; encryptedPayload: EncryptedEnvelope; expiresAt: string },
): Promise<void> {
  await runStatement(
    db.prepare('INSERT INTO oauth_codes (code_hash, encrypted_payload, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)')
      .bind(input.codeHash, stringifyEnvelope(input.encryptedPayload), input.expiresAt, isoNow()),
  );
}

export async function getOAuthCode(db: DbLike, codeHash: string): Promise<(OAuthCodeRecord & { parsed_envelope: EncryptedEnvelope }) | null> {
  const row = await getFirst<OAuthCodeRecord>(
    db.prepare('SELECT code_hash, encrypted_payload, expires_at, used_at, created_at FROM oauth_codes WHERE code_hash = ?').bind(codeHash),
  );

  if (!row) return null;
  return { ...row, parsed_envelope: parseEnvelope(row.encrypted_payload) };
}

export async function consumeOAuthCode(db: DbLike, codeHash: string): Promise<boolean> {
  const result = await db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(isoNow(), codeHash).run();
  return Number((result.meta?.changes as number | undefined) ?? 0) === 1;
}

export async function cleanupExpiredCodes(db: DbLike, nowIso: string): Promise<void> {
  await runStatement(db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(nowIso));
}
