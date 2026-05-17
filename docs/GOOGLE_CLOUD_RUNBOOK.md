# Google Cloud Runbook

This runbook describes how to configure a fresh Google Cloud project for **self-hosted/personal use** with `gsuite-mcp-gateway`.

## 1. Create or select a Google Cloud project

```bash
gcloud projects create YOUR_PROJECT_ID --name="gsuite-mcp-gateway"
gcloud config set project YOUR_PROJECT_ID
```

## 2. Enable required APIs

```bash
gcloud services enable \
  calendar-json.googleapis.com \
  gmail.googleapis.com \
  drive.googleapis.com
```

Drive is optional and not part of the default personal-use smoke-test path.

## 3. Configure Google Auth Platform

Use **Testing** mode for personal use.

In Google Cloud Console:

1. Open **Google Auth Platform**.
2. Set:
   - app name: `gsuite-mcp-gateway`
   - support email: your email
   - developer contact email: your email
   - homepage URL: your deployed Worker `/`
   - privacy policy URL: your deployed Worker `/privacy`
   - terms URL: your deployed Worker `/terms`
3. Keep the app in **Testing** mode.
4. Add yourself as a **Test user**.

For personal/self-hosted use, Google public publishing/verification is not required.

## 4. Add default scopes

Recommended default scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/calendar.events` or `calendar.events.owned`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.compose`
- optional advanced scope: `https://www.googleapis.com/auth/drive.file`

Optional advanced scopes only when needed:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive`

## 5. Create OAuth client credentials

Create a **Web application** OAuth client.

### Authorized JavaScript origins

Usually leave this blank for this Worker architecture.

### Authorized redirect URIs

Add the exact callback URLs:

- `http://localhost:8787/oauth/google/callback`
- `https://YOUR-WORKER.your-subdomain.workers.dev/oauth/google/callback`

Do not put `/mcp` or the site root here.

## 6. Capture client id and secret

You need:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Do not commit them.

## Troubleshooting

### `access_denied` / app not verified

Add your Google account as a **Test user**.

### `redirect_uri_mismatch`

Add the exact Worker callback URL to the OAuth client.

### Google branding/domain verification

Not required for personal **Testing** mode. Only needed if you plan to publish the app for other users.
