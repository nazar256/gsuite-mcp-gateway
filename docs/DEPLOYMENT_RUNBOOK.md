# Deployment Runbook

This runbook describes how to deploy `gsuite-mcp-gateway` to Cloudflare Workers using a fresh Google Cloud project.

## 1. Prepare private deploy config

```bash
cp wrangler.toml.example wrangler.toml
```

Fill in:

- `database_id`
- `preview_database_id`
- `OAUTH_ISSUER`
- `MCP_RESOURCE`
- `MCP_AUDIENCE`
- `GOOGLE_CALLBACK_URL`

Do not commit `wrangler.toml`.

## 2. Create D1 database

```bash
npx wrangler d1 create gsuite_mcp_gateway
```

Copy the returned ids into `wrangler.toml`.

For `wrangler dev --remote` with D1, set `preview_database_id` too.

## 3. Apply migrations

Local / preview style:

```bash
npx wrangler d1 migrations apply gsuite_mcp_gateway --local
```

Remote:

```bash
npx wrangler d1 migrations apply gsuite_mcp_gateway --remote
```

### Upgrade note for older deployments

Supported automated upgrade path:

1. apply all migrations, including the migration that removes the plaintext `google_email` grant column from the current `grants` table shape;
2. require users/clients to re-authorize so the Worker can bind refreshed grants to Google OIDC `sub` via `userinfo`.

This public repo does **not** claim a generic automated migration for arbitrary older/private schema variants. If your deployed schema differs materially from the current `grants` table family, use a fresh database or a separate manual migration plan.

## 4. Set Worker secrets

Locally generated secrets must be generated and piped directly, one by one:

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put JWT_SIGNING_KEY_B64
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_ENC_KEY_B64
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put CSRF_SIGNING_KEY_B64
```

Operator-provided secrets:

```bash
printf '%s' 'YOUR_GOOGLE_CLIENT_ID' | npx wrangler secret put GOOGLE_CLIENT_ID
printf '%s' 'YOUR_GOOGLE_CLIENT_SECRET' | npx wrangler secret put GOOGLE_CLIENT_SECRET
```

In CI, prefer passing secret-manager values through stdin rather than exposing them in logs.

## 5. Run checks

```bash
npm test
npm run typecheck
```

## 6. Deploy

```bash
npm run deploy
```

## 7. Verify metadata and bearer challenge

```bash
BASE_URL=https://YOUR-WORKER.your-subdomain.workers.dev npm run smoke:remote
```

## 8. Validate authenticated flow

The Worker always adds Google OpenID Connect identity scopes (`openid email`) to the requested Google scope set and resolves the stable Google account id from `https://openidconnect.googleapis.com/v1/userinfo`. If `userinfo` is unavailable, the callback fails closed rather than binding grants to mutable email addresses.

Recommended validation path:

1. use `mcpc` locally first
2. run OAuth via controlled Chrome
3. validate read-only tools first
4. validate reversible writes and clean them up

Example:

```bash
mcpc login https://YOUR-WORKER.your-subdomain.workers.dev/mcp --profile prod --scope "calendar.read calendar.write offline_access"
mcpc connect https://YOUR-WORKER.your-subdomain.workers.dev/mcp --profile prod
```

On Linux, for controlled-browser OAuth debugging, use:

```bash
BROWSER="$HOME/.config/opencode/skills/agents-browser-debug/scripts/open-debug-chrome.sh" mcpc login ...
```

## 9. Suggested production env choices

- `APP_ENV=production`
- `AUTH_STORAGE_MODE=d1` (the only supported mode)
- `GOOGLE_CALENDAR_WRITE_SCOPE_MODE=all` if you need shared-calendar writes
- `DEFAULT_TIME_ZONE` set to your operator default

## 10. Rollout notes

- prefer a custom domain for long-lived production deployments
- verify OAuth redirect URIs exactly
- verify Gmail scope/review posture before public rollout
