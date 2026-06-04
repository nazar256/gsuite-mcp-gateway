import type { AppConfig } from './config';
import type { DbLike } from './storage/d1';
import { createGoogleCalendarClient } from './google/calendar';
import { createGoogleDriveClient } from './google/drive';
import { createGoogleGmailClient } from './google/gmail';
import { decryptStoredGoogleTokenSet } from './google/oauth';
import { buildMimeMessage, encodeMimeMessage } from './google/mime';
import { createS256CodeChallenge } from './oauth/pkce';
import { randomOpaqueToken } from './security/crypto';
import { HttpError } from './security/errors';
import { signJwt, verifyJwt } from './security/jwt';
import { deleteGrant, getGrantBaseSubject, getGrantById, revokeGrant } from './storage/grants';
import { getOAuthClient, upsertOAuthClient } from './storage/clients';

const PROJECT_REPO_URL = 'https://github.com/nazar256/gsuite-mcp-gateway';
const PROJECT_ISSUES_URL = 'https://github.com/nazar256/gsuite-mcp-gateway/issues';
const DEMO_CLIENT_ID = 'self-hosted-demo';
const DEMO_COOKIE_NAME = 'gsmcp_demo';
const DEMO_COOKIE_AUD = 'reviewer-demo-session';
const DEMO_PKCE_COOKIE_NAME = 'gsmcp_demo_pkce';
const DEMO_PKCE_COOKIE_AUD = 'reviewer-demo-pkce';
const DEMO_GRANT_NAMESPACE = 'demo';
const DEMO_EVENT_SUMMARY = 'gsuite-mcp-gateway self-hosted smoke test';
const DEMO_DRIVE_FILE_NAME = 'gsuite-mcp-gateway self-hosted smoke test.txt';

interface DemoSessionClaims {
  iss: string;
  aud: string;
  typ: 'demo_session';
  grant_id: string;
  demo_calendar_event_id?: string;
  demo_drive_file_id?: string;
  iat: number;
  exp: number;
}

interface DemoStatus {
  connected: boolean;
  scopes: string[];
  googleScopes: string[];
  subject?: string;
  email?: string | null;
  hasRefreshToken?: boolean;
}

interface DemoPkceClaims {
  iss: string;
  aud: string;
  typ: 'demo_pkce';
  verifier: string;
  iat: number;
  exp: number;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(config: AppConfig, title: string, pathname: string, body: string): Response {
  const nav = [
    ['/', 'Home'],
    ['/privacy', 'Privacy'],
    ['/terms', 'Terms'],
    ['/support', 'Support'],
    ['/demo', 'Demo'],
  ]
    .map(([href, label]) => `<a href="${href}" style="margin-right: 1rem;">${label}</a>`)
    .join('');

  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(title)}</title>
    <link rel="canonical" href="${htmlEscape(`${config.issuer}${pathname}`)}" />
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #111827;">
    <header style="margin-bottom: 2rem;">
      <nav style="margin-bottom: 1rem;">${nav}</nav>
      <h1 style="margin: 0;">${htmlEscape(title)}</h1>
    </header>
    ${body}
  </body>
</html>`, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
    },
  });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  responseHeaders.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: responseHeaders,
  });
}

function redirectResponse(location: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('location', location);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx === -1 ? [part, ''] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      }),
  );
}

async function createDemoSessionCookie(config: AppConfig, grantId: string): Promise<string> {
  return createDemoSessionCookieForClaims(config, { grant_id: grantId });
}

async function createDemoSessionCookieForClaims(
  config: AppConfig,
  claimsInput: { grant_id: string; demo_calendar_event_id?: string; demo_drive_file_id?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({
    iss: config.issuer,
    aud: DEMO_COOKIE_AUD,
    typ: 'demo_session',
    grant_id: claimsInput.grant_id,
    ...(claimsInput.demo_calendar_event_id ? { demo_calendar_event_id: claimsInput.demo_calendar_event_id } : {}),
    ...(claimsInput.demo_drive_file_id ? { demo_drive_file_id: claimsInput.demo_drive_file_id } : {}),
    iat: now,
    exp: now + 60 * 60 * 24,
  } as Record<string, unknown>, config.jwtSigningKey, 'demo+jwt');
  const secure = config.issuerUrl.protocol === 'https:' ? '; Secure' : '';
  return `${DEMO_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=86400`;
}

function clearDemoSessionCookie(config: AppConfig): string {
  const secure = config.issuerUrl.protocol === 'https:' ? '; Secure' : '';
  return `${DEMO_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

async function createDemoPkceCookie(config: AppConfig, verifier: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({
    iss: config.issuer,
    aud: DEMO_PKCE_COOKIE_AUD,
    typ: 'demo_pkce',
    verifier,
    iat: now,
    exp: now + 10 * 60,
  } as Record<string, unknown>, config.jwtSigningKey, 'demo+pkce+jwt');
  const secure = config.issuerUrl.protocol === 'https:' ? '; Secure' : '';
  return `${DEMO_PKCE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/demo/oauth/callback; HttpOnly; SameSite=Lax${secure}; Max-Age=600`;
}

function clearDemoPkceCookie(config: AppConfig): string {
  const secure = config.issuerUrl.protocol === 'https:' ? '; Secure' : '';
  return `${DEMO_PKCE_COOKIE_NAME}=; Path=/demo/oauth/callback; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

async function getDemoPkceVerifier(request: Request, config: AppConfig): Promise<string> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[DEMO_PKCE_COOKIE_NAME];
  if (!token) {
    throw new HttpError(400, 'invalid_request', 'Demo PKCE verifier is missing');
  }

  const claims = await verifyJwt<Record<string, unknown> & DemoPkceClaims>(token, config.jwtSigningKey, {
    issuer: config.issuer,
    audience: DEMO_PKCE_COOKIE_AUD,
    typ: 'demo_pkce',
    status: 400,
    code: 'invalid_request',
    message: 'Demo PKCE verifier is invalid',
  });
  if (typeof claims.verifier !== 'string' || !claims.verifier) {
    throw new HttpError(400, 'invalid_request', 'Demo PKCE verifier is invalid');
  }

  return claims.verifier;
}

async function getDemoGrant(request: Request, config: AppConfig, db: DbLike) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[DEMO_COOKIE_NAME];
  if (!token) return null;

  try {
    const claims = await verifyJwt<Record<string, unknown> & DemoSessionClaims>(token, config.jwtSigningKey, {
      issuer: config.issuer,
      audience: DEMO_COOKIE_AUD,
      typ: 'demo_session',
      message: 'Reviewer demo session is invalid',
    });
    const grant = await getGrantById(db, String(claims.grant_id));
    return grant && !grant.revoked_at ? grant : null;
  } catch {
    return null;
  }
}

async function getDemoSessionClaims(request: Request, config: AppConfig): Promise<(Record<string, unknown> & DemoSessionClaims) | null> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[DEMO_COOKIE_NAME];
  if (!token) return null;

  try {
    return await verifyJwt<Record<string, unknown> & DemoSessionClaims>(token, config.jwtSigningKey, {
      issuer: config.issuer,
      audience: DEMO_COOKIE_AUD,
      typ: 'demo_session',
      message: 'Reviewer demo session is invalid',
    });
  } catch {
    return null;
  }
}

async function requireDemoGrant(request: Request, config: AppConfig, db: DbLike) {
  const grant = await getDemoGrant(request, config, db);
  if (!grant) {
    throw new HttpError(401, 'invalid_token', 'Connect a Google account from /demo first');
  }
  const tokenSet = await decryptStoredGoogleTokenSet(config, grant);
  return { grant, tokenSet };
}

async function loadDemoStatus(request: Request, config: AppConfig, db: DbLike): Promise<DemoStatus> {
  const grant = await getDemoGrant(request, config, db);
  if (!grant) {
    return { connected: false, scopes: [], googleScopes: [] };
  }
  const tokenSet = await decryptStoredGoogleTokenSet(config, grant);
  return {
    connected: true,
    scopes: grant.granted_mcp_scopes.split(' ').filter(Boolean),
    googleScopes: grant.granted_google_scopes.split(' ').filter(Boolean),
    subject: getGrantBaseSubject(grant.subject),
    email: tokenSet.googleEmail ?? null,
    hasRefreshToken: Boolean(tokenSet.refreshToken),
  };
}

async function ensureDemoClient(config: AppConfig, db: DbLike): Promise<void> {
  const redirectUri = `${config.issuer}/demo/oauth/callback`;
  const existing = await getOAuthClient(db, DEMO_CLIENT_ID);
  if (!existing || existing.redirect_uri !== redirectUri) {
    await upsertOAuthClient(db, {
      clientId: DEMO_CLIENT_ID,
      redirectUri,
      clientName: 'Self-hosted Demo Client',
    });
  }
}

function buildFlashRedirect(path: string, flash: string, headers?: HeadersInit): Response {
  const url = new URL(path, 'http://local');
  url.searchParams.set('flash', flash);
  return redirectResponse(`${url.pathname}${url.search}`, headers);
}

export function handleLandingPage(config: AppConfig): Response {
  return pageShell(config, 'gsuite-mcp-gateway', '/', `
    <p><strong>gsuite-mcp-gateway</strong> is a self-hosted Cloudflare Worker MCP gateway for Google Calendar, Gmail, and Google Drive.</p>
    <p>Each operator deploys their own Worker and configures their own Google OAuth application.</p>
    <p>The operator of this deployment controls the Google OAuth client, Cloudflare Worker, D1 database, and encrypted token storage.</p>
    <p><strong>Do not connect your Google account to a deployment unless you operate it or trust its operator.</strong></p>
    <p>This deployment can perform user-requested actions such as:</p>
    <ul>
      <li>creating and updating Google Calendar events;</li>
      <li>adding attendees to calendar events and sending invitations;</li>
      <li>creating Gmail drafts;</li>
      <li>sending Gmail messages;</li>
      <li>creating or accessing Google Drive files explicitly requested by the user.</li>
    </ul>
    <p>The Worker stores Google OAuth tokens server-side in encrypted form and issues separate Worker-scoped tokens to MCP clients.</p>
    <p>Support for this deployment is provided by its operator. Project source code and documentation are available on <a href="${PROJECT_REPO_URL}">GitHub</a>.</p>
    <p><a href="/privacy">/privacy</a> · <a href="/terms">/terms</a> · <a href="/support">/support</a> · <a href="/demo">/demo</a></p>
  `);
}

export function handlePrivacyPage(config: AppConfig): Response {
  return pageShell(config, 'Privacy policy', '/privacy', `
    <p>This open-source project is designed for self-hosting. Each deployment has its own operator. The operator is responsible for configuring Google OAuth, Cloudflare storage, retention, and access controls.</p>
    <p>This deployment can connect a user’s Google account to an MCP-compatible client so the user can create calendar events, create Gmail drafts, send Gmail messages, and create or access Google Drive files requested by the user.</p>
    <h2>What Google user data is accessed</h2>
    <ul>
      <li>OpenID Connect identity data needed to identify the connected account.</li>
      <li>Calendar event fields needed to create, update, or delete events requested by the user.</li>
      <li>Gmail draft and send payloads needed to create drafts and send user-requested messages.</li>
      <li>Drive file metadata and file content when the user asks the connected client to create or access files.</li>
    </ul>
    <h2>Why it is accessed</h2>
    <p>The app accesses Google data only to perform actions explicitly requested by the user. This project is not intended as a shared hosted service by default.</p>
    <h2>What is stored</h2>
    <ul>
      <li>Encrypted Google access and refresh tokens in the deployment operator’s Cloudflare D1 database.</li>
      <li>OAuth state, authorization codes, OAuth client metadata, and granted MCP/Google scopes.</li>
      <li>A stable Google subject identifier used to bind stored grants to the correct Google account.</li>
    </ul>
    <p>Refresh tokens and other Google credentials are encrypted at rest before storage. Worker-issued access tokens are short-lived and distinct from Google access tokens.</p>
    <h2>Promises and limitations</h2>
    <ul>
      <li>The app does not sell Google user data.</li>
      <li>The app does not use Google user data for advertising.</li>
      <li>The app does not use Google user data to train AI models.</li>
      <li>Operational logs are intended to avoid storing email bodies, Drive file contents, calendar descriptions, OAuth tokens, refresh tokens, and authorization headers.</li>
    </ul>
    <h2>Disconnect and deletion</h2>
    <p>Use only deployments you operate or trust. The browser disconnect flow removes the demo grant currently associated with this Google account for this deployment. Operators can also delete stored grant rows from D1, and users can revoke the app from Google Account permissions.</p>
    <p><strong>The app’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</strong></p>
  `);
}

export function handleTermsPage(config: AppConfig): Response {
  return pageShell(config, 'Terms of service', '/terms', `
    <p>gsuite-mcp-gateway is open-source self-hosted software. No central hosted service is provided by the project by default.</p>
    <p>By connecting a Google account to this deployment, you authorize this deployment’s operator configuration to access the Google services you approve during OAuth consent.</p>
    <p>You are responsible for commands and actions you ask an MCP client or the local smoke-test demo to perform.</p>
    <p>Depending on the permissions granted, the app may create calendar events, create drafts, send emails, and create or access Drive files only according to those permissions.</p>
    <p>The software and this deployment are provided without warranties of any kind.</p>
    <p>For deployment-specific support, contact the operator of this deployment.</p>
    <p>For open-source project issues, see <a href="${PROJECT_ISSUES_URL}">the GitHub issue tracker</a>.</p>
    <p>See the <a href="/privacy">privacy policy</a> for data handling details.</p>
  `);
}

export function handleSupportPage(config: AppConfig): Response {
  return pageShell(config, 'Support and deletion', '/support', `
    <p>For self-hosted deployments, contact the operator of the deployment.</p>
    <p>For bugs, docs fixes, or feature requests in the open-source project, use <a href="${PROJECT_ISSUES_URL}">GitHub issues</a>.</p>
    <h2>How to disconnect</h2>
    <ul>
      <li>Use the disconnect button on <a href="/demo">/demo</a> to revoke and delete the demo grant currently associated with this Google account for this deployment.</li>
      <li>You can also revoke the app from your Google Account permissions page.</li>
    </ul>
    <h2>How to request deletion</h2>
    <p>If you operate this deployment, you can delete stored grants from D1 directly. Otherwise, contact the operator of this deployment and request deletion of the stored grant and token record.</p>
    <p>The browser disconnect flow removes the demo grant currently associated with this Google account for this deployment.</p>
  `);
}

function renderDemoPage(config: AppConfig, status: DemoStatus, flash?: string): Response {
  return pageShell(config, 'Self-hosted smoke test', '/demo', `
    <p>This page is a self-hosted deployment smoke test. It helps the operator verify that Google OAuth, token storage, and basic Google API actions work for this deployment.</p>
    <p>Only connect a Google account here if you operate this deployment or trust its operator.</p>
    <h2>Default Google scopes</h2>
    <ul>
      <li><code>openid email profile</code> — identify the connected account and show connection status.</li>
      <li><code>https://www.googleapis.com/auth/calendar.events</code> — create, update, and delete user-requested calendar events, including shared calendars where the user has write access.</li>
      <li><code>https://www.googleapis.com/auth/gmail.send</code> — send email explicitly requested by the user.</li>
      <li><code>https://www.googleapis.com/auth/gmail.compose</code> — create Gmail drafts for user review.</li>
      <li><code>https://www.googleapis.com/auth/drive</code> — browse, read, create, rename, move, and delete Drive files, folders, or shared-drive content explicitly requested by the user.</li>
    </ul>
    ${flash ? `<p style="padding:0.75rem 1rem; background:#eff6ff; border:1px solid #bfdbfe;">${htmlEscape(flash)}</p>` : ''}
    <h2>Current connection status</h2>
    ${status.connected ? `
      <p><strong>Connected Google account:</strong> ${htmlEscape(status.email ?? status.subject ?? 'Connected')}</p>
      <p><strong>MCP scopes:</strong> ${htmlEscape(status.scopes.join(' '))}</p>
      <p><strong>Google scopes:</strong></p>
      <ul>${status.googleScopes.map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`).join('')}</ul>
    ` : '<p><strong>No Google account is connected in this browser session.</strong></p>'}
    <h2>Operator instructions</h2>
    <ol>
      <li>Click <strong>Connect Google account</strong>.</li>
      <li>Approve the requested scopes on Google’s consent screen using a test user allowed by your Google OAuth app.</li>
      <li>Return to this page and use the demo buttons below.</li>
      <li>When finished, use disconnect to remove the demo grant associated with this Google account for this deployment.</li>
    </ol>
    <p>
      <a href="/demo/connect" style="display:inline-block;padding:0.75rem 1rem;background:#2563eb;color:#fff;text-decoration:none;border-radius:0.5rem;">Connect Google account</a>
      <a href="/demo/status" style="display:inline-block;padding:0.75rem 1rem;margin-left:0.5rem;border:1px solid #d1d5db;border-radius:0.5rem;text-decoration:none;">Show connected account</a>
    </p>
    <h2>Demo actions</h2>
    <form method="post" action="/demo/actions/calendar/create" style="margin-bottom:0.75rem;"><button type="submit">Create test calendar event</button></form>
    <form method="post" action="/demo/actions/calendar/delete" style="margin-bottom:0.75rem;"><button type="submit">Delete test calendar event</button></form>
    <form method="post" action="/demo/actions/gmail/draft" style="margin-bottom:0.75rem;"><button type="submit">Create Gmail draft</button></form>
    <form method="post" action="/demo/actions/gmail/send" style="margin-bottom:0.75rem;"><button type="submit">Send test email to self</button></form>
    <form method="post" action="/demo/actions/drive/create" style="margin-bottom:0.75rem;"><button type="submit">Create test Drive file</button></form>
    <form method="post" action="/demo/actions/drive/delete" style="margin-bottom:0.75rem;"><button type="submit">Delete test Drive file</button></form>
    <form method="post" action="/account/disconnect"><button type="submit">Disconnect and delete stored tokens</button></form>
  `);
}

export async function handleDemoPage(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  const url = new URL(request.url);
  return renderDemoPage(config, await loadDemoStatus(request, config, db), url.searchParams.get('flash') ?? undefined);
}

export async function handleDemoStatus(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  return jsonResponse(await loadDemoStatus(request, config, db));
}

export async function handleDemoConnect(config: AppConfig, db: DbLike): Promise<Response> {
  await ensureDemoClient(config, db);
  const codeVerifier = randomOpaqueToken(48);
  const codeChallenge = await createS256CodeChallenge(codeVerifier);
  const url = new URL('/authorize', config.issuer);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', DEMO_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${config.issuer}/demo/oauth/callback`);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', config.mcpResource);
  url.searchParams.set('scope', 'calendar.write drive.write gmail.send gmail.drafts offline_access');
  url.searchParams.set('grant_namespace', DEMO_GRANT_NAMESPACE);
  return redirectResponse(url.toString(), {
    'set-cookie': await createDemoPkceCookie(config, codeVerifier),
  });
}

export async function handleDemoOAuthCallback(request: Request, config: AppConfig): Promise<Request | Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return buildFlashRedirect('/demo', `Google OAuth failed: ${url.searchParams.get('error')}`, {
      'set-cookie': clearDemoPkceCookie(config),
    });
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new HttpError(400, 'invalid_request', 'Missing authorization code');
  }
  const codeVerifier = await getDemoPkceVerifier(request, config);
  const tokenRequest = new Request(`${config.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: DEMO_CLIENT_ID,
        redirect_uri: `${config.issuer}/demo/oauth/callback`,
        code_verifier: codeVerifier,
        resource: config.mcpResource,
      }),
  });
  return tokenRequest;
}

export async function finalizeDemoOAuthCallback(tokenResponse: Response, config: AppConfig): Promise<Response> {
  const body = await tokenResponse.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!tokenResponse.ok || !body || typeof body.access_token !== 'string') {
    return buildFlashRedirect('/demo', `Demo OAuth exchange failed${body?.error_description ? `: ${String(body.error_description)}` : ''}`, {
      'set-cookie': clearDemoPkceCookie(config),
    });
  }

  const accessToken = body.access_token;
  const claims = await verifyJwt<Record<string, unknown> & { grant_id?: string }>(accessToken, config.jwtSigningKey, {
    issuer: config.issuer,
    audience: config.mcpAudience,
    typ: 'access_token',
    message: 'Demo access token is invalid',
  });
  const grantId = claims.grant_id;
  if (typeof grantId !== 'string' || !grantId) {
    throw new HttpError(500, 'internal_error', 'Demo access token did not include a grant id');
  }

  const headers = new Headers();
  headers.append('set-cookie', await createDemoSessionCookie(config, grantId));
  headers.append('set-cookie', clearDemoPkceCookie(config));
  return buildFlashRedirect('/demo', 'Google account connected for self-hosted smoke test.', headers);
}

async function createCalendarEvent(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  const client = createGoogleCalendarClient(tokenSet.accessToken, config.fetchImpl);
  const start = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 40 * 60 * 1000).toISOString();
  return client.createEvent('primary', {
    summary: DEMO_EVENT_SUMMARY,
    description: 'Created from the self-hosted smoke test page.',
    start: { dateTime: start, timeZone: config.defaultTimeZone },
    end: { dateTime: end, timeZone: config.defaultTimeZone },
  }, 'none') as Promise<Record<string, unknown>>;
}

async function deleteCalendarEvent(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  const sessionClaims = await getDemoSessionClaims(request, config);
  const eventId = sessionClaims?.demo_calendar_event_id;
  if (!eventId) throw new HttpError(404, 'not_found', 'No demo calendar event id is stored for this session');
  const client = createGoogleCalendarClient(tokenSet.accessToken, config.fetchImpl);
  await client.deleteEvent('primary', eventId, 'none');
  return { ok: true, deletedEventId: eventId };
}

async function createDraft(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  if (!tokenSet.googleEmail) throw new HttpError(400, 'google_identity_error', 'Connected email is unavailable');
  const client = createGoogleGmailClient(tokenSet.accessToken, config.fetchImpl);
  const raw = encodeMimeMessage(buildMimeMessage({
    to: [tokenSet.googleEmail],
    subject: 'gsuite-mcp-gateway self-hosted test draft',
    textBody: 'This Gmail draft was created from the self-hosted smoke test page.',
  }));
  return client.createDraft(raw) as Promise<Record<string, unknown>>;
}

async function sendEmail(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  if (!tokenSet.googleEmail) throw new HttpError(400, 'google_identity_error', 'Connected email is unavailable');
  const client = createGoogleGmailClient(tokenSet.accessToken, config.fetchImpl);
  const raw = encodeMimeMessage(buildMimeMessage({
    to: [tokenSet.googleEmail],
    subject: 'gsuite-mcp-gateway self-hosted test email',
    textBody: 'This message was sent to the connected Google account from the self-hosted smoke test page.',
  }));
  return client.sendMessage(raw) as Promise<Record<string, unknown>>;
}

async function createDriveFile(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  const client = createGoogleDriveClient(tokenSet.accessToken, config.fetchImpl);
  return client.createMultipartFile({
    name: DEMO_DRIVE_FILE_NAME,
    description: 'Created from the self-hosted smoke test page.',
  }, new TextEncoder().encode('gsuite-mcp-gateway self-hosted smoke test file\n'), 'text/plain; charset=utf-8') as Promise<Record<string, unknown>>;
}

async function deleteDriveFile(request: Request, config: AppConfig, db: DbLike): Promise<Record<string, unknown>> {
  const { tokenSet } = await requireDemoGrant(request, config, db);
  const sessionClaims = await getDemoSessionClaims(request, config);
  const fileId = sessionClaims?.demo_drive_file_id;
  if (!fileId) throw new HttpError(404, 'not_found', 'No demo Drive file id is stored for this session');
  const client = createGoogleDriveClient(tokenSet.accessToken, config.fetchImpl);
  await client.deleteFile(fileId);
  return { ok: true, deletedFileId: fileId };
}

export async function handleDemoAction(request: Request, config: AppConfig, db: DbLike, action: string): Promise<Response> {
  const handlers: Record<string, () => Promise<Record<string, unknown>>> = {
    'calendar/create': () => createCalendarEvent(request, config, db),
    'calendar/delete': () => deleteCalendarEvent(request, config, db),
    'gmail/draft': () => createDraft(request, config, db),
    'gmail/send': () => sendEmail(request, config, db),
    'drive/create': () => createDriveFile(request, config, db),
    'drive/delete': () => deleteDriveFile(request, config, db),
  };
  const handler = handlers[action];
  if (!handler) {
    throw new HttpError(404, 'not_found', 'Unknown demo action');
  }
  try {
    const result = await handler();
    const currentClaims = await getDemoSessionClaims(request, config);
    let setCookie: string | undefined;
    if (currentClaims?.grant_id) {
      if (action === 'calendar/create' && typeof result.id === 'string') {
        const nextClaims: { grant_id: string; demo_calendar_event_id?: string; demo_drive_file_id?: string } = {
          grant_id: currentClaims.grant_id,
          demo_calendar_event_id: result.id,
        };
        if (currentClaims.demo_drive_file_id) {
          nextClaims.demo_drive_file_id = currentClaims.demo_drive_file_id;
        }
        setCookie = await createDemoSessionCookieForClaims(config, {
          ...nextClaims,
        });
      }
      if (action === 'calendar/delete') {
        const nextClaims: { grant_id: string; demo_calendar_event_id?: string; demo_drive_file_id?: string } = {
          grant_id: currentClaims.grant_id,
        };
        if (currentClaims.demo_drive_file_id) {
          nextClaims.demo_drive_file_id = currentClaims.demo_drive_file_id;
        }
        setCookie = await createDemoSessionCookieForClaims(config, {
          ...nextClaims,
        });
      }
      if (action === 'drive/create' && typeof result.id === 'string') {
        const nextClaims: { grant_id: string; demo_calendar_event_id?: string; demo_drive_file_id?: string } = {
          grant_id: currentClaims.grant_id,
          demo_drive_file_id: result.id,
        };
        if (currentClaims.demo_calendar_event_id) {
          nextClaims.demo_calendar_event_id = currentClaims.demo_calendar_event_id;
        }
        setCookie = await createDemoSessionCookieForClaims(config, {
          ...nextClaims,
        });
      }
      if (action === 'drive/delete') {
        const nextClaims: { grant_id: string; demo_calendar_event_id?: string; demo_drive_file_id?: string } = {
          grant_id: currentClaims.grant_id,
        };
        if (currentClaims.demo_calendar_event_id) {
          nextClaims.demo_calendar_event_id = currentClaims.demo_calendar_event_id;
        }
        setCookie = await createDemoSessionCookieForClaims(config, {
          ...nextClaims,
        });
      }
    }
    return buildFlashRedirect('/demo', `Action ${action} completed successfully.`, setCookie ? { 'set-cookie': setCookie } : undefined);
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'Demo action failed');
    return buildFlashRedirect('/demo', `Action ${action} failed: ${httpError.message}`);
  }
}

export async function handleAccountDisconnect(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  const grant = await getDemoGrant(request, config, db);
  let flash = 'No demo grant was connected for this Google account on this deployment.';
  if (grant) {
    await revokeGrant(db, grant.grant_id);
    await deleteGrant(db, grant.grant_id);
    flash = 'Disconnected and deleted the demo grant for this Google account on this deployment.';
  }
  return buildFlashRedirect('/support', flash, {
    'set-cookie': clearDemoSessionCookie(config),
  });
}
