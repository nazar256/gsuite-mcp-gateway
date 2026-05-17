# Self-hosting guide

`gsuite-mcp-gateway` is intended to be self-hosted.

Each operator should:

- deploy their own Cloudflare Worker
- create their own Google Cloud project
- create their own Google OAuth app
- store their own encrypted OAuth grants in their own D1 database

## Quickstart

```bash
git clone https://github.com/nazar256/gsuite-mcp-gateway.git
cd gsuite-mcp-gateway
npm install
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Then:

1. Create a Google Cloud project.
2. Enable Calendar, Gmail, and Drive APIs.
3. Configure Google Auth Platform in **Testing** mode.
4. Add yourself as a **Test user**.
5. Add the required Google scopes.
6. Create a **Web application** OAuth client.
7. Create a D1 database.
8. Fill in `wrangler.toml`.
9. Set Worker secrets.
10. Apply migrations.
11. Run `npm run typecheck && npm test`.
12. Run local smoke tests.
13. Deploy.
14. Test `/demo`.

## Important warning

Do not connect your Google account to a deployment unless you operate it or trust its operator.

## Default personal-use posture

- Google app in **Testing** mode
- yourself added as **Test user**
- start with the default self-hosted Google scopes
- add broader advanced scopes only when needed

## MCP clients

This gateway can be used by MCP clients such as ChatGPT or `mcpc`, but the Google OAuth app belongs to the deployment operator, not to a central shared service.

For bugs or feature requests in the open-source project itself, use the GitHub issue tracker: <https://github.com/nazar256/gsuite-mcp-gateway/issues>
