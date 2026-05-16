import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleCalendarClient } from '../../src/google/calendar';

describe('calendar client', () => {
  it('constructs create event request', async () => {
    const mock = createGoogleFetchMock({
      'https://www.googleapis.com/calendar/v3/calendars/primary/events': jsonResponse({ id: 'evt-1' }),
    });
    const client = createGoogleCalendarClient('token-1', mock.fetch);
    await client.createEvent('primary', { summary: 'Test' }, 'all', 1);
    expect(mock.requests[0]?.url).toContain('sendUpdates=all');
    expect(mock.requests[0]?.url).toContain('conferenceDataVersion=1');
  });
});
