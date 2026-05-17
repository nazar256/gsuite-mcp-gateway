import type { AppConfig, SupportedMcpScope } from '../config';
import { HttpError } from '../security/errors';

export const GOOGLE_SCOPE_BY_MCP_SCOPE: Record<Exclude<SupportedMcpScope, 'offline_access' | 'calendar.write'> | 'calendar.write.owned' | 'calendar.write.all', string[]> = {
  'calendar.read': [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.events.freebusy',
  ],
  'calendar.write.owned': [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned',
  ],
  'calendar.write.all': [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
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
  'calendar.write': ['calendar.read'],
  'drive.write': ['drive.read'],
  'gmail.modify': ['gmail.read'],
};
const GOOGLE_SCOPE_SUPERSETS: Record<string, string[]> = {
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.events.owned',
  ],
  'https://www.googleapis.com/auth/calendar.events.readonly': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.events.owned',
  ],
  'https://www.googleapis.com/auth/calendar.events.freebusy': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.events.owned',
  ],
  'https://www.googleapis.com/auth/drive.readonly': [
    'https://www.googleapis.com/auth/drive',
  ],
  'https://www.googleapis.com/auth/gmail.readonly': [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
};

function hasGrantedGoogleScope(granted: Set<string>, requiredScope: string): boolean {
  if (granted.has(requiredScope)) {
    return true;
  }

  return (GOOGLE_SCOPE_SUPERSETS[requiredScope] ?? []).some((candidate) => granted.has(candidate));
}

export function normalizeMcpScope(scope?: string | null): string {
  if (!scope || !scope.trim()) {
    return 'calendar.read';
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

export function hasScope(scope: string | undefined, requiredScope: string): boolean {
  if (!scope) return false;
  return normalizeMcpScope(scope).split(' ').includes(requiredScope);
}

export function getRequiredGoogleScopes(config: AppConfig, mcpScope: string): string[] {
  const normalized = normalizeMcpScope(mcpScope).split(' ') as SupportedMcpScope[];
  const result = new Set<string>(BASE_GOOGLE_IDENTITY_SCOPES);

  for (const scope of normalized) {
    if (scope === 'offline_access') {
      continue;
    }

    const mappingKey = scope === 'calendar.write'
      ? `calendar.write.${config.googleCalendarWriteScopeMode}` as const
      : scope;

    for (const googleScope of GOOGLE_SCOPE_BY_MCP_SCOPE[mappingKey]) {
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

    const required = getRequiredGoogleScopes(config, candidate).filter((scope) => !BASE_GOOGLE_IDENTITY_SCOPES.includes(scope as typeof BASE_GOOGLE_IDENTITY_SCOPES[number]));
    if (required.every((scope) => hasGrantedGoogleScope(granted, scope))) {
      result.push(candidate);
    }
  }

  return result;
}
