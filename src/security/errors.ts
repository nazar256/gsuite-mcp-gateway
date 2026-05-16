export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: HeadersInit | undefined;
  readonly mcpWwwAuthenticate: string[] | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: {
      headers?: HeadersInit;
      mcpWwwAuthenticate?: string[];
    },
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = options?.headers;
    this.mcpWwwAuthenticate = options?.mcpWwwAuthenticate;
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  return new HttpError(500, 'internal_error', 'Internal server error');
}
