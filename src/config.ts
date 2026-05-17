import { z } from 'zod';
import { base64Decode } from './security/crypto';
import { HttpError } from './security/errors';

export interface Env {
  DB: D1Database;
  APP_ENV?: string;
  OAUTH_ISSUER?: string;
  MCP_RESOURCE?: string;
  MCP_AUDIENCE?: string;
  GOOGLE_CALLBACK_URL?: string;
  GOOGLE_CALENDAR_WRITE_SCOPE_MODE?: string;
  AUTH_STORAGE_MODE?: string;
  DEFAULT_TIME_ZONE?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  AUTH_CODE_TTL_SECONDS?: string;
  REFRESH_TOKEN_TTL_SECONDS?: string;
  STATE_TTL_SECONDS?: string;
  REDIRECT_URI_ALLOWLIST?: string;
  ALLOWED_ORIGINS?: string;
  JWT_SIGNING_KEY_B64?: string;
  TOKEN_ENC_KEY_B64?: string;
  CSRF_SIGNING_KEY_B64?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  fetch?: typeof fetch;
}

export const SUPPORTED_MCP_SCOPES = [
  'calendar.read',
  'calendar.write',
  'drive.read',
  'drive.write',
  'gmail.read',
  'gmail.send',
  'gmail.modify',
  'gmail.drafts',
  'offline_access',
] as const;

export type SupportedMcpScope = (typeof SUPPORTED_MCP_SCOPES)[number];

export interface UrlPattern {
  raw: string;
  regex: RegExp;
}

export interface AppConfig {
  appEnv: 'development' | 'production';
  issuer: string;
  issuerUrl: URL;
  mcpResource: string;
  mcpResourceUrl: URL;
  mcpAudience: string;
  googleCallbackUrl: string;
  googleCallbackUrlObject: URL;
  googleCalendarWriteScopeMode: 'owned' | 'all';
  authStorageMode: 'd1';
  defaultTimeZone: string;
  accessTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  stateTtlSeconds: number;
  redirectUriAllowlist: UrlPattern[];
  allowedOrigins: UrlPattern[];
  jwtSigningKey: Uint8Array;
  tokenEncryptionKey: Uint8Array;
  csrfSigningKey: Uint8Array;
  googleClientId: string;
  googleClientSecret: string;
  fetchImpl: typeof fetch;
  supportedScopes: readonly SupportedMcpScope[];
  isLocalDevelopment: boolean;
}

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'production']).default('production'),
  OAUTH_ISSUER: z.string().min(1),
  MCP_RESOURCE: z.string().min(1),
  MCP_AUDIENCE: z.string().min(1),
  GOOGLE_CALLBACK_URL: z.string().min(1),
  // Default to full calendar write scope so shared-calendar event mutations work out of the box.
  GOOGLE_CALENDAR_WRITE_SCOPE_MODE: z.enum(['owned', 'all']).default('all'),
  AUTH_STORAGE_MODE: z.literal('d1').default('d1'),
  DEFAULT_TIME_ZONE: z.string().min(1).default('Europe/Amsterdam'),
  ACCESS_TOKEN_TTL_SECONDS: z.string().default('3600'),
  AUTH_CODE_TTL_SECONDS: z.string().default('180'),
  REFRESH_TOKEN_TTL_SECONDS: z.string().default('2592000'),
  STATE_TTL_SECONDS: z.string().default('1200'),
  REDIRECT_URI_ALLOWLIST: z.string().min(1),
  ALLOWED_ORIGINS: z.string().min(1),
  JWT_SIGNING_KEY_B64: z.string().min(1),
  TOKEN_ENC_KEY_B64: z.string().min(1),
  CSRF_SIGNING_KEY_B64: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized.endsWith('.localhost');
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(500, 'invalid_config', `${name} must be a positive integer`);
  }
  return parsed;
}

function stripTrailingSlash(url: URL): string {
  const text = url.toString();
  return url.pathname === '/' && text.endsWith('/') ? text.slice(0, -1) : text;
}

function validateConfiguredUrl(raw: string, name: string, allowHttpLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(500, 'invalid_config', `${name} must be a valid URL`);
  }

  const isLocalHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttpLoopback && isLocalHttp)) {
    throw new HttpError(500, 'invalid_config', `${name} must use HTTPS${allowHttpLoopback ? ' (or HTTP localhost in development)' : ''}`);
  }

  return url;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function compileUrlPattern(raw: string): UrlPattern {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(500, 'invalid_config', 'URL allowlist pattern cannot be empty');
  }

  return {
    raw: trimmed,
    regex: new RegExp(`^${escapeRegex(trimmed).replace(/\*/g, '.*')}$`, 'i'),
  };
}

function parseUrlPatterns(raw: string, name: string): UrlPattern[] {
  const patterns = raw.split(',').map((value) => value.trim()).filter(Boolean).map(compileUrlPattern);
  if (patterns.length === 0) {
    throw new HttpError(500, 'invalid_config', `${name} must contain at least one pattern`);
  }
  return patterns;
}

function decodeKey(name: string, raw: string, minimumBytes: number, exactBytes?: number[]): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = base64Decode(raw);
  } catch {
    throw new HttpError(500, 'invalid_config', `${name} must be valid base64`);
  }

  if (decoded.byteLength < minimumBytes) {
    throw new HttpError(500, 'invalid_config', `${name} must decode to at least ${minimumBytes} bytes`);
  }
  if (exactBytes && !exactBytes.includes(decoded.byteLength)) {
    throw new HttpError(500, 'invalid_config', `${name} must decode to ${exactBytes.join(', ')} bytes`);
  }

  return decoded;
}

export function parseConfig(env: Env): AppConfig {
  const parsed = envSchema.safeParse({
    APP_ENV: env.APP_ENV,
    OAUTH_ISSUER: env.OAUTH_ISSUER,
    MCP_RESOURCE: env.MCP_RESOURCE,
    MCP_AUDIENCE: env.MCP_AUDIENCE,
    GOOGLE_CALLBACK_URL: env.GOOGLE_CALLBACK_URL,
    GOOGLE_CALENDAR_WRITE_SCOPE_MODE: env.GOOGLE_CALENDAR_WRITE_SCOPE_MODE,
    AUTH_STORAGE_MODE: env.AUTH_STORAGE_MODE,
    DEFAULT_TIME_ZONE: env.DEFAULT_TIME_ZONE,
    ACCESS_TOKEN_TTL_SECONDS: env.ACCESS_TOKEN_TTL_SECONDS,
    AUTH_CODE_TTL_SECONDS: env.AUTH_CODE_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS: env.REFRESH_TOKEN_TTL_SECONDS,
    STATE_TTL_SECONDS: env.STATE_TTL_SECONDS,
    REDIRECT_URI_ALLOWLIST: env.REDIRECT_URI_ALLOWLIST,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    JWT_SIGNING_KEY_B64: env.JWT_SIGNING_KEY_B64,
    TOKEN_ENC_KEY_B64: env.TOKEN_ENC_KEY_B64,
    CSRF_SIGNING_KEY_B64: env.CSRF_SIGNING_KEY_B64,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(500, 'invalid_config', issue?.message ?? 'Configuration is invalid');
  }

  const isLocalDevelopment = parsed.data.APP_ENV === 'development';
  const issuerUrl = validateConfiguredUrl(parsed.data.OAUTH_ISSUER, 'OAUTH_ISSUER', isLocalDevelopment);
  const mcpResourceUrl = validateConfiguredUrl(parsed.data.MCP_RESOURCE, 'MCP_RESOURCE', isLocalDevelopment);
  const mcpAudienceUrl = validateConfiguredUrl(parsed.data.MCP_AUDIENCE, 'MCP_AUDIENCE', isLocalDevelopment);
  const googleCallbackUrlObject = validateConfiguredUrl(parsed.data.GOOGLE_CALLBACK_URL, 'GOOGLE_CALLBACK_URL', isLocalDevelopment);

  if (stripTrailingSlash(mcpResourceUrl) !== stripTrailingSlash(mcpAudienceUrl)) {
    throw new HttpError(500, 'invalid_config', 'MCP_RESOURCE and MCP_AUDIENCE must match');
  }

  const fetchImpl = (env.fetch ?? fetch).bind(globalThis);

  return {
    appEnv: parsed.data.APP_ENV,
    issuer: stripTrailingSlash(issuerUrl),
    issuerUrl,
    mcpResource: stripTrailingSlash(mcpResourceUrl),
    mcpResourceUrl,
    mcpAudience: stripTrailingSlash(mcpAudienceUrl),
    googleCallbackUrl: googleCallbackUrlObject.toString(),
    googleCallbackUrlObject,
    googleCalendarWriteScopeMode: parsed.data.GOOGLE_CALENDAR_WRITE_SCOPE_MODE,
    authStorageMode: parsed.data.AUTH_STORAGE_MODE,
    defaultTimeZone: parsed.data.DEFAULT_TIME_ZONE,
    accessTokenTtlSeconds: parsePositiveInteger('ACCESS_TOKEN_TTL_SECONDS', parsed.data.ACCESS_TOKEN_TTL_SECONDS),
    authCodeTtlSeconds: parsePositiveInteger('AUTH_CODE_TTL_SECONDS', parsed.data.AUTH_CODE_TTL_SECONDS),
    refreshTokenTtlSeconds: parsePositiveInteger('REFRESH_TOKEN_TTL_SECONDS', parsed.data.REFRESH_TOKEN_TTL_SECONDS),
    stateTtlSeconds: parsePositiveInteger('STATE_TTL_SECONDS', parsed.data.STATE_TTL_SECONDS),
    redirectUriAllowlist: parseUrlPatterns(parsed.data.REDIRECT_URI_ALLOWLIST, 'REDIRECT_URI_ALLOWLIST'),
    allowedOrigins: parseUrlPatterns(parsed.data.ALLOWED_ORIGINS, 'ALLOWED_ORIGINS'),
    jwtSigningKey: decodeKey('JWT_SIGNING_KEY_B64', parsed.data.JWT_SIGNING_KEY_B64, 32),
    tokenEncryptionKey: decodeKey('TOKEN_ENC_KEY_B64', parsed.data.TOKEN_ENC_KEY_B64, 16, [16, 24, 32]),
    csrfSigningKey: decodeKey('CSRF_SIGNING_KEY_B64', parsed.data.CSRF_SIGNING_KEY_B64, 32),
    googleClientId: parsed.data.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    fetchImpl,
    supportedScopes: SUPPORTED_MCP_SCOPES,
    isLocalDevelopment,
  };
}

export function matchesPattern(value: string, patterns: UrlPattern[]): boolean {
  return patterns.some((pattern) => pattern.regex.test(value));
}
