# Security Policy

## Reporting a vulnerability

If you believe you found a security issue in `gsuite-mcp-gateway`, please do **not** open a public GitHub issue with exploit details.

Instead, contact the maintainer privately at:

- GitHub: https://github.com/nazar256

If private GitHub contact is not sufficient for your report, open a minimal public issue asking for a private security contact path without disclosing the vulnerability details.

## What to include

Please include:

- affected version/commit
- deployment mode (local/dev/production)
- steps to reproduce
- impact assessment
- any suggested mitigation

## Scope

This project handles OAuth flows, token storage, and Google Workspace data access. Reports involving token leakage, authorization bypass, grant mix-ups, CSRF, PKCE, redirect validation, or secret-handling mistakes are especially valuable.
