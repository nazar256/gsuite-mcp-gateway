import { describe, expect, it } from 'vitest';
import { createS256CodeChallenge, validateCodeChallengeMethod, validateCodeVerifier } from '../../src/oauth/pkce';

describe('pkce', () => {
  it('builds an S256 code challenge', async () => {
    await expect(createS256CodeChallenge('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a')).resolves.toHaveLength(43);
  });

  it('validates verifier and method', () => {
    expect(validateCodeVerifier('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a')).toContain('abc');
    expect(validateCodeChallengeMethod('S256')).toBe('S256');
    expect(() => validateCodeChallengeMethod('plain')).toThrow('S256');
  });
});
