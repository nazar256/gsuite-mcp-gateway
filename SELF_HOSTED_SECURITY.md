# Self-hosted security notes

## Trust model

This project is designed for self-hosting. Each deployment has its own operator.

The operator controls:

- the Cloudflare Worker
- D1 storage
- Google OAuth client configuration
- encrypted token retention and deletion
- logging and operational access

Only connect your Google account to a deployment you operate or trust.

## Token handling

- Google access/refresh tokens stay server-side.
- Token sets are encrypted before storage in D1.
- Worker-issued tokens are distinct from Google tokens.
- Logs should avoid tokens, auth headers, email bodies, Drive contents, and sensitive calendar details.

## Secrets

Do not commit:

- `.dev.vars`
- real `wrangler.toml`
- Google OAuth client secrets
- refresh/access tokens
- cookies
- downloaded OAuth JSON secrets

Generate local Worker secrets and pipe them directly into `wrangler secret put`.

## Personal testing mode

For normal personal use:

- keep the Google app in **Testing** mode
- add yourself as a **Test user**
- avoid public publishing/verification unless you are serving other people
