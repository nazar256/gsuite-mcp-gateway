import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../../src/security/jwt';

const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef');

async function makeToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: 'https://issuer.example',
    aud: 'https://resource.example',
    typ: 'access_token',
    sub: 'grant-123',
    iat: now,
    exp: now + 3600,
    ...overrides,
  }, secret);
}

describe('jwt verification', () => {
  it('verifies a valid token', async () => {
    const token = await makeToken();
    const claims = await verifyJwt(token, secret, {
      issuer: 'https://issuer.example',
      audience: 'https://resource.example',
      typ: 'access_token',
    });
    expect(claims.sub).toBe('grant-123');
  });

  it('rejects the wrong issuer', async () => {
    const token = await makeToken();
    await expect(verifyJwt(token, secret, {
      issuer: 'https://wrong-issuer.example',
      audience: 'https://resource.example',
      typ: 'access_token',
    })).rejects.toThrow('Token verification failed');
  });

  it('rejects the wrong audience', async () => {
    const token = await makeToken();
    await expect(verifyJwt(token, secret, {
      issuer: 'https://issuer.example',
      audience: 'https://wrong-resource.example',
      typ: 'access_token',
    })).rejects.toThrow('Token verification failed');
  });

  it('rejects the wrong token type', async () => {
    const token = await makeToken({ typ: 'refresh_token' });
    await expect(verifyJwt(token, secret, {
      issuer: 'https://issuer.example',
      audience: 'https://resource.example',
      typ: 'access_token',
    })).rejects.toThrow('Token type is invalid');
  });

  it('rejects expired tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await makeToken({ iat: now - 4000, exp: now - 10 });
    await expect(verifyJwt(token, secret, {
      issuer: 'https://issuer.example',
      audience: 'https://resource.example',
      typ: 'access_token',
    })).rejects.toThrow('Token verification failed');
  });
});
