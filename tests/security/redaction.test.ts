import { describe, expect, it } from 'vitest';
import { redactObject, redactUrl } from '../../src/security/redaction';

describe('redaction helpers', () => {
  it('redacts callback code and state query parameters', () => {
    expect(redactUrl('https://example.com/oauth/google/callback?state=abc&code=xyz&scope=calendar.read')).toBe(
      'https://example.com/oauth/google/callback?state=%5BREDACTED%5D&code=%5BREDACTED%5D&scope=calendar.read',
    );
  });

  it('redacts nested sensitive fields recursively', () => {
    expect(redactObject({
      nested: {
        access_token: 'secret-value',
        deep: [{ refresh_token: 'secret-refresh' }],
      },
    })).toEqual({
      nested: {
        access_token: '[REDACTED]',
        deep: [{ refresh_token: '[REDACTED]' }],
      },
    });
  });
});
