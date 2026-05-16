import { HttpError } from '../security/errors';
import { base64UrlEncode } from '../security/crypto';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rejectHeaderInjection(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new HttpError(400, 'invalid_request', `${name} must not contain CR or LF characters`);
  }
  return value;
}

export function validateEmailAddress(value: string): string {
  const normalized = value.trim();
  rejectHeaderInjection('email address', normalized);
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new HttpError(400, 'invalid_request', 'Invalid email address');
  }
  return normalized;
}

export function extractEmailAddress(value: string): string {
  const normalized = value.trim();
  const angleMatch = normalized.match(/<([^<>\s@]+@[^<>\s@]+)>/);
  if (angleMatch?.[1]) {
    return validateEmailAddress(angleMatch[1]);
  }
  return validateEmailAddress(normalized);
}

export function validateEmailAddresses(values: string[], fieldName: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new HttpError(400, 'invalid_request', `${fieldName} must contain at least one email address`);
  }
  return values.map(validateEmailAddress);
}

function normalizeLines(value: string): string {
  return value.replace(/\r?\n/g, '\r\n');
}

function buildHeaders(headers: Array<[string, string | undefined]>): string {
  return headers
    .filter(([, value]) => value && value.length > 0)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
}

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string[];
}

export function buildMimeMessage(input: MimeMessageInput): string {
  const to = validateEmailAddresses(input.to, 'to');
  const cc = input.cc?.length ? input.cc.map(validateEmailAddress) : undefined;
  const bcc = input.bcc?.length ? input.bcc.map(validateEmailAddress) : undefined;
  const subject = rejectHeaderInjection('subject', input.subject);
  if (!input.textBody && !input.htmlBody) {
    throw new HttpError(400, 'invalid_request', 'At least one of textBody or htmlBody is required');
  }

  if (subject.length > 998) {
    throw new HttpError(400, 'invalid_request', 'subject is too long');
  }

  const headers: Array<[string, string | undefined]> = [
    ['To', to.join(', ')],
    ['Cc', cc?.join(', ')],
    ['Bcc', bcc?.join(', ')],
    ['Subject', subject],
    ['MIME-Version', '1.0'],
    ['In-Reply-To', input.inReplyTo ? rejectHeaderInjection('inReplyTo', input.inReplyTo) : undefined],
    ['References', input.references?.length ? rejectHeaderInjection('references', input.references.join(' ')) : undefined],
  ];

  if (input.textBody && input.htmlBody) {
    const boundary = `gsuite_mcp_${crypto.randomUUID()}`;
    return `${buildHeaders([...headers, ['Content-Type', `multipart/alternative; boundary="${boundary}"`]])}\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${normalizeLines(input.textBody)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${normalizeLines(input.htmlBody)}\r\n` +
      `--${boundary}--\r\n`;
  }

  const isHtml = Boolean(input.htmlBody);
  const body = normalizeLines(input.htmlBody ?? input.textBody ?? '');
  return `${buildHeaders([...headers, ['Content-Type', `${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`], ['Content-Transfer-Encoding', '8bit']])}\r\n\r\n${body}`;
}

export function encodeMimeMessage(message: string): string {
  return base64UrlEncode(new TextEncoder().encode(message));
}
