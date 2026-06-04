import type { AppConfig, SupportedMcpScope } from '../config';
import { HttpError } from '../security/errors';

export const GOOGLE_SCOPE_BY_MCP_SCOPE: Record<Exclude<SupportedMcpScope, 'offline_access' | 'calendar.write'> | 'calendar.write.owned' | 'calendar.write.all', string[]> = {
  'calendar.read': [
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  'calendar.write.owned': [
    'https://www.googleapis.com/auth/calendar.events.owned',
  ],
  'calendar.write.all': [
    'https://www.googleapis.com/auth/calendar.events',
  ],
  'drive.read': [
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  'drive.write': [
    'https://www.googleapis.com/auth/drive',
  ],
  'gmail.read': [
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
  'gmail.send': [
    'https://www.googleapis.com/auth/gmail.send',
  ],
  'gmail.modify': [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  'gmail.drafts': [
    'https://www.googleapis.com/auth/gmail.compose',
  ],
};

const canonicalScopeOrder: SupportedMcpScope[] = [
  'calendar.read',
  'calendar.write',
  'drive.read',
  'drive.write',
  'gmail.read',
  'gmail.send',
  'gmail.modify',
  'gmail.drafts',
  'offline_access',
];

const BASE_GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;
const IMPLIED_MCP_SCOPES: Partial<Record<SupportedMcpScope, SupportedMcpScope[]>> = {
  'drive.write': ['drive.read'],
  'gmail.modify': ['gmail.read'],
};
const DEFAULT_MCP_SCOPE = canonicalScopeOrder.join(' ');
const GOOGLE_SCOPE_SUPERSETS: Record<string, string[]> = {
  'https://www.googleapis.com/auth/calendar.readonly': [
    'https://www.googleapis.com/auth/calendar',
  ],
  'https://www.googleapis.com/auth/calendar.events': [
    'https://www.googleapis.com/auth/calendar',
  ],
  'https://www.googleapis.com/auth/calendar.events.owned': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar',
  ],
  'https://www.googleapis.com/auth/drive.readonly': [
    'https://www.googleapis.com/auth/drive',
  ],
  'https://www.googleapis.com/auth/gmail.readonly': [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  'https://www.googleapis.com/auth/gmail.send': [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  'https://www.googleapis.com/auth/gmail.compose': [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
};

function getDirectGoogleScopesForMcpScope(config: AppConfig, scope: SupportedMcpScope): string[] {
  if (scope === 'offline_access') {
    return [];
  }

  const mappingKey = scope === 'calendar.write'
    ? `calendar.write.${config.googleCalendarWriteScopeMode}` as const
    : scope;

  return GOOGLE_SCOPE_BY_MCP_SCOPE[mappingKey];
}

function isMcpScopeRedundant(scope: SupportedMcpScope, requested: Set<SupportedMcpScope>): boolean {
  for (const [candidate, impliedScopes] of Object.entries(IMPLIED_MCP_SCOPES) as Array<[SupportedMcpScope, SupportedMcpScope[]]>) {
    if (candidate !== scope && requested.has(candidate) && impliedScopes.includes(scope)) {
      return true;
    }
  }

  return false;
}

function hasGrantedGoogleScope(granted: Set<string>, requiredScope: string): boolean {
  if (granted.has(requiredScope)) {
    return true;
  }

  return (GOOGLE_SCOPE_SUPERSETS[requiredScope] ?? []).some((candidate) => granted.has(candidate));
}

export function normalizeMcpScope(scope?: string | null): string {
  if (!scope || !scope.trim()) {
    return DEFAULT_MCP_SCOPE;
  }

  const requested = new Set(scope.split(/\s+/).filter(Boolean));
  for (const entry of requested) {
    if (!canonicalScopeOrder.includes(entry as SupportedMcpScope)) {
      throw new HttpError(400, 'invalid_scope', `Unsupported scope: ${entry}`);
    }
  }

  for (const entry of [...requested]) {
    const implied = IMPLIED_MCP_SCOPES[entry as SupportedMcpScope] ?? [];
    for (const inherited of implied) {
      requested.add(inherited);
    }
  }

  const ordered = canonicalScopeOrder.filter((entry) => requested.has(entry));
  if (ordered.length === 0) {
    throw new HttpError(400, 'invalid_scope', 'At least one supported scope is required');
  }

  return ordered.join(' ');
}

export function validateRequestedMcpScope(scope?: string | null): string {
  if (!scope || !scope.trim()) {
    throw new HttpError(400, 'invalid_scope', 'scope is required');
  }

  return normalizeMcpScope(scope);
}

export function hasScope(scope: string | undefined, requiredScope: string): boolean {
  if (!scope) return false;
  return normalizeMcpScope(scope).split(' ').includes(requiredScope);
}

export function normalizeGrantedMcpScope(scope?: string | null): string {
  if (!scope || !scope.trim()) {
    return '';
  }

  return normalizeMcpScope(scope);
}

export function intersectMcpScopes(...scopes: Array<string | null | undefined>): string {
  const provided = scopes.filter((scope): scope is string => scope !== null && scope !== undefined);
  if (provided.length === 0) {
    return '';
  }

  const normalized = provided.map((scope) => normalizeGrantedMcpScope(scope));
  if (normalized.some((scope) => scope.length === 0)) {
    return '';
  }

  const sets = normalized.map((scope) => new Set(scope.split(' ').filter(Boolean)));
  return canonicalScopeOrder.filter((scope) => sets.every((set) => set.has(scope))).join(' ');
}

export function getRequiredGoogleScopes(config: AppConfig, mcpScope: string): string[] {
  const normalized = normalizeMcpScope(mcpScope).split(' ') as SupportedMcpScope[];
  const requestedSet = new Set(normalized);
  const result = new Set<string>(BASE_GOOGLE_IDENTITY_SCOPES);

  for (const scope of normalized) {
    if (isMcpScopeRedundant(scope, requestedSet)) {
      continue;
    }

    for (const googleScope of getDirectGoogleScopesForMcpScope(config, scope)) {
      result.add(googleScope);
    }
  }

  return [...result].sort();
}

export function inferGrantedMcpScopes(config: AppConfig, googleScopes: string[]): string[] {
  const granted = new Set(googleScopes);
  const result: SupportedMcpScope[] = [];

  for (const candidate of canonicalScopeOrder) {
    if (candidate === 'offline_access') {
      continue;
    }

    const required = getDirectGoogleScopesForMcpScope(config, candidate);
    if (required.every((scope) => hasGrantedGoogleScope(granted, scope))) {
      result.push(candidate);
    }
  }

  if (result.length === 0) {
    return result;
  }

  return normalizeMcpScope(result.join(' ')).split(' ');
}
