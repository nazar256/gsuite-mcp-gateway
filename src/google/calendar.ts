import { expectGoogleJson } from './errors';

function buildCalendarHeaders(accessToken: string): HeadersInit {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

export interface GoogleCalendarClient {
  listCalendars(): Promise<unknown>;
  getEvent(calendarId: string, eventId: string): Promise<unknown>;
  listEvents(calendarId: string, params: Record<string, string>): Promise<unknown>;
  freebusy(body: Record<string, unknown>): Promise<unknown>;
  createEvent(calendarId: string, body: Record<string, unknown>, sendUpdates: string, conferenceDataVersion?: number): Promise<unknown>;
  updateEvent(calendarId: string, eventId: string, body: Record<string, unknown>, sendUpdates: string, conferenceDataVersion?: number): Promise<unknown>;
  deleteEvent(calendarId: string, eventId: string, sendUpdates: string): Promise<unknown>;
}

export function createGoogleCalendarClient(accessToken: string, fetchImpl: typeof fetch): GoogleCalendarClient {
  return {
    async listCalendars() {
      const response = await fetchImpl('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: buildCalendarHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async getEvent(calendarId, eventId) {
      const response = await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        headers: buildCalendarHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async listEvents(calendarId, params) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: buildCalendarHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async freebusy(body) {
      const response = await fetchImpl('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: buildCalendarHeaders(accessToken),
        body: JSON.stringify(body),
      });
      return expectGoogleJson(response);
    },
    async createEvent(calendarId, body, sendUpdates, conferenceDataVersion) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('sendUpdates', sendUpdates);
      if (conferenceDataVersion) {
        url.searchParams.set('conferenceDataVersion', String(conferenceDataVersion));
      }
      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: buildCalendarHeaders(accessToken),
        body: JSON.stringify(body),
      });
      return expectGoogleJson(response);
    },
    async updateEvent(calendarId, eventId, body, sendUpdates, conferenceDataVersion) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set('sendUpdates', sendUpdates);
      if (conferenceDataVersion) {
        url.searchParams.set('conferenceDataVersion', String(conferenceDataVersion));
      }
      const response = await fetchImpl(url.toString(), {
        method: 'PATCH',
        headers: buildCalendarHeaders(accessToken),
        body: JSON.stringify(body),
      });
      return expectGoogleJson(response);
    },
    async deleteEvent(calendarId, eventId, sendUpdates) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      url.searchParams.set('sendUpdates', sendUpdates);
      const response = await fetchImpl(url.toString(), {
        method: 'DELETE',
        headers: buildCalendarHeaders(accessToken),
      });
      if (!response.ok && response.status !== 204) {
        await expectGoogleJson(response);
      }
      return { ok: true };
    },
  };
}
