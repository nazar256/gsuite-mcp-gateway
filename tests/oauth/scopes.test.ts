import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/env';
import { parseConfig } from '../../src/config';
import { getRequiredGoogleScopes, hasScope, inferGrantedMcpScopes, normalizeMcpScope } from '../../src/oauth/scopes';

describe('oauth scopes', () => {
  it('normalizes supported scope order', () => {
    expect(normalizeMcpScope('gmail.send calendar.read gmail.send')).toBe('calendar.read gmail.send');
  });

  it('maps calendar.write according to mode', () => {
    const owned = parseConfig(createTestEnv({ GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'owned' }));
    expect(getRequiredGoogleScopes(owned, 'calendar.write')).toContain('https://www.googleapis.com/auth/calendar.events.owned');

    const all = parseConfig(createTestEnv({ GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'all' }));
    expect(getRequiredGoogleScopes(all, 'calendar.write')).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('keeps calendar.read scoped to calendar permissions only', () => {
    const config = parseConfig(createTestEnv());
    expect(getRequiredGoogleScopes(config, 'calendar.read')).toEqual([
      'email',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'openid',
    ]);
  });

  it('infers granted mcp scopes from google scopes', () => {
    const config = parseConfig(createTestEnv());
    expect(inferGrantedMcpScopes(config, [
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/gmail.send',
    ])).toEqual(['calendar.read', 'gmail.send']);
  });

  it('checks granted scope membership', () => {
    expect(hasScope('calendar.read gmail.read', 'gmail.read')).toBe(true);
    expect(hasScope('calendar.read gmail.read', 'gmail.send')).toBe(false);
  });
});
