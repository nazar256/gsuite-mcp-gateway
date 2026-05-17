import type { EncryptedEnvelope } from '../security/crypto';
import { parseEnvelope, stringifyEnvelope } from '../security/crypto';
import type { DbLike } from './d1';
import { getFirst, isoNow, runStatement } from './d1';

export interface GrantRecord {
  grant_id: string;
  subject: string;
  encrypted_google_tokens: string;
  granted_mcp_scopes: string;
  granted_google_scopes: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

function splitSubjectParts(subject: string): { baseSubject: string; namespace: string | null } {
  const idx = subject.indexOf('#');
  if (idx === -1) {
    return { baseSubject: subject, namespace: null };
  }
  return {
    baseSubject: subject.slice(0, idx),
    namespace: subject.slice(idx + 1) || null,
  };
}

export async function getGrantById(db: DbLike, grantId: string): Promise<(GrantRecord & { parsed_envelope: EncryptedEnvelope }) | null> {
  const row = await getFirst<GrantRecord>(
    db.prepare(`
      SELECT grant_id, subject, encrypted_google_tokens, granted_mcp_scopes, granted_google_scopes, created_at, updated_at, revoked_at
      FROM grants
      WHERE grant_id = ?
    `).bind(grantId),
  );

  if (!row) return null;
  return { ...row, parsed_envelope: parseEnvelope(row.encrypted_google_tokens) };
}

export async function getGrantBySubject(db: DbLike, subject: string): Promise<(GrantRecord & { parsed_envelope: EncryptedEnvelope }) | null> {
  const row = await getFirst<GrantRecord>(
    db.prepare(`
      SELECT grant_id, subject, encrypted_google_tokens, granted_mcp_scopes, granted_google_scopes, created_at, updated_at, revoked_at
      FROM grants
      WHERE subject = ? AND revoked_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(subject),
  );

  if (!row) return null;
  return { ...row, parsed_envelope: parseEnvelope(row.encrypted_google_tokens) };
}

export async function getGrantBySubjectNamespace(db: DbLike, baseSubject: string, namespace: string): Promise<(GrantRecord & { parsed_envelope: EncryptedEnvelope }) | null> {
  return getGrantBySubject(db, `${baseSubject}#${namespace}`);
}

export function makeNamespacedSubject(baseSubject: string, namespace: string): string {
  return `${baseSubject}#${namespace}`;
}

export function getGrantBaseSubject(subject: string): string {
  return splitSubjectParts(subject).baseSubject;
}

export async function upsertGrant(
  db: DbLike,
  input: {
    grantId: string;
    subject: string;
    encryptedGoogleTokens: EncryptedEnvelope;
    grantedMcpScopes: string;
    grantedGoogleScopes: string;
  },
): Promise<void> {
  const now = isoNow();
  await runStatement(
    db.prepare(`
      INSERT INTO grants (
        grant_id,
        subject,
        encrypted_google_tokens,
        granted_mcp_scopes,
        granted_google_scopes,
        created_at,
        updated_at,
        revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(grant_id) DO UPDATE SET
        encrypted_google_tokens = excluded.encrypted_google_tokens,
        granted_mcp_scopes = excluded.granted_mcp_scopes,
        granted_google_scopes = excluded.granted_google_scopes,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).bind(
      input.grantId,
      input.subject,
      stringifyEnvelope(input.encryptedGoogleTokens),
      input.grantedMcpScopes,
      input.grantedGoogleScopes,
      now,
      now,
    ),
  );
}

export async function revokeGrant(db: DbLike, grantId: string): Promise<void> {
  await runStatement(db.prepare('UPDATE grants SET revoked_at = ?, updated_at = ? WHERE grant_id = ?').bind(isoNow(), isoNow(), grantId));
}

export async function deleteGrant(db: DbLike, grantId: string): Promise<void> {
  await runStatement(db.prepare('DELETE FROM grants WHERE grant_id = ?').bind(grantId));
}
