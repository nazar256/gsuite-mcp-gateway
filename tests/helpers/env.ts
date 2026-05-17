import type { Env } from '../../src/config';

const BASE64_32 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: overrides.DB as D1Database,
    APP_ENV: 'development',
    OAUTH_ISSUER: 'http://localhost:8787',
    MCP_RESOURCE: 'http://localhost:8787/mcp',
    MCP_AUDIENCE: 'http://localhost:8787/mcp',
    GOOGLE_CALLBACK_URL: 'http://localhost:8787/oauth/google/callback',
    GOOGLE_CALENDAR_WRITE_SCOPE_MODE: 'all',
    AUTH_STORAGE_MODE: 'd1',
    DEFAULT_TIME_ZONE: 'Europe/Amsterdam',
    ACCESS_TOKEN_TTL_SECONDS: '3600',
    AUTH_CODE_TTL_SECONDS: '180',
    REFRESH_TOKEN_TTL_SECONDS: '2592000',
    STATE_TTL_SECONDS: '1200',
    REDIRECT_URI_ALLOWLIST: 'https://chatgpt.com/connector/oauth/*,http://localhost:*,http://127.0.0.1:*',
    ALLOWED_ORIGINS: 'https://chatgpt.com,http://localhost:*,http://127.0.0.1:*',
    JWT_SIGNING_KEY_B64: BASE64_32,
    TOKEN_ENC_KEY_B64: BASE64_32,
    CSRF_SIGNING_KEY_B64: BASE64_32,
    GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    fetch,
    ...overrides,
  };
}
