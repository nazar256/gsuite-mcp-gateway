# Architectural Decisions

## DEC-001: Stateless Worker architecture

- Use a normal Cloudflare Worker with per-request `McpServer` and `WebStandardStreamableHTTPServerTransport` instances.
- Do not use Durable Objects, `McpAgent`, or Cloudflare AI agents.

## DEC-002: D1-backed default auth storage

- Store OAuth states, authorization codes, registered clients, and encrypted Google token grants in D1.
- Worker-issued access and refresh tokens are signed JWTs that reference a D1 grant.

## DEC-003: Google tokens remain server-side

- ChatGPT never receives raw Google access or refresh tokens.
- Google token sets are encrypted with AES-GCM before storing in D1.

## DEC-004: Direct Google REST integration

- Use direct `fetch` wrappers for Google Calendar API and Gmail API instead of the Node-focused `googleapis` SDK.
