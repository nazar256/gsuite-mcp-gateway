CREATE TABLE grants_v2 (
  grant_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  encrypted_google_tokens TEXT NOT NULL,
  granted_mcp_scopes TEXT NOT NULL,
  granted_google_scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

INSERT INTO grants_v2 (
  grant_id,
  subject,
  encrypted_google_tokens,
  granted_mcp_scopes,
  granted_google_scopes,
  created_at,
  updated_at,
  revoked_at
)
SELECT
  grant_id,
  subject,
  encrypted_google_tokens,
  granted_mcp_scopes,
  granted_google_scopes,
  created_at,
  updated_at,
  revoked_at
FROM grants;

DROP TABLE grants;
ALTER TABLE grants_v2 RENAME TO grants;

CREATE INDEX IF NOT EXISTS idx_grants_subject ON grants(subject);
