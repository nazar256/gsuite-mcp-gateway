# Project State

## Current direction

`gsuite-mcp-gateway` is now positioned as a **self-hosted** MCP gateway.

There is no shared hosted Google OAuth app for everyone.

Each operator should:

- deploy their own Worker
- create their own Google Cloud project
- create their own Google OAuth app
- keep the app in **Testing** mode for personal use
- add themselves as a **Test user**

## Current defaults

- self-hosted deployment model
- D1-backed encrypted token storage
- Google OAuth in Testing mode for personal use
- default narrow Google scope posture

## Optional future work

- operator-configurable advanced Gmail/Drive scope surfacing
- additional self-hosting automation/scripts
- optional public-publishing guidance for operators who intentionally serve other users
