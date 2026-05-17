import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../helpers/env';
import { parseConfig } from '../../src/config';
import { getRequiredGoogleScopes, hasScope, inferGrantedMcpScopes, normalizeGrantedMcpScope, normalizeMcpScope } from '../../src/oauth/scopes';

describe('oauth scopes', () => {
  it('normalizes supported scope order', () => {
    expect(normalizeMcpScope('gmail.send drive.write calendar.write gmail.send')).toBe('calendar.write drive.read drive.write gmail.send');
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
      'https://www.googleapis.com/auth/calendar.events',
      'openid',
      'profile',
    ]);
  });

  it('maps drive scopes to full drive access for filesystem operations', () => {
    const config = parseConfig(createTestEnv());
    expect(getRequiredGoogleScopes(config, 'drive.write')).toEqual([
      'email',
      'https://www.googleapis.com/auth/drive',
      'openid',
      'profile',
    ]);
  });

  it('maps calendar and gmail read/modify scopes', () => {
    const config = parseConfig(createTestEnv());

    expect(getRequiredGoogleScopes(config, 'calendar.read')).toEqual([
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'openid',
      'profile',
    ]);

    expect(getRequiredGoogleScopes(config, 'gmail.modify')).toEqual([
      'email',
      'https://www.googleapis.com/auth/gmail.modify',
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
    ])).toEqual(['gmail.send']);

    expect(inferGrantedMcpScopes(parseConfig(createTestEnv({ GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'owned' })), [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/gmail.send',
    ])).toEqual(['calendar.write', 'gmail.send']);

    expect(inferGrantedMcpScopes(config, [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.modify',
    ])).toEqual(['gmail.read', 'gmail.send', 'gmail.modify', 'gmail.drafts']);
  });

  it('checks granted scope membership', () => {
    expect(hasScope('calendar.write gmail.send', 'gmail.send')).toBe(true);
    expect(hasScope('calendar.write gmail.send', 'calendar.read')).toBe(false);
    expect(hasScope('gmail.modify', 'gmail.read')).toBe(true);
    expect(hasScope('calendar.write gmail.send', 'gmail.drafts')).toBe(false);
  });

  it('does not expand blank granted scopes to the default scope set', () => {
    expect(normalizeGrantedMcpScope('')).toBe('');
    expect(normalizeGrantedMcpScope(undefined)).toBe('');
    expect(hasScope('', 'calendar.write')).toBe(false);
  });
});
