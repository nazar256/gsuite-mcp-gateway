# Product Requirements

`gsuite-mcp-gateway` is a stateless Cloudflare Worker that exposes a remote MCP server over Streamable HTTP and acts as an OAuth authorization server for ChatGPT while brokering Google OAuth to Calendar and Gmail.

Core requirements:

- Cloudflare Worker runtime only; no Durable Objects, `McpAgent`, or Cloudflare AI agent runtime.
- Default storage mode is D1-backed grants/state/code storage with encrypted Google tokens.
- ChatGPT receives Worker-issued tokens only; Google access/refresh tokens remain server-side.
- Remote MCP endpoint is `https://<worker-domain>/mcp` and supports GET/POST/DELETE.
- OAuth Authorization Code + PKCE S256 for ChatGPT, plus Google OAuth web server flow for Google Calendar and Gmail.
- Calendar tools: list calendars/events, get event, freebusy, create/update/delete events, attendees, sendUpdates, Google Meet.
- Gmail tools: profile, labels, search/get message, drafts, send, reply, label modifications, archive, trash, read/unread.
- Strict redirect validation, signed JWT Worker tokens, AES-GCM encryption for Google tokens, no secrets in logs.
- Must be deployed and validated end-to-end with Cloudflare, Google Cloud, MCP Inspector and ChatGPT.
