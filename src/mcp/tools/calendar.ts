import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleCalendarClient } from '../../google/calendar';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

const RFC3339 = z.string().datetime({ offset: true });
const emailList = z.array(z.string().email()).max(100).optional();

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
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnlyHint: boolean,
    destructiveHint = false,
  ) => {
    (server.registerTool as any)(name, {
      title: name,
      description,
      inputSchema,
      annotations: {
        title: name,
        readOnlyHint,
        destructiveHint,
        idempotentHint: readOnlyHint || !destructiveHint,
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
      start: RFC3339,
      end: RFC3339,
      timeZone: z.string().optional(),
      attendeeEmails: emailList,
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
      addGoogleMeet: z.boolean().default(false).optional(),
      reminders: z.object({
        useDefault: z.boolean().optional(),
        overrides: z.array(z.object({ method: z.enum(['email', 'popup']), minutes: z.number().int().min(0).max(40320) })).max(10).optional(),
      }).optional(),
    },
    async ({ calendarId = 'primary', summary, description, location, start, end, timeZone, attendeeEmails, sendUpdates, addGoogleMeet, reminders }) => {
      if (Date.parse(start) >= Date.parse(end)) {
        throw new HttpError(400, 'invalid_request', 'start must be before end');
      }

      const resolvedSendUpdates = sendUpdates ?? ((attendeeEmails?.length ?? 0) > 0 ? 'all' : 'none');
      const body: Record<string, unknown> = {
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start: { dateTime: start, ...(timeZone ? { timeZone } : { timeZone: config.defaultTimeZone }) },
        end: { dateTime: end, ...(timeZone ? { timeZone } : { timeZone: config.defaultTimeZone }) },
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
      start: RFC3339.optional(),
      end: RFC3339.optional(),
      timeZone: z.string().optional(),
      attendeeEmails: emailList,
      sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('all').optional(),
      addGoogleMeet: z.boolean().optional(),
      reminders: z.object({
        useDefault: z.boolean().optional(),
        overrides: z.array(z.object({ method: z.enum(['email', 'popup']), minutes: z.number().int().min(0).max(40320) })).max(10).optional(),
      }).optional(),
    },
    async ({ calendarId = 'primary', eventId, summary, description, location, start, end, timeZone, attendeeEmails, sendUpdates = 'all', addGoogleMeet, reminders }) => {
      if (start && end && Date.parse(start) >= Date.parse(end)) {
        throw new HttpError(400, 'invalid_request', 'start must be before end');
      }

      const body: Record<string, unknown> = {
        ...(summary ? { summary } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(start ? { start: { dateTime: start, ...(timeZone ? { timeZone } : { timeZone: config.defaultTimeZone }) } } : {}),
        ...(end ? { end: { dateTime: end, ...(timeZone ? { timeZone } : { timeZone: config.defaultTimeZone }) } } : {}),
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
    async ({ calendarId = 'primary', eventId, sendUpdates = 'all' }) => {
      return client.deleteEvent(calendarId, eventId, sendUpdates);
    },
    false,
    true,
  );
}
