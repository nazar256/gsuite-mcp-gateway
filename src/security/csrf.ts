import { base64UrlDecode, base64UrlEncode, toArrayBuffer } from './crypto';
import { HttpError } from './errors';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSignedToken(secret: Uint8Array, payload: Record<string, unknown>): Promise<string> {
  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(encodedPayload));
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySignedToken<T extends Record<string, unknown>>(secret: Uint8Array, token: string): Promise<T> {
  const [encodedPayload, encodedSignature] = token.split('.');
  if (!encodedPayload || !encodedSignature) {
    throw new HttpError(400, 'invalid_request', 'Signed token is invalid');
  }

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(base64UrlDecode(encodedSignature)),
    textEncoder.encode(encodedPayload),
  );

  if (!valid) {
    throw new HttpError(400, 'invalid_request', 'Signed token is invalid');
  }

  return JSON.parse(textDecoder.decode(base64UrlDecode(encodedPayload))) as T;
}

export async function createCsrfToken(secret: Uint8Array, payload: Record<string, unknown> & { exp: number }): Promise<string> {
  return createSignedToken(secret, payload);
}

export async function verifyCsrfToken<T extends Record<string, unknown> & { exp: number }>(secret: Uint8Array, token: string): Promise<T> {
  const payload = await verifySignedToken<T>(secret, token);
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(400, 'invalid_request', 'CSRF token is expired');
  }
  return payload;
}
