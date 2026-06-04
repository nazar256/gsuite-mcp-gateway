import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleCalendarClient } from '../../google/calendar';
import { hasScope } from '../../oauth/scopes';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

const RFC3339 = z.string().datetime({ offset: true });
const allDayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date');
const emailList = z.array(z.string().email()).max(100).optional();

const eventDateTimeInput = z.object({
  dateTime: RFC3339,
  timeZone: z.string().optional(),
});

const allDayDateInput = z.object({
  date: allDayDate,
  timeZone: z.string().optional(),
});

const eventWhenInput = z.union([eventDateTimeInput, allDayDateInput]);
const eventDateTimeOutput = z.object({
  dateTime: z.string(),
  timeZone: z.string().optional(),
}).passthrough();
const allDayDateOutput = z.object({
  date: z.string(),
  timeZone: z.string().optional(),
}).passthrough();
const eventWhenOutput = z.union([eventDateTimeOutput, allDayDateOutput]);
const calendarListItemOutput = z.object({
  id: z.string().optional(),
  summary: z.string().optional(),
  primary: z.boolean().optional(),
  accessRole: z.string().optional(),
  timeZone: z.string().optional(),
}).passthrough();
const calendarAttendeeOutput = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
}).passthrough();
const calendarEventOutput = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  start: eventWhenOutput.optional(),
  end: eventWhenOutput.optional(),
  attendees: z.array(calendarAttendeeOutput).optional(),
  conferenceData: z.record(z.unknown()).optional(),
}).passthrough();
const calendarListCalendarsOutput = z.object({
  items: z.array(calendarListItemOutput),
});
const calendarListEventsOutput = z.object({
  items: z.array(calendarEventOutput),
});
const calendarFreeBusyOutput = z.object({
  kind: z.string().optional(),
  timeMin: z.string().optional(),
  timeMax: z.string().optional(),
  calendars: z.record(z.object({
    busy: z.array(z.object({
      start: z.string(),
      end: z.string(),
    }).passthrough()).optional(),
    errors: z.array(z.object({
      domain: z.string().optional(),
      reason: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();
const okOutput = z.object({ ok: z.literal(true) });

function okResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(error: HttpError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error.message }],
    _meta: error.mcpWwwAuthenticate ? { 'mcp/www_authenticate': error.mcpWwwAuthenticate } : undefined,
  };
}

function sanitizeEvent(event: any) {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    htmlLink: event.htmlLink,
    start: event.start,
    end: event.end,
    attendees: event.attendees,
    conferenceData: event.conferenceData,
  };
}

function isDateTimeWhen(value: z.infer<typeof eventWhenInput>): value is z.infer<typeof eventDateTimeInput> {
  return 'dateTime' in value;
}

function toGoogleEventTime(value: z.infer<typeof eventWhenInput>, defaultTimeZone: string): Record<string, string> {
  if (isDateTimeWhen(value)) {
    return {
      dateTime: value.dateTime,
      timeZone: value.timeZone ?? defaultTimeZone,
    };
  }

  return {
    date: value.date,
    ...(value.timeZone ? { timeZone: value.timeZone } : {}),
  };
}

function compareEventTimes(start: z.infer<typeof eventWhenInput>, end: z.infer<typeof eventWhenInput>): number {
  if (isDateTimeWhen(start) !== isDateTimeWhen(end)) {
    throw new HttpError(400, 'invalid_request', 'start and end must both use dateTime or both use date');
  }

  if (isDateTimeWhen(start) && isDateTimeWhen(end)) {
    return Date.parse(start.dateTime) - Date.parse(end.dateTime);
  }

  const startDate = `${(start as z.infer<typeof allDayDateInput>).date}T00:00:00.000Z`;
  const endDate = `${(end as z.infer<typeof allDayDateInput>).date}T00:00:00.000Z`;
  return Date.parse(startDate) - Date.parse(endDate);
}

export function registerCalendarTools(
  server: McpServer,
  config: AppConfig,
  client: GoogleCalendarClient,
  grantedScope: string,
): void {
  const register = <T extends z.ZodRawShape>(
    name: string,
    scope: 'calendar.read' | 'calendar.write',
    description: string,
    inputSchema: T,
    outputSchema: z.ZodTypeAny,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnlyHint: boolean,
    destructiveHint = false,
    idempotentHint = readOnlyHint,
  ) => {
    if (!hasScope(grantedScope, scope)) {
      return;
    }

    (server.registerTool as any)(name, {
      title: name,
      description,
      inputSchema,
      outputSchema,
        annotations: {
          title: name,
          readOnlyHint,
          destructiveHint,
          idempotentHint,
          openWorldHint: false,
        },
      _meta: {
        securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
      },
    }, async (args: z.infer<z.ZodObject<T>>) => {
      try {
        ensureRequiredScope(config, grantedScope, scope);
        const parsed = z.object(inputSchema).parse(args);
        return okResult(await handler(parsed));
      } catch (error) {
        const httpError = error instanceof HttpError
          ? error
          : error instanceof z.ZodError
            ? new HttpError(400, 'invalid_request', error.issues[0]?.message ?? 'Invalid input')
            : new HttpError(500, 'internal_error', 'Internal server error');
        return errorResult(httpError);
      }
    });
  };

  register(
    'calendar_list_calendars',
    'calendar.read',
    'List available calendars with ids, summaries, roles, and time zones.',
    {},
    calendarListCalendarsOutput,
    async () => {
      const response = await client.listCalendars() as any;
      return {
        items: (response.items ?? []).map((item: any) => ({
          id: item.id,
          summary: item.summary,
          primary: item.primary,
          accessRole: item.accessRole,
          timeZone: item.timeZone,
        })),
      };
    },
    true,
  );

  register(
    'calendar_get_event',
    'calendar.read',
    'Get one Google Calendar event by calendar id and event id.',
    {
      calendarId: z.string().default('primary').optional(),
      eventId: z.string().min(1),
    },
    calendarEventOutput,
    async ({ calendarId = 'primary', eventId }) => sanitizeEvent(await client.getEvent(calendarId, eventId)),
    true,
  );

  register(
    'calendar_list_events',
    'calendar.read',
    'List calendar events in a time range or by query.',
    {
      calendarId: z.string().default('primary').optional(),
      timeMin: RFC3339.optional(),
      timeMax: RFC3339.optional(),
      query: z.string().max(500).optional(),
      maxResults: z.number().int().min(1).max(50).default(10).optional(),
      singleEvents: z.boolean().default(true).optional(),
      orderBy: z.enum(['startTime', 'updated']).optional(),
    },
    calendarListEventsOutput,
    async ({ calendarId = 'primary', timeMin, timeMax, query, maxResults = 10, singleEvents = true, orderBy }) => {
      const response = await client.listEvents(calendarId, {
        ...(timeMin ? { timeMin } : {}),
        ...(timeMax ? { timeMax } : {}),
        ...(query ? { q: query } : {}),
        maxResults: String(maxResults),
        singleEvents: String(singleEvents),
        ...(orderBy ? { orderBy } : {}),
      }) as any;
      return { items: (response.items ?? []).map(sanitizeEvent) };
    },
    true,
  );

  register(
    'calendar_find_freebusy',
    'calendar.read',
    'Find busy blocks across one or more calendars.',
    {
      calendarIds: z.array(z.string()).max(20).optional(),
      timeMin: RFC3339,
      timeMax: RFC3339,
      timeZone: z.string().optional(),
    },
    calendarFreeBusyOutput,
    async ({ calendarIds = ['primary'], timeMin, timeMax, timeZone }) => {
      return client.freebusy({
        timeMin,
        timeMax,
        ...(timeZone ? { timeZone } : {}),
        items: calendarIds.map((id) => ({ id })),
      });
    },
    true,
  );

  register(
    'calendar_create_event',
    'calendar.write',
    'Create a Google Calendar event, optionally with attendees, reminders, and Google Meet.',
    {
      calendarId: z.string().default('primary').optional(),
      summary: z.string().min(1).max(500),
      description: z.string().max(5000).optional(),
      location: z.string().max(1000).optional(),
      start: eventWhenInput,
      end: eventWhenInput,
      attendeeEmails: emailList,
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
      addGoogleMeet: z.boolean().default(false).optional(),
      reminders: z.object({
        useDefault: z.boolean().optional(),
        overrides: z.array(z.object({ method: z.enum(['email', 'popup']), minutes: z.number().int().min(0).max(40320) })).max(10).optional(),
      }).optional(),
    },
    calendarEventOutput,
    async ({ calendarId = 'primary', summary, description, location, start, end, attendeeEmails, sendUpdates, addGoogleMeet, reminders }) => {
      if (compareEventTimes(start, end) >= 0) {
        throw new HttpError(400, 'invalid_request', 'start must be before end');
      }

      const resolvedSendUpdates = sendUpdates ?? ((attendeeEmails?.length ?? 0) > 0 ? 'all' : 'none');
      const body: Record<string, unknown> = {
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start: toGoogleEventTime(start, config.defaultTimeZone),
        end: toGoogleEventTime(end, config.defaultTimeZone),
        ...(attendeeEmails?.length ? { attendees: attendeeEmails.map((email) => ({ email })) } : {}),
        ...(reminders ? { reminders } : {}),
      };
      if (addGoogleMeet) {
        body.conferenceData = {
          createRequest: {
            requestId: crypto.randomUUID(),
          },
        };
      }

      const response = await client.createEvent(calendarId, body, resolvedSendUpdates, addGoogleMeet ? 1 : undefined);
      return sanitizeEvent(response);
    },
    false,
  );

  register(
    'calendar_update_event',
    'calendar.write',
    'Patch an existing Google Calendar event.',
    {
      calendarId: z.string().default('primary').optional(),
      eventId: z.string().min(1),
      summary: z.string().min(1).max(500).optional(),
      description: z.string().max(5000).optional(),
      location: z.string().max(1000).optional(),
      start: eventWhenInput.optional(),
      end: eventWhenInput.optional(),
      attendeeEmails: emailList,
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('all').optional(),
      addGoogleMeet: z.boolean().optional(),
      reminders: z.object({
        useDefault: z.boolean().optional(),
        overrides: z.array(z.object({ method: z.enum(['email', 'popup']), minutes: z.number().int().min(0).max(40320) })).max(10).optional(),
      }).optional(),
    },
    calendarEventOutput,
    async ({ calendarId = 'primary', eventId, summary, description, location, start, end, attendeeEmails, sendUpdates = 'all', addGoogleMeet, reminders }) => {
      if ((start && !end) || (!start && end)) {
        throw new HttpError(400, 'invalid_request', 'start and end must be updated together');
      }

      if (start && end && compareEventTimes(start, end) >= 0) {
        throw new HttpError(400, 'invalid_request', 'start must be before end');
      }

      const body: Record<string, unknown> = {
        ...(summary ? { summary } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(start && end ? {
          start: toGoogleEventTime(start, config.defaultTimeZone),
          end: toGoogleEventTime(end, config.defaultTimeZone),
        } : {}),
        ...(attendeeEmails ? { attendees: attendeeEmails.map((email) => ({ email })) } : {}),
        ...(reminders ? { reminders } : {}),
      };
      if (addGoogleMeet) {
        body.conferenceData = { createRequest: { requestId: crypto.randomUUID() } };
      }

      return sanitizeEvent(await client.updateEvent(calendarId, eventId, body, sendUpdates, addGoogleMeet ? 1 : undefined));
    },
    false,
  );

  register(
    'calendar_delete_event',
    'calendar.write',
    'Delete a Google Calendar event.',
    {
      calendarId: z.string().default('primary').optional(),
      eventId: z.string().min(1),
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('all').optional(),
    },
    okOutput,
    async ({ calendarId = 'primary', eventId, sendUpdates = 'all' }) => {
      return client.deleteEvent(calendarId, eventId, sendUpdates);
    },
    false,
    true,
  );
}
