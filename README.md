# gsuite-mcp-gateway

Cloudflare Worker MCP/OAuth gateway for Google Calendar, Google Drive, and Gmail.

`gsuite-mcp-gateway` exposes a remote MCP server over Streamable HTTP from a stateless Cloudflare Worker. It acts as:

- an OAuth authorization server for MCP clients such as ChatGPT or `mcpc`
- an OAuth client for Google Calendar, Google Drive, and Gmail
- a broker that keeps Google access/refresh tokens server-side and issues Worker-scoped tokens to MCP clients

## Features

- Stateless Cloudflare Worker runtime
- D1-backed OAuth state, client, code, and encrypted grant storage
- OAuth Authorization Code + PKCE (`S256`) for MCP clients
- Google Calendar tools:
  - list calendars
  - list/get events
  - freebusy
  - create/update/delete events
- Google Drive tools:
  - list/search files
  - get metadata
  - download blob files / export Google Workspace docs
  - upload small files
  - delete files
- Gmail tools:
  - profile
  - labels
  - search/get message
  - create draft
  - send email
  - reply
  - modify labels
  - archive/trash
  - mark read/unread

## Architecture

```text
MCP client (ChatGPT / mcpc)
  -> Cloudflare Worker: MCP Streamable HTTP + OAuth server
    -> Google OAuth
      -> Google Calendar API
      -> Google Drive API
      -> Gmail API
```

Key constraints:

- Cloudflare Worker runtime only
- no Durable Objects
- no `McpAgent` / Cloudflare AI agent runtime
- Google access/refresh tokens remain server-side
- Worker-issued tokens are distinct from Google tokens
- Only `AUTH_STORAGE_MODE=d1` is currently supported
- Stable Google account identity is resolved via OpenID Connect (`openid email` + Google `userinfo`)
- Google email, when present, is stored only inside the encrypted token envelope, not plaintext grant columns

## Tool surface

### Calendar

- `calendar_list_calendars`
- `calendar_get_event`
- `calendar_list_events`
- `calendar_find_freebusy`
- `calendar_create_event`
- `calendar_update_event`
- `calendar_delete_event`

### Gmail

- `gmail_get_profile`
- `gmail_list_labels`
- `gmail_search_messages`
- `gmail_get_message`
- `gmail_create_draft`
- `gmail_send_email`
- `gmail_reply_to_message`
- `gmail_modify_message_labels`
- `gmail_archive_message`
- `gmail_trash_message`
- `gmail_mark_read_unread`

### Drive

- `drive_list_files`
- `drive_get_file`
- `drive_download_file`
- `drive_upload_file`
- `drive_delete_file`

## Local development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
npm run typecheck
```

Create a local `.dev.vars` from the example:

```bash
cp .dev.vars.example .dev.vars
```

Run local Worker dev:

```bash
npm run dev
```

Run local smoke verification:

```bash
npm run smoke:local
```

For realistic local OAuth debugging against Cloudflare-backed resources/secrets, prefer `wrangler dev --remote` with localhost overrides.

Important: the callback flow now depends on Google OpenID Connect identity resolution. The Worker always requests `openid email` in addition to Calendar/Drive/Gmail API scopes and expects `https://openidconnect.googleapis.com/v1/userinfo` to succeed so it can bind grants to Google's stable `sub` identifier.

## Drive behavior

This repo adds a small, MCP-friendly Drive slice:

- `drive.read`
  - list/search files
  - fetch metadata
  - download blob files
  - export Google Workspace docs when `exportMimeType` is provided
- `drive.write`
  - includes `drive.read`
  - upload small files with metadata
  - permanently delete files/folders

Notes:

- `drive_download_file` is intentionally sized for MCP/tool responses, not large bulk transfer.
- Google Workspace-native files (Docs/Sheets/Slides/etc.) require `exportMimeType` because they are exported, not downloaded via `alt=media`.
- The current upload path is multipart upload for small files.

## Deploy configuration

This repo ships a template config at `wrangler.toml.example`.

To deploy, copy it to a private local `wrangler.toml` and replace placeholders with your real values:

```bash
cp wrangler.toml.example wrangler.toml
```

Do **not** commit your real `wrangler.toml`.

### Fresh deploy vs upgrade

- Fresh deployment: apply all migrations normally.
- Supported upgrade path in this public repo: deployments already using the same `grants` schema family can apply the cleanup migration that removes the plaintext `google_email` column.
- Older/private schema variants are **not** covered by an automated upgrade path in this public repo; use a fresh database or perform a manual migration/re-authorization plan outside the repo.

Required non-secret values:

- D1 database id
- preview D1 database id (for `wrangler dev --remote` + D1)
- Worker issuer/resource/audience URLs
- Google callback URL

Required Worker secrets:

- `JWT_SIGNING_KEY_B64`
- `TOKEN_ENC_KEY_B64`
- `CSRF_SIGNING_KEY_B64`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### Secret handling policy

- Do **not** write locally generated Worker secrets to disk.
- Do **not** place locally generated Worker secrets in shell variables.
- Generate and pipe each locally generated secret directly into `wrangler secret put`, one by one.
- Operator-provided secrets such as `GOOGLE_CLIENT_SECRET` should still avoid disk persistence.

Examples:

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put JWT_SIGNING_KEY_B64
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_ENC_KEY_B64
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put CSRF_SIGNING_KEY_B64
```

## Calendar write scope behavior

`calendar.write` can be mapped in two modes:

- `GOOGLE_CALENDAR_WRITE_SCOPE_MODE=all` (default): request `https://www.googleapis.com/auth/calendar.events`
  - supports writes to owned and shared calendars where the user has permission
- `GOOGLE_CALENDAR_WRITE_SCOPE_MODE=owned`: request `https://www.googleapis.com/auth/calendar.events.owned`
  - restricts writes to calendars the user owns

## Verification commands

Remote metadata/challenge smoke verification:

```bash
BASE_URL=https://your-worker.your-subdomain.workers.dev npm run smoke:remote
```

Then complete authenticated end-to-end validation with an MCP client such as `mcpc`.

If this is an upgraded deployment rather than a fresh one, re-run real user authorization flows after migration so refreshed grants are re-issued under the stable OIDC identity model.

## Controlled browser OAuth debugging

On Linux, CLI OAuth tools such as `mcpc` often open URLs via `xdg-open`. To force those flows into the shared debug Chrome session, use the helper from the `agents-browser-debug` skill:

```bash
BROWSER="$HOME/.config/opencode/skills/agents-browser-debug/scripts/open-debug-chrome.sh" \
  mcpc login https://your-worker.your-subdomain.workers.dev/mcp --scope 'calendar.read offline_access'
```

For reliable debugging, prefer this pattern:

1. start bounded/detached `mcpc login`
2. read the exact fresh `Authorization URL` from the log
3. open that exact URL yourself in the controlled Chrome session
4. verify the tab in DevTools before continuing

## Production setup guides

- `docs/GOOGLE_CLOUD_RUNBOOK.md`: Google Cloud project, OAuth consent, APIs, client configuration
- `docs/DEPLOYMENT_RUNBOOK.md`: Cloudflare, D1, secrets, deploy, validation
- `docs/DECISIONS.md`: architectural decisions
- `docs/PRODUCT_REQUIREMENTS.md`: product scope and requirements

### Google OAuth client quick note

When creating the Google OAuth **Web application** client for this Worker:

- **Authorized JavaScript origins**: usually leave this blank
- **Authorized redirect URIs**: add the Worker callback URL(s)

Use redirect URIs like:

- local: `http://localhost:8787/oauth/google/callback`
- workers.dev: `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`
- custom domain: `https://YOUR-DOMAIN/oauth/google/callback`

Do **not** put `/mcp` or the site root here. The exact Google callback endpoint is `/oauth/google/callback`.

## Publishing and verification notes

- Gmail scopes may require Google app verification/security review before broad public production use.
- For private/internal testing, keep the Google app in testing mode and explicitly manage test users.
- For public production rollout, prefer a custom domain instead of relying on a `workers.dev` hostname.
