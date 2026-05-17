# Product Requirements

`gsuite-mcp-gateway` is a self-hosted stateless Cloudflare Worker that exposes a remote MCP server over Streamable HTTP and brokers Google OAuth for Google Calendar, Gmail, and optional Google Drive access.

Core requirements:

- Cloudflare Worker runtime only; no Durable Objects, `McpAgent`, or Cloudflare AI agent runtime.
- Default storage mode is D1-backed grants/state/code storage with encrypted Google tokens.
- MCP clients receive Worker-issued tokens only; Google access/refresh tokens remain server-side.
- Remote MCP endpoint is `https://<worker-domain>/mcp` and supports GET/POST/DELETE.
- OAuth Authorization Code + PKCE S256 for MCP clients, plus Google OAuth web server flow for Google APIs.
- Default personal-use posture is self-hosted + Google app in **Testing** mode.
- Default scopes should stay as narrow as practical for personal use.
- Optional advanced Gmail/Drive scopes may be added by the operator when needed.
- Must be deployable and testable locally via `wrangler dev` and remotely on Cloudflare Workers.
