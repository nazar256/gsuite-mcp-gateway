import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/env';
import { parseConfig } from '../../src/config';
import { parseAuthorizationRequest, parseRegistrationRequest, validateOrigin, validateRedirectUri, validateResource } from '../../src/oauth/validation';

describe('oauth validation', () => {
  const config = parseConfig(createTestEnv());

  it('accepts allowlisted redirect uris', () => {
    expect(validateRedirectUri('https://chatgpt.com/connector/oauth/abc', config).toString()).toContain('https://chatgpt.com/connector/oauth/abc');
    expect(validateRedirectUri('http://localhost:8787/callback', config).toString()).toContain('http://localhost:8787/callback');
  });

  it('rejects non-allowlisted redirect uris', () => {
    expect(() => validateRedirectUri('https://evil.example/callback', config)).toThrow('allowlisted');
  });

  it('validates origin and resource', () => {
    expect(() => validateOrigin('https://chatgpt.com', config)).not.toThrow();
    expect(() => validateOrigin('https://evil.example', config)).toThrow('Origin is not allowed');
    expect(validateResource(undefined, config)).toBe(config.mcpResource);
  });

  it('parses authorization requests', () => {
    const request = new Request('http://localhost:8787/authorize?response_type=code&client_id=test&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fabc&state=xyz&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A8787%2Fmcp&scope=gmail.send%20calendar.write');
    const parsed = parseAuthorizationRequest(request, config);
    expect(parsed.scope).toBe('calendar.write gmail.send');
    expect(parsed.state).toBe('xyz');
  });

  it('parses registration request', () => {
    const parsed = parseRegistrationRequest({
      redirect_uris: ['https://chatgpt.com/connector/oauth/abc'],
      client_name: 'Example',
      token_endpoint_auth_method: 'none',
    }, config);
    expect(parsed.clientName).toBe('Example');
    expect(parsed.redirectUris).toHaveLength(1);
  });
});
