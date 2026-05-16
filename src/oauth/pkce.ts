import { sha256Base64Url } from '../security/crypto';

const PKCE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function validateCodeChallenge(value: string | null | undefined): string {
  if (!value || !PKCE_PATTERN.test(value)) {
    throw new Error('code_challenge is invalid');
  }
  return value;
}

export function validateCodeVerifier(value: string | null | undefined): string {
  if (!value || !PKCE_PATTERN.test(value)) {
    throw new Error('code_verifier is invalid');
  }
  return value;
}

export function validateCodeChallengeMethod(value: string | null | undefined): 'S256' {
  if (value !== 'S256') {
    throw new Error('code_challenge_method must be S256');
  }
  return 'S256';
}

export async function createS256CodeChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}
