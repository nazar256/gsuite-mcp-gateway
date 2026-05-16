type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
}

export interface GoogleFetchMock {
  fetch: typeof fetch;
  requests: CapturedRequest[];
}

export function createGoogleFetchMock(routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>): GoogleFetchMock {
  const requests: CapturedRequest[] = [];

  const fetchMock: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const bodyText = request.body ? await request.clone().text() : undefined;
    const capturedRequest: CapturedRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    };
    if (bodyText !== undefined) {
      capturedRequest.bodyText = bodyText;
    }
    requests.push(capturedRequest);

    const match = Object.entries(routes).find(([prefix]) => request.url.startsWith(prefix));
    if (!match) {
      throw new Error(`No mock response configured for ${request.url}`);
    }
    const [, handler] = match;
    return typeof handler === 'function' ? await handler(request) : handler.clone();
  };

  return { fetch: fetchMock, requests };
}

export function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
