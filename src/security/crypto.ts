import { HttpError } from './errors';

export interface EncryptedEnvelope {
  v: 1;
  alg: 'A128GCM' | 'A256GCM';
  iv: string;
  ct: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const decoded = atob(`${normalized}${padding}`);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function base64Decode(value: string): Uint8Array {
  const decoded = atob(value.trim());
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

export function randomOpaqueToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function algorithmForKey(keyBytes: Uint8Array): 'A128GCM' | 'A256GCM' {
  return keyBytes.byteLength === 16 ? 'A128GCM' : 'A256GCM';
}

export async function encryptJson(value: unknown, keyBytes: Uint8Array, aad: Record<string, unknown>): Promise<EncryptedEnvelope> {
  const key = await importAesKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(textEncoder.encode(canonicalize(aad))),
    },
    key,
    toArrayBuffer(textEncoder.encode(JSON.stringify(value))),
  );

  return {
    v: 1,
    alg: algorithmForKey(keyBytes),
    iv: base64UrlEncode(iv),
    ct: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson<T>(envelope: EncryptedEnvelope, keyBytes: Uint8Array, aad: Record<string, unknown>): Promise<T> {
  try {
    const key = await importAesKey(keyBytes);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(envelope.iv)),
        additionalData: toArrayBuffer(textEncoder.encode(canonicalize(aad))),
      },
      key,
      toArrayBuffer(base64UrlDecode(envelope.ct)),
    );

    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch {
    throw new HttpError(401, 'invalid_token', 'Encrypted state could not be decrypted');
  }
}

export function stringifyEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(input: string): EncryptedEnvelope {
  const parsed = JSON.parse(input) as EncryptedEnvelope;
  if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.ct || !parsed.alg) {
    throw new HttpError(500, 'invalid_state', 'Encrypted payload is malformed');
  }
  return parsed;
}
