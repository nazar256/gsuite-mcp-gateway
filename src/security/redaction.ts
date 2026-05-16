const SENSITIVE_FIELD_PATTERN = /(authorization|token|secret|password|cookie|set-cookie|refresh|access)/i;

export function redactValue(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return '[REDACTED]';
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (value && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

export function redactObject<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : redactUnknown(value),
    ]),
  );
}

export function redactUrl(input: string): string {
  const url = new URL(input);
  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_FIELD_PATTERN.test(key) || key === 'code' || key === 'state') {
      url.searchParams.set(key, '[REDACTED]');
    }
  }
  return url.toString();
}
