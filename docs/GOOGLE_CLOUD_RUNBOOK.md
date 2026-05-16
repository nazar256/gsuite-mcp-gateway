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
   - Gmail:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/gmail.compose`
4. If still in testing mode, add test users.

## 4. Create OAuth client credentials

Create a **Web application** OAuth client.

Required redirect URIs:

- local dev:
  - `http://localhost:8787/oauth/google/callback`
- deployed Worker:
  - `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

If you use a custom production domain, register that callback instead of the `workers.dev` URL.

## 5. Capture the client id and secret

You need:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Store them in your secret manager / CI system. Do not commit them.

## 6. Production-readiness notes

- Gmail scopes are more sensitive than Calendar-only apps and may require Google verification/security review.
- For internal or limited-rollout use, testing mode plus explicit test users may be enough.
- For broad public production use, plan for OAuth verification before launch.

## Useful gcloud commands

Project context:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services list --enabled
```

List OAuth brands / clients is not consistently pleasant via `gcloud`; expect to use the Console UI for consent/client administration unless your organization already has automation around Google API credential management.
