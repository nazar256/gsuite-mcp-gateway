import { HttpError } from '../security/errors';

interface GoogleErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ message?: string; reason?: string }>;
  } | string;
  error_description?: string;
}

function extractMessage(payload: GoogleErrorPayload): string {
  if (typeof payload.error === 'string') {
    return payload.error_description ?? payload.error;
  }

  const nested = payload.error;
  return nested?.message ?? payload.error_description ?? 'Google API request failed';
}

function extractReason(payload: GoogleErrorPayload): string | undefined {
  if (typeof payload.error === 'string') {
    return payload.error;
  }

  return payload.error?.errors?.[0]?.reason ?? payload.error?.status;
}

export async function parseGoogleJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function expectGoogleJson<T>(response: Response): Promise<T> {
  const payload = await parseGoogleJson(response);
  if (!response.ok) {
    const errorPayload = (payload ?? {}) as GoogleErrorPayload;
    const reason = extractReason(errorPayload);
    const message = extractMessage(errorPayload);

    if (reason === 'invalid_grant') {
      throw new HttpError(401, 'invalid_token', 'Google authorization is no longer valid');
    }

    if (reason === 'insufficient_scope' || response.status === 403) {
      throw new HttpError(403, 'insufficient_scope', message);
    }

    if (response.status === 401) {
      throw new HttpError(401, 'invalid_token', message);
    }

    throw new HttpError(response.status, 'google_api_error', message);
  }

  return payload as T;
}
