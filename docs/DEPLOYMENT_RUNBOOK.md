# Deployment Runbook

This runbook describes how to deploy `gsuite-mcp-gateway` as a **self-hosted Cloudflare Worker**.

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

## 3. Apply migrations

```bash
npx wrangler d1 migrations apply gsuite_mcp_gateway --local
npx wrangler d1 migrations apply gsuite_mcp_gateway --remote
```

## 4. Set Worker secrets

Locally generated secrets must be generated and piped directly:

```bash
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put JWT_SIGNING_KEY_B64
openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put TOKEN_ENC_KEY_B64
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put CSRF_SIGNING_KEY_B64
printf '%s' 'YOUR_GOOGLE_CLIENT_ID' | npx wrangler secret put GOOGLE_CLIENT_ID
printf '%s' 'YOUR_GOOGLE_CLIENT_SECRET' | npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## 5. Run checks

```bash
npm run typecheck
npm test
```

## 6. Run locally

```bash
npx wrangler dev --port 8787
```

Verify:

```bash
curl -i http://localhost:8787/
curl -i http://localhost:8787/privacy
curl -i http://localhost:8787/terms
curl -i http://localhost:8787/support
curl -i http://localhost:8787/demo
curl -i http://localhost:8787/mcp
```

## 7. Deploy

```bash
npx wrangler deploy
```

## 8. Verify deployed pages

```bash
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/privacy
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/terms
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/support
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/demo
curl -i https://YOUR-WORKER.your-subdomain.workers.dev/mcp
```

## 9. OAuth validation

For personal use:

- keep the Google app in **Testing** mode
- add yourself as a **Test user**
- test via `/demo`

Recommended validation order:

1. connect Google account
2. check status
3. create/delete a test calendar event
4. create a Gmail draft or send email to yourself only
5. disconnect/delete demo-session grant
