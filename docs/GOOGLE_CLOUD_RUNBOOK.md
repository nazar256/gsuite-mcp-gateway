# Google Cloud Runbook

This runbook describes how to configure a fresh Google Cloud project for production use with `gsuite-mcp-gateway`.

## 1. Create or select a Google Cloud project

Example:

```bash
gcloud projects create YOUR_PROJECT_ID --name="gsuite-mcp-gateway"
gcloud config set project YOUR_PROJECT_ID
```

## 2. Enable required APIs

```bash
gcloud services enable \
  calendar-json.googleapis.com \
  drive.googleapis.com \
  gmail.googleapis.com
```

## 3. Configure OAuth consent / Google Auth Platform

Some consent-screen settings are still easiest in the Google Cloud Console UI.

In Google Cloud Console:

1. Open **Google Auth Platform** / OAuth consent configuration.
2. Configure:
   - app name
   - support email
   - developer contact email
   - authorized domains (if using a custom production domain)
3. Add scopes needed by your deployment strategy:
   - Identity (always required by this Worker):
      - `openid`
      - `email`
   - Calendar read:
     - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
     - `https://www.googleapis.com/auth/calendar.events.readonly`
     - `https://www.googleapis.com/auth/calendar.events.freebusy`
    - Calendar write (choose one policy):
      - `https://www.googleapis.com/auth/calendar.events` for owned + shared calendars
      - or `https://www.googleapis.com/auth/calendar.events.owned` for owned only
    - Drive read:
      - `https://www.googleapis.com/auth/drive.readonly`
    - Drive write:
      - `https://www.googleapis.com/auth/drive`
    - Gmail:
      - `https://www.googleapis.com/auth/gmail.readonly`
      - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/gmail.compose`
4. If still in testing mode, add test users.

## 4. Create OAuth client credentials

Create a **Web application** OAuth client.

### What to enter on the “Create OAuth client ID” screen

Use:

- **Application type**: `Web application`
- **Name**: any descriptive name, for example `gsuite-mcp-gateway`

#### Authorized JavaScript origins

For this project, you will usually leave **Authorized JavaScript origins** empty.

Why:

- This gateway does **not** use browser-side JavaScript to call Google OAuth endpoints directly.
- The Worker performs server-side OAuth redirects/callback handling instead.
- Per Google’s client model, **JavaScript origins** are for apps whose frontend JavaScript talks to Google directly from the browser.

Only add JavaScript origins if you intentionally build a separate browser app that will call Google OAuth endpoints from frontend JavaScript.

#### Authorized redirect URIs

This is the important section for this project.

Add the exact callback URL(s) where Google should return the user after consent.

Required redirect URIs:

- local dev:
  - `http://localhost:8787/oauth/google/callback`
- deployed Worker:
  - `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

If you use a custom production domain, add that callback too:

- custom production domain:
  - `https://YOUR-DOMAIN/oauth/google/callback`

Recommended combinations:

- **Local development only**
  - JavaScript origins: leave blank
  - Redirect URIs:
    - `http://localhost:8787/oauth/google/callback`

- **Production on workers.dev**
  - JavaScript origins: leave blank
  - Redirect URIs:
    - `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

- **Both local dev and production**
  - JavaScript origins: leave blank
  - Redirect URIs:
    - `http://localhost:8787/oauth/google/callback`
    - `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

- **Custom production domain**
  - JavaScript origins: leave blank
  - Redirect URIs:
    - `http://localhost:8787/oauth/google/callback`
    - `https://YOUR-DOMAIN/oauth/google/callback`

Important rules:

- Redirect URIs must match exactly.
- Do not add trailing slashes unless your real callback URL has one.
- Do not put `/mcp` here.
- Do not put the homepage/root domain here unless your callback actually lives there.
- The value must be the Google callback endpoint exposed by this Worker: `/oauth/google/callback`.

Examples:

- correct:
  - `http://localhost:8787/oauth/google/callback`
  - `https://gsuite-mcp-gateway.example.com/oauth/google/callback`
- incorrect:
  - `http://localhost:8787/`
  - `https://gsuite-mcp-gateway.example.com/`
  - `https://gsuite-mcp-gateway.example.com/mcp`
  - `https://gsuite-mcp-gateway.example.com/oauth/google/callback/`

After creation, Google will show:

- **Client ID** → use as `GOOGLE_CLIENT_ID`
- **Client secret** → use as `GOOGLE_CLIENT_SECRET`

## 5. Capture the client id and secret

You need:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Store them in your secret manager / CI system. Do not commit them.

## 6. Production-readiness notes

- Drive broad scopes (`drive`, `drive.readonly`) and Gmail scopes are more sensitive than Calendar-only apps and may require Google verification/security review.
- For internal or limited-rollout use, testing mode plus explicit test users may be enough.
- For broad public production use, plan for OAuth verification before launch.

## Useful gcloud commands

Project context:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services list --enabled
```

List OAuth brands / clients is not consistently pleasant via `gcloud`; expect to use the Console UI for consent/client administration unless your organization already has automation around Google API credential management.
