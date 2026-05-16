import { describe, expect, it } from 'vitest';
import { base64UrlDecode, base64UrlEncode, canonicalize, decryptJson, encryptJson } from '../../src/security/crypto';

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe('security crypto', () => {
  it('round-trips base64url encoding', () => {
    const encoded = base64UrlEncode(new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode(base64UrlDecode(encoded))).toBe('hello');
  });

  it('canonicalizes object keys deterministically', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('encrypts and decrypts json with aad', async () => {
    const envelope = await encryptJson({ hello: 'world' }, key, { test: true });
    await expect(decryptJson<{ hello: string }>(envelope, key, { test: true })).resolves.toEqual({ hello: 'world' });
  });

  it('fails to decrypt with wrong aad', async () => {
    const envelope = await encryptJson({ hello: 'world' }, key, { test: true });
    await expect(decryptJson(envelope, key, { test: false })).rejects.toThrow('could not be decrypted');
  });
});
