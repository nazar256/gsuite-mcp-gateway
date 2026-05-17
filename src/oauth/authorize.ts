import type { AppConfig } from '../config';
import { createCsrfToken, verifyCsrfToken } from '../security/csrf';
import { encryptJson, randomOpaqueToken } from '../security/crypto';
import { HttpError } from '../security/errors';
import type { DbLike } from '../storage/d1';
import { cleanupExpiredStates, createOAuthState } from '../storage/states';
import { getOAuthClient } from '../storage/clients';
import { buildGoogleAuthorizationUrl } from '../google/oauth';
import { getRequiredGoogleScopes, normalizeMcpScope } from './scopes';
import { parseAuthorizationForm, parseAuthorizationRequest } from './validation';
import type { AuthorizationStatePayload } from './types';

const DEMO_GRANT_NAMESPACE = 'demo';
const DEMO_CLIENT_ID = 'self-hosted-demo';
const AUTHORIZATION_UPGRADES = [
  { key: 'calendar.write', label: 'calendar.write', description: 'Create, update, and delete Google Calendar events requested by the user' },
  { key: 'drive.write', label: 'drive.write', description: 'List, create, rename, move, upload, and delete Google Drive files and folders' },
  { key: 'gmail.send', label: 'gmail.send', description: 'Send email via Gmail' },
  { key: 'gmail.modify', label: 'gmail.modify', description: 'Read and organize Gmail messages and labels' },
  { key: 'gmail.drafts', label: 'gmail.drafts', description: 'Create Gmail drafts for review before sending' },
  { key: 'offline_access', label: 'offline_access', description: 'Allow refresh (server-side) so sessions can persist' },
] as const;

function validateGrantNamespace(clientId: string, redirectUri: string, grantNamespace?: string): string | undefined {
  const isReviewerDemoClient = clientId === DEMO_CLIENT_ID && redirectUri.endsWith('/demo/oauth/callback');

  if (!grantNamespace) {
    if (isReviewerDemoClient) {
      throw new HttpError(400, 'invalid_request', 'self-hosted demo authorization must use grant_namespace=demo');
    }
    return undefined;
  }

  if (
    grantNamespace !== DEMO_GRANT_NAMESPACE
    || !isReviewerDemoClient
  ) {
    throw new HttpError(400, 'invalid_request', 'grant_namespace is reserved for the built-in self-hosted demo flow');
  }

  return grantNamespace;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function renderConsentPage(config: AppConfig, request: ReturnType<typeof parseAuthorizationRequest>, csrfToken: string): Response {
  const googleScopes = getRequiredGoogleScopes(config, request.scope);
  const scopeList = request.scope.split(' ').map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`).join('');
  const googleScopeList = googleScopes.map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`).join('');

  const requestedSet = new Set(request.scope.split(' ').filter(Boolean));
  const upgradeOptions = AUTHORIZATION_UPGRADES.filter((opt) => !requestedSet.has(opt.key));

  const upgradeList = upgradeOptions.length
    ? `<fieldset style="margin: 1rem 0; padding: 0.75rem 1rem;">
        <legend><strong>Optional upgrades</strong></legend>
        <p style="margin-top: 0; color: #444;">You can opt in to additional MCP scopes for this grant so the client can use more of the gateway's Google Workspace tools.</p>
        ${upgradeOptions.map((opt) => `
          <label style="display: block; margin: 0.5rem 0;">
            <input type="checkbox" name="upgrade_scope" value="${htmlEscape(opt.key)}" />
            <code>${htmlEscape(opt.label)}</code>
            <span style="color: #444;"> — ${htmlEscape(opt.description)}</span>
          </label>
        `).join('')}
      </fieldset>`
    : '';

  return htmlResponse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize gsuite-mcp-gateway</title>
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5;">
    <h1>Connect Google Workspace</h1>
    <p>This app is requesting Google access through <strong>gsuite-mcp-gateway</strong>. Google access tokens and refresh tokens stay server-side in encrypted storage.</p>
    <p>This is a self-hosted deployment. Public information for this operator-run instance: <a href="/">home</a> · <a href="/privacy">privacy</a> · <a href="/terms">terms</a> · <a href="/support">support</a> · <a href="/demo">demo</a></p>
    <p><strong>Requested MCP scopes</strong></p>
    <ul>${scopeList}</ul>
    <p><strong>Google scopes that will be requested</strong></p>
    <ul>${googleScopeList}</ul>
    <form method="post" action="/authorize">
      <input type="hidden" name="response_type" value="${htmlEscape(request.responseType)}" />
      <input type="hidden" name="client_id" value="${htmlEscape(request.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${htmlEscape(request.redirectUri)}" />
      ${request.state ? `<input type="hidden" name="state" value="${htmlEscape(request.state)}" />` : ''}
      <input type="hidden" name="code_challenge" value="${htmlEscape(request.codeChallenge)}" />
      <input type="hidden" name="code_challenge_method" value="${htmlEscape(request.codeChallengeMethod)}" />
      <input type="hidden" name="resource" value="${htmlEscape(request.resource)}" />
      <input type="hidden" name="scope" value="${htmlEscape(request.scope)}" />
      ${(request as { grantNamespace?: string }).grantNamespace ? `<input type="hidden" name="grant_namespace" value="${htmlEscape((request as { grantNamespace?: string }).grantNamespace!)}" />` : ''}
      ${upgradeList}
      <input type="hidden" name="csrf_token" value="${htmlEscape(csrfToken)}" />
      <button type="submit" style="padding: 0.75rem 1rem;">Continue to Google</button>
    </form>
  </body>
</html>`);
}

async function ensureClientExists(db: DbLike, clientId: string, redirectUri: string): Promise<void> {
  const client = await getOAuthClient(db, clientId);
  if (!client) {
    throw new HttpError(400, 'invalid_client', 'Unknown client_id');
  }
  if (client.redirect_uri !== redirectUri) {
    throw new HttpError(400, 'invalid_request', 'redirect_uri does not match registered client');
  }
}

export async function handleAuthorizeGet(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  const parsed = parseAuthorizationRequest(request, config);
  await ensureClientExists(db, parsed.clientId, parsed.redirectUri);
  const grantNamespace = validateGrantNamespace(parsed.clientId, parsed.redirectUri, parsed.grantNamespace);

  const csrfToken = await createCsrfToken(config.csrfSigningKey, {
    exp: Math.floor(Date.now() / 1000) + 600,
    client_id: parsed.clientId,
    redirect_uri: parsed.redirectUri,
    state: parsed.state,
    code_challenge: parsed.codeChallenge,
    resource: parsed.resource,
    base_scope: parsed.scope,
    grant_namespace: grantNamespace,
  });

  return renderConsentPage(config, grantNamespace ? { ...parsed, grantNamespace } : parsed, csrfToken);
}

async function parsePostFields(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await request.text());
  }

  const formData = await request.formData();
  const fields = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields.set(key, value);
    }
  }
  return fields;
}

export async function handleAuthorizePost(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  const fields = await parsePostFields(request);
  const baseScope = fields.get('scope') ?? '';
  const normalizedBaseScope = normalizeMcpScope(baseScope);
  const allowedUpgradeScopes = new Set<string>(AUTHORIZATION_UPGRADES.map((opt) => opt.key));
  const upgrades = fields
    .getAll('upgrade_scope')
    .filter((value) => typeof value === 'string' && allowedUpgradeScopes.has(value));
  const desiredScope = normalizeMcpScope([normalizedBaseScope, ...upgrades].join(' ').trim());
  if (desiredScope !== fields.get('scope')) {
    fields.set('scope', desiredScope);
  }

  const parsed = parseAuthorizationForm(fields, config);
  await ensureClientExists(db, parsed.clientId, parsed.redirectUri);
  const grantNamespace = validateGrantNamespace(parsed.clientId, parsed.redirectUri, parsed.grantNamespace);

  const csrfToken = fields.get('csrf_token');
  if (!csrfToken) {
    throw new HttpError(400, 'invalid_request', 'csrf_token is required');
  }

  const csrfPayload = await verifyCsrfToken<Record<string, unknown> & { exp: number }>(config.csrfSigningKey, csrfToken);
  if (
    csrfPayload.client_id !== parsed.clientId ||
    csrfPayload.redirect_uri !== parsed.redirectUri ||
    csrfPayload.state !== parsed.state ||
    csrfPayload.code_challenge !== parsed.codeChallenge ||
    csrfPayload.resource !== parsed.resource ||
    csrfPayload.base_scope !== normalizedBaseScope ||
    csrfPayload.grant_namespace !== grantNamespace
  ) {
    throw new HttpError(400, 'invalid_request', 'CSRF token does not match authorization request');
  }

  const stateId = randomOpaqueToken(24);
  const payload: AuthorizationStatePayload = {
    v: 1,
    kind: 'google_oauth_state',
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    ...(parsed.state ? { state: parsed.state } : {}),
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    resource: parsed.resource,
    scope: parsed.scope,
    ...(grantNamespace ? { grantNamespace } : {}),
    createdAt: new Date().toISOString(),
  };

  await cleanupExpiredStates(db, new Date().toISOString());
  await createOAuthState(db, {
    stateId,
    encryptedPayload: await encryptJson(payload, config.tokenEncryptionKey, {
      kind: 'oauth_state',
      state_id: stateId,
    }),
    expiresAt: new Date(Date.now() + config.stateTtlSeconds * 1000).toISOString(),
  });

  const googleScopes = getRequiredGoogleScopes(config, parsed.scope);
  const redirectUrl = buildGoogleAuthorizationUrl(config, {
    state: stateId,
    googleScopes,
    promptConsent: true,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectUrl,
      'cache-control': 'no-store',
    },
  });
}
