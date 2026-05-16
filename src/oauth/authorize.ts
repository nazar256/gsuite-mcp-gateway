import type { AppConfig } from '../config';
import { createCsrfToken, verifyCsrfToken } from '../security/csrf';
import { encryptJson, randomOpaqueToken } from '../security/crypto';
import { HttpError } from '../security/errors';
import type { DbLike } from '../storage/d1';
import { cleanupExpiredStates, createOAuthState } from '../storage/states';
import { getOAuthClient } from '../storage/clients';
import { buildGoogleAuthorizationUrl } from '../google/oauth';
import { getRequiredGoogleScopes } from './scopes';
import { parseAuthorizationForm, parseAuthorizationRequest } from './validation';
import type { AuthorizationStatePayload } from './types';

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
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  const upgradeOptions: Array<{ key: string; label: string; description: string }> = [
    { key: 'calendar.write', label: 'calendar.write', description: 'Create/update/delete events (owned + shared calendars where permitted)' },
    { key: 'gmail.read', label: 'gmail.read', description: 'Read Gmail messages/metadata' },
    { key: 'gmail.send', label: 'gmail.send', description: 'Send email via Gmail' },
    { key: 'gmail.modify', label: 'gmail.modify', description: 'Modify labels / archive / trash' },
    { key: 'gmail.drafts', label: 'gmail.drafts', description: 'Create drafts' },
    { key: 'offline_access', label: 'offline_access', description: 'Allow refresh (server-side) so sessions can persist' },
  ].filter((opt) => !requestedSet.has(opt.key));

  const upgradeList = upgradeOptions.length
    ? `<fieldset style="margin: 1rem 0; padding: 0.75rem 1rem;">
        <legend><strong>Optional upgrades</strong></legend>
        <p style="margin-top: 0; color: #444;">You can opt in to additional MCP scopes. These will be added to the authorization request.</p>
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
    <h1>Connect Google Calendar and Gmail</h1>
    <p>ChatGPT is requesting access through <strong>gsuite-mcp-gateway</strong>. Google access tokens and refresh tokens stay server-side in encrypted storage.</p>
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

  const csrfToken = await createCsrfToken(config.csrfSigningKey, {
    exp: Math.floor(Date.now() / 1000) + 600,
    client_id: parsed.clientId,
    redirect_uri: parsed.redirectUri,
    state: parsed.state,
    code_challenge: parsed.codeChallenge,
    resource: parsed.resource,
    base_scope: parsed.scope,
  });

  return renderConsentPage(config, parsed, csrfToken);
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
  // The consent page allows opt-in scope upgrades. Compute the desired scope first,
  // then validate the resulting authorization request.
  const baseScope = fields.get('scope') ?? '';
  const upgrades = fields.getAll('upgrade_scope').filter((value) => typeof value === 'string');
  const desiredScope = [baseScope, ...upgrades].join(' ').trim();
  if (desiredScope && desiredScope !== baseScope) {
    fields.set('scope', desiredScope);
  }

  const parsed = parseAuthorizationForm(fields, config);
  await ensureClientExists(db, parsed.clientId, parsed.redirectUri);

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
    csrfPayload.base_scope !== baseScope
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
