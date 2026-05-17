import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/env';
import { parseConfig } from '../../src/config';
import { getRequiredGoogleScopes, hasScope, inferGrantedMcpScopes, normalizeMcpScope } from '../../src/oauth/scopes';

describe('oauth scopes', () => {
  it('normalizes supported scope order', () => {
    expect(normalizeMcpScope('gmail.send calendar.write gmail.send')).toBe('calendar.write gmail.send');
  });

  it('maps calendar.write according to mode', () => {
    const owned = parseConfig(createTestEnv({ GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'owned' }));
    expect(getRequiredGoogleScopes(owned, 'calendar.write')).toContain('https://www.googleapis.com/auth/calendar.events.owned');

    const all = parseConfig(createTestEnv({ GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'all' }));
    expect(getRequiredGoogleScopes(all, 'calendar.write')).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('keeps calendar.write scoped to write calendar permissions plus identity', () => {
    const config = parseConfig(createTestEnv());
    expect(getRequiredGoogleScopes(config, 'calendar.write')).toEqual([
      'email',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'openid',
      'profile',
    ]);
  });

  it('infers granted mcp scopes from google scopes', () => {
    const config = parseConfig(createTestEnv());
    expect(inferGrantedMcpScopes(config, [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/gmail.send',
    ])).toEqual(['calendar.write', 'gmail.send']);
  });

  it('checks granted scope membership', () => {
    expect(hasScope('calendar.write gmail.send', 'gmail.send')).toBe(true);
    expect(hasScope('calendar.write gmail.send', 'gmail.drafts')).toBe(false);
  });
});
