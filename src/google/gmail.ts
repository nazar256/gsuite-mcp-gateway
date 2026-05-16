import { expectGoogleJson } from './errors';

function buildHeaders(accessToken: string): HeadersInit {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

export interface GoogleGmailClient {
  getProfile(): Promise<unknown>;
  listLabels(): Promise<unknown>;
  listMessages(params: Record<string, string>): Promise<unknown>;
  getMessage(id: string, params: Record<string, string | string[]>): Promise<unknown>;
  createDraft(raw: string, threadId?: string): Promise<unknown>;
  sendMessage(raw: string, threadId?: string): Promise<unknown>;
  modifyMessageLabels(id: string, body: Record<string, unknown>): Promise<unknown>;
  trashMessage(id: string): Promise<unknown>;
}

export function createGoogleGmailClient(accessToken: string, fetchImpl: typeof fetch): GoogleGmailClient {
  return {
    async getProfile() {
      const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: buildHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async listLabels() {
      const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
        headers: buildHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async listMessages(params) {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: buildHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async getMessage(id, params) {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry) url.searchParams.append(key, entry);
          }
          continue;
        }
        if (value) url.searchParams.append(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: buildHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async createDraft(raw, threadId) {
      const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
      });
      return expectGoogleJson(response);
    },
    async sendMessage(raw, threadId) {
      const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
      });
      return expectGoogleJson(response);
    },
    async modifyMessageLabels(id, body) {
      const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify(body),
      });
      return expectGoogleJson(response);
    },
    async trashMessage(id) {
      const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, {
        method: 'POST',
        headers: buildHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
  };
}
