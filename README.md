# gsuite-mcp-gateway

Self-hosted Cloudflare Worker MCP/OAuth gateway for Google Calendar, Gmail, and Google Drive.

`gsuite-mcp-gateway` is designed for **self-hosting**. Each operator deploys their own Worker, configures their own Google OAuth application, and controls their own D1-backed encrypted token storage.

> Do **not** connect your Google account to a deployment unless you operate it or trust its operator.

## Prerequisites

- Node.js `>=22`
- Cloudflare account with Workers + D1 enabled
- Google Cloud project with Calendar, Gmail, and Drive APIs enabled
- A Google OAuth Web application configured for your Worker callback URL

## What it does

This Worker acts as:

- an OAuth authorization server for MCP clients such as ChatGPT or `mcpc`
- an OAuth client for Google Calendar, Gmail, and Google Drive
- a broker that keeps Google access/refresh tokens server-side and issues Worker-scoped tokens to MCP clients

## Self-hosted quickstart

```bash
git clone https://github.com/nazar256/gsuite-mcp-gateway.git
cd gsuite-mcp-gateway
npm install
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

1. Clone the repo
2. Fill in your private `wrangler.toml`
3. Create a Google Cloud project
4. Enable required APIs
5. Configure Google Auth Platform in **Testing** mode
6. Add yourself as a **Test user**
7. Add the required Google scopes
8. Create a **Web application** OAuth client
9. Create a Cloudflare D1 database and copy its ids into `wrangler.toml`
10. Set Worker secrets
11. Apply D1 migrations
12. Deploy the Worker
13. Test `/demo`
14. Connect your MCP client to `/mcp`

Useful commands:

```bash
npm run typecheck
npm test
npx wrangler d1 migrations apply gsuite_mcp_gateway --remote
npm run deploy
```

See:

- `SELF_HOSTING.md`
- `SELF_HOSTED_SECURITY.md`
- `docs/GOOGLE_CLOUD_RUNBOOK.md`
- `docs/DEPLOYMENT_RUNBOOK.md`

## Scope model

| MCP scope | Google scope(s) typically requested | Exposed tools |
| --- | --- | --- |
| `calendar.read` | `calendar.readonly` | calendar read/list/freebusy tools |
| `calendar.write` | `calendar.events` or `calendar.events.owned` | calendar create/update/delete tools |
| `drive.read` | `drive.readonly` or implied by `drive.write` | Drive list/get/download tools |
| `drive.write` | `drive` | Drive upload/create/move/rename/delete tools |
| `gmail.read` | `gmail.readonly` or implied by `gmail.modify` | Gmail profile/list/search/get/attachment tools |
| `gmail.send` | `gmail.send` | Gmail send + reply tools |
| `gmail.modify` | `gmail.modify` | Gmail label/archive/trash/read-unread tools |
| `gmail.drafts` | `gmail.compose` | Gmail draft creation tools |
| `offline_access` | no extra Google API scope; requires refresh-token grant | Worker refresh-token issuance |

The repository is open source, but `package.json` is marked `private` because this project is meant to be deployed from source rather than published to npm.

## Recommended default Google scopes for personal use

Keep your Google app in **Testing** mode and start with these scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/drive` (needed for listing, folder creation, rename/move, upload, download, and delete operations)

Optional advanced scopes for broader read/modify behavior should be added only if you need them.

## Gmail Attachments

Agents should inspect attachments in a short explicit flow. Use `gmail_search_messages` to find candidate messages, call `gmail_get_message` with `bodyFormat="sanitized"` and `includePayloadData=false` for compact readable text plus an `attachments` array, then call `gmail_read_attachment` with the message id and attachment id when an LLM should read or inspect the attachment.

`gmail_read_attachment` returns MCP-native model-visible content blocks where supported: text-like attachments as `TextContent`, PNG/JPEG/WebP/GIF attachments as `ImageContent`, audio attachments as `AudioContent`, and PDF or unknown binary attachments as a `resource_link` plus metadata. For text-like attachments, bounded decoded text is also mirrored in `structuredContent.text` for hosts that emphasize structured output, but the primary model-facing representation remains MCP `TextContent`. Attachment resources use `gmail://messages/{messageId}/attachments/{attachmentId}` and can be read through MCP `resources/read`; text resources return text and binary resources return base64 blobs with MIME type.

`gmail_download_attachment` remains the byte-level/debug tool. It uses Gmail's attachment endpoint rather than raw MIME reconstruction, returns base64 by default, resolves metadata such as `partId`, `filename`, `mimeType`, `size`, `contentDisposition`, and `contentId` from the message MIME tree when possible, includes `sha256Full` and `sha256Returned`, and caps decoded bytes with `maxBytes`. Check `truncated` before treating returned data as a complete file. `outputMode="text"` decodes raw bytes only for text-like attachments; it does not extract PDF text, render previews, perform OCR, or create local workspace files from the remote Worker. The current Worker build also does not extract PDF text, render PDF page previews, or perform OCR in `gmail_read_attachment`; PDFs are exposed deliberately as MCP resources for hosts that can fetch or render them.

## Local development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm test
```

Create local env:

```bash
cp .dev.vars.example .dev.vars
```

Run local Worker dev:

```bash
npm run dev
```

Run smoke checks:

```bash
npm run smoke:local
```

Then open:

- `http://localhost:8787/`
- `http://localhost:8787/demo`

## Deploy configuration

This repo ships `wrangler.toml.example` as a template. Copy it to a private local `wrangler.toml` and fill in your values:

```bash
cp wrangler.toml.example wrangler.toml
```

Do **not** commit your real `wrangler.toml`.

Required Worker secrets:

- `JWT_SIGNING_KEY_B64`
- `TOKEN_ENC_KEY_B64`
- `CSRF_SIGNING_KEY_B64`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Production allowlists should contain only the exact callback/origin patterns you intend to trust for that deployment. Add localhost loopback callbacks or browser origins only when you intentionally need a deployed worker to talk to a local client during development.

## Secret handling policy

- Do **not** write locally generated Worker secrets to disk.
- Do **not** place locally generated Worker secrets in shell variables.
- Generate and pipe each locally generated secret directly into `wrangler secret put`.
- Do not commit Google client secrets, refresh tokens, access tokens, cookies, or downloaded OAuth JSON files.

Examples:

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put JWT_SIGNING_KEY_B64
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_ENC_KEY_B64
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put CSRF_SIGNING_KEY_B64
```

## Troubleshooting

### `access_denied` / app not verified

Keep the Google app in **Testing** mode and add your Google account as a **Test user**.

### `redirect_uri_mismatch`

Add the exact Worker callback URL to the Google OAuth client:

- local: `http://localhost:8787/oauth/google/callback`
- deployed: `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

### Google branding/domain verification

Not required for normal personal **Testing** mode. It is needed only if you want to publish a Google OAuth app for other users.

### `insufficient_scope`

The requested action requires a Google scope that was not granted or configured in your Google OAuth app.

## Support

- For deployment-specific support, deletion requests, or trust questions, contact the operator of the deployment you are using.
- For open-source project bugs or improvement requests, use the GitHub issue tracker: <https://github.com/nazar256/gsuite-mcp-gateway/issues>
- For security-sensitive reports, see `SECURITY.md`.

## Notes on publishing

For personal/self-hosted use:

- keep the Google app in **Testing** mode
- add yourself as a **Test user**
- use your own Worker deployment and your own Google OAuth app

Google public publishing/verification is optional and only needed if you intend to operate the app for other people.
