import type { AppConfig } from '../config';
import { decryptJson, encryptJson, randomOpaqueToken, sha256Hex } from '../security/crypto';
import { HttpError } from '../security/errors';
import { redactObject, redactUrl } from '../security/redaction';
import { deleteOAuthState, getOAuthState } from '../storage/states';
import { cleanupExpiredCodes, createOAuthCode } from '../storage/codes';
import type { DbLike } from '../storage/d1';
import { getGrantBySubject, getGrantBySubjectNamespace, makeNamespacedSubject, upsertGrant } from '../storage/grants';
import { createStoredGoogleTokenSet, decryptStoredGoogleTokenSet, exchangeGoogleAuthorizationCode, resolveGoogleIdentity, type StoredGoogleTokenSet } from '../google/oauth';
import { inferGrantedMcpScopes, getRequiredGoogleScopes } from './scopes';
import type { AuthorizationCodePayload, AuthorizationStatePayload } from './types';

export async function handleGoogleCallback(request: Request, config: AppConfig, db: DbLike): Promise<Response> {
  const url = new URL(request.url);
  const stateId = url.searchParams.get('state');
  const googleCode = url.searchParams.get('code');
  const googleError = url.searchParams.get('error');

  if (!stateId) {
    throw new HttpError(400, 'invalid_request', 'Missing state');
  }
  if (googleError) {
    throw new HttpError(400, 'access_denied', `Google OAuth failed: ${googleError}`);
  }
  if (!googleCode) {
    throw new HttpError(400, 'invalid_request', 'Missing Google authorization code');
  }

  const storedState = await getOAuthState(db, stateId);
  if (!storedState) {
    throw new HttpError(400, 'invalid_request', 'OAuth state was not found');
  }
  if (Date.parse(storedState.expires_at) <= Date.now()) {
    await deleteOAuthState(db, stateId);
    throw new HttpError(400, 'invalid_request', 'OAuth state is expired');
  }

  const validatedStatePayload = await decryptJson<AuthorizationStatePayload>(storedState.parsed_envelope, config.tokenEncryptionKey, {
    kind: 'oauth_state',
    state_id: stateId,
  });

  try {
    const googleTokenResponse = await exchangeGoogleAuthorizationCode(config, googleCode);
    const requestedGoogleScopes = getRequiredGoogleScopes(config, validatedStatePayload.scope);
    const identity = await resolveGoogleIdentity(config, googleTokenResponse.access_token);
    const namespacedSubject = validatedStatePayload.grantNamespace
      ? makeNamespacedSubject(identity.subject, validatedStatePayload.grantNamespace)
      : identity.subject;
    const existingGrant = validatedStatePayload.grantNamespace
      ? await getGrantBySubjectNamespace(db, identity.subject, validatedStatePayload.grantNamespace)
      : await getGrantBySubject(db, identity.subject);
    const existingTokenSet = existingGrant
      ? await decryptStoredGoogleTokenSet(config, existingGrant)
      : undefined;
    const tokenSet = createStoredGoogleTokenSet(googleTokenResponse, requestedGoogleScopes, identity, existingTokenSet);
    const requestedMcpScopes = new Set(validatedStatePayload.scope.split(' ').filter(Boolean));
    const grantedMcpScopes = inferGrantedMcpScopes(config, tokenSet.grantedGoogleScopes)
      .filter((scope) => requestedMcpScopes.has(scope));
    if (tokenSet.refreshToken && requestedMcpScopes.has('offline_access')) {
      grantedMcpScopes.push('offline_access');
    }
    grantedMcpScopes.sort();

    const grantId = existingGrant?.grant_id ?? crypto.randomUUID();
    await upsertGrant(db, {
      grantId,
      subject: namespacedSubject,
      encryptedGoogleTokens: await encryptJson(tokenSet, config.tokenEncryptionKey, {
        grant_id: grantId,
        subject: namespacedSubject,
        kind: 'google_tokens',
      }),
      grantedMcpScopes: grantedMcpScopes.join(' '),
      grantedGoogleScopes: tokenSet.grantedGoogleScopes.join(' '),
    });

    const authorizationCode = randomOpaqueToken(32);
    const authorizationCodeHash = await sha256Hex(authorizationCode);
    const codePayload: AuthorizationCodePayload = {
      v: 1,
      kind: 'worker_authorization_code',
      clientId: validatedStatePayload.clientId,
      redirectUri: validatedStatePayload.redirectUri,
      codeChallenge: validatedStatePayload.codeChallenge,
      codeChallengeMethod: validatedStatePayload.codeChallengeMethod,
      resource: validatedStatePayload.resource,
      scope: grantedMcpScopes.join(' '),
      grantId,
      subject: namespacedSubject,
      createdAt: new Date().toISOString(),
    };

    await cleanupExpiredCodes(db, new Date().toISOString());
    await createOAuthCode(db, {
      codeHash: authorizationCodeHash,
      encryptedPayload: await encryptJson(codePayload, config.tokenEncryptionKey, {
        kind: 'oauth_code',
        code_hash: authorizationCodeHash,
        client_id: validatedStatePayload.clientId,
      }),
      expiresAt: new Date(Date.now() + config.authCodeTtlSeconds * 1000).toISOString(),
    });

    await deleteOAuthState(db, stateId);

    return buildAuthorizationCodeRedirect(validatedStatePayload, authorizationCode);
  } catch (error) {
    console.error('google_callback_failed', {
      url: redactUrl(request.url),
      state_id: stateId ? '[REDACTED]' : undefined,
      client_id: validatedStatePayload.clientId,
      redirect_uri: redactUrl(validatedStatePayload.redirectUri),
      requested_scope: validatedStatePayload.scope,
      error_name: error instanceof Error ? error.name : typeof error,
      error_details: error && typeof error === 'object' ? redactObject(error as Record<string, unknown>) : undefined,
    });
    throw error;
  }
}

export function buildAuthorizationCodeRedirect(validatedStatePayload: AuthorizationStatePayload, authorizationCode: string): Response {
  const redirectUrl = new URL(validatedStatePayload.redirectUri);
  redirectUrl.searchParams.set('code', authorizationCode);
  if (validatedStatePayload.state) {
    redirectUrl.searchParams.set('state', validatedStatePayload.state);
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectUrl.toString(),
      'cache-control': 'no-store',
    },
  });
}

export function handleGoogleStart(): Response {
  return new Response('Use /authorize to start the OAuth flow.', { status: 400 });
}
