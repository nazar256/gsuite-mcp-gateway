import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from './errors';

export async function signJwt<T extends Record<string, unknown>>(
  claims: T,
  secret: Uint8Array,
  headerType = 'JWT',
): Promise<string> {
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: headerType })
    .sign(secret);
}

export async function verifyJwt<T extends JWTPayload & { typ?: string }>(
  token: string,
  secret: Uint8Array,
  params: {
    issuer: string;
    audience: string;
    typ: string;
    status?: number;
    code?: string;
    message?: string;
  },
): Promise<T> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: params.issuer,
      audience: params.audience,
    });

    if (payload.typ !== params.typ) {
      throw new HttpError(params.status ?? 401, params.code ?? 'invalid_token', params.message ?? 'Token type is invalid');
    }

    return payload as T;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(params.status ?? 401, params.code ?? 'invalid_token', params.message ?? 'Token verification failed');
  }
}
