import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleCalendarClient } from '../../src/google/calendar';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

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

  it('supports all-day event payloads', async () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv({
      fetch: createGoogleFetchMock({
        'https://www.googleapis.com/calendar/v3/calendars/primary/events': jsonResponse({ id: 'evt-2', start: { date: '2026-05-20' }, end: { date: '2026-05-21' } }),
      }).fetch,
    })), {
      googleAccessToken: 'token-1',
      grantedScope: 'calendar.write',
    });

    const tool = (server as any)._registeredTools?.calendar_create_event;
    const result = await tool.handler({
      summary: 'All day',
      start: { date: '2026-05-20' },
      end: { date: '2026-05-21' },
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.start.date).toBe('2026-05-20');
  });

  it('rejects updating only start without end', async () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'calendar.write',
    });

    const tool = (server as any)._registeredTools?.calendar_update_event;
    const result = await tool.handler({
      calendarId: 'primary',
      eventId: 'evt-1',
      start: { dateTime: '2026-05-20T09:00:00+02:00' },
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/updated together/i);
  });

  it('registers output schemas for calendar tools', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'calendar.read calendar.write',
    });

    const freebusy = (server as any)._registeredTools?.calendar_find_freebusy;
    const createEvent = (server as any)._registeredTools?.calendar_create_event;
    const deleteEvent = (server as any)._registeredTools?.calendar_delete_event;

    expect(freebusy?.outputSchema).toBeDefined();
    expect(createEvent?.outputSchema).toBeDefined();
    expect(deleteEvent?.outputSchema).toBeDefined();
  });
});
