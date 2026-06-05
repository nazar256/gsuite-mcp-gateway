import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleGmailClient } from '../../google/gmail';
import { buildMimeMessage, encodeMimeMessage, extractEmailAddress } from '../../google/mime';
import { hasScope } from '../../oauth/scopes';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

const textDecoder = new TextDecoder();
const MAX_MESSAGE_BODY_BYTES = 5 * 1024 * 1024;

const gmailProfileOutput = z.object({
  emailAddress: z.string().optional(),
  messagesTotal: z.number().optional(),
  threadsTotal: z.number().optional(),
  historyId: z.string().optional(),
}).passthrough();
const gmailLabelOutput = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  messageListVisibility: z.string().optional(),
  labelListVisibility: z.string().optional(),
  type: z.string().optional(),
  messagesTotal: z.number().optional(),
  messagesUnread: z.number().optional(),
  threadsTotal: z.number().optional(),
  threadsUnread: z.number().optional(),
}).passthrough();
const gmailMessageSummaryOutput = z.object({
  id: z.string().optional(),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  date: z.string().optional(),
}).passthrough();
const gmailSearchOutput = z.object({
  resultSizeEstimate: z.number().optional(),
  messages: z.array(gmailMessageSummaryOutput),
});
const gmailHeaderOutput = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
}).passthrough();
const gmailMessagePartBodyOutput = z.object({
  attachmentId: z.string().optional(),
  size: z.number().optional(),
  data: z.string().optional(),
}).passthrough();
const gmailMessagePartOutput: z.ZodTypeAny = z.lazy(() => z.object({
  partId: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(gmailHeaderOutput).optional(),
  body: gmailMessagePartBodyOutput.optional(),
  parts: z.array(gmailMessagePartOutput).optional(),
}).passthrough());
const gmailMessageOutput = z.object({
  id: z.string().optional(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: gmailMessagePartOutput.optional(),
  sizeEstimate: z.number().optional(),
  raw: z.string().optional(),
  body: z.object({
    contentFormat: z.enum(['decoded', 'sanitized']),
    bytes: z.number(),
    truncated: z.boolean(),
    textPlain: z.string().optional(),
    textHtml: z.string().optional(),
    sanitizedText: z.string().optional(),
    links: z.array(z.object({
      url: z.string(),
      text: z.string().optional(),
    })).optional(),
    parts: z.array(z.object({
      partId: z.string().optional(),
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      bytes: z.number(),
    })).optional(),
  }).passthrough().optional(),
}).passthrough();
const gmailDraftOutput = z.object({
  id: z.string().optional(),
  message: gmailMessageOutput.optional(),
}).passthrough();

function okResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function errorResult(error: HttpError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error.message }],
    _meta: error.mcpWwwAuthenticate ? { 'mcp/www_authenticate': error.mcpWwwAuthenticate } : undefined,
  };
}

function getHeaderValue(payload: any, name: string): string | undefined {
  return payload?.headers?.find((header: any) => header.name?.toLowerCase() === name.toLowerCase())?.value;
}

function buildMetadataHeaderParams(format: 'metadata' | 'full' | 'minimal' | 'raw', metadataHeaders?: string[]): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = { format };
  if (metadataHeaders?.length) {
    params.metadataHeaders = metadataHeaders;
  }
  return params;
}

function summarizeMessage(message: any) {
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    labelIds: message.labelIds,
    internalDate: message.internalDate,
    subject: getHeaderValue(message.payload, 'Subject'),
    from: getHeaderValue(message.payload, 'From'),
    to: getHeaderValue(message.payload, 'To'),
    date: getHeaderValue(message.payload, 'Date'),
  };
}

function decodeBase64Url(value: string): Uint8Array {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'invalid_request', 'Gmail message body contains invalid base64url data');
  }
}

function collectTextParts(part: any, parts: Array<{ partId?: string; mimeType?: string; filename?: string; text: string; bytes: number }>): void {
  const mimeType = String(part?.mimeType ?? '').toLowerCase();
  const data = part?.body?.data;
  if ((mimeType === 'text/plain' || mimeType === 'text/html') && typeof data === 'string') {
    const bytes = decodeBase64Url(data);
    parts.push({
      partId: part.partId,
      mimeType,
      filename: part.filename,
      text: textDecoder.decode(bytes),
      bytes: bytes.byteLength,
    });
  }

  for (const child of part?.parts ?? []) {
    collectTextParts(child, parts);
  }
}

function limitTextByBytes(value: string, remainingBytes: number): { text: string; bytes: number; truncated: boolean } {
  if (remainingBytes <= 0) {
    return { text: '', bytes: 0, truncated: value.length > 0 };
  }

  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= remainingBytes) {
    return { text: value, bytes: bytes.byteLength, truncated: false };
  }

  return {
    text: textDecoder.decode(bytes.slice(0, remainingBytes)),
    bytes: remainingBytes,
    truncated: true,
  };
}

function decodeHtmlEntity(entity: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: '\'',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const codePoint = Number.parseInt(entity.slice(2), 16);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  if (entity.startsWith('#')) {
    const codePoint = Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : `&${entity};`;
  }
  return namedEntities[entity] ?? `&${entity};`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g, (_match, entity: string) => decodeHtmlEntity(entity));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSafeLink(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('mailto:');
}

function addUniqueLink(links: Array<{ url: string; text?: string }>, seen: Set<string>, url: string, text?: string): void {
  const decodedUrl = decodeHtmlEntities(url).trim();
  if (!decodedUrl || !isSafeLink(decodedUrl) || seen.has(decodedUrl)) {
    return;
  }
  seen.add(decodedUrl);
  const normalizedText = text ? normalizeWhitespace(decodeHtmlEntities(text.replace(/<[^>]*>/g, ' '))) : undefined;
  links.push({ url: decodedUrl, ...(normalizedText ? { text: normalizedText } : {}) });
}

function sanitizeHtml(html: string): { text: string; links: Array<{ url: string; text?: string }> } {
  const links: Array<{ url: string; text?: string }> = [];
  const seen = new Set<string>();
  const withoutUnsafeBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(script|style|noscript|template|svg|head)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*(script|style|noscript|template|svg|head)\b[\s\S]*$/gi, ' ');

  const withLinkText = withoutUnsafeBlocks.replace(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, (_match, _raw, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined, label: string) => {
    const url = doubleQuoted ?? singleQuoted ?? bare ?? '';
    addUniqueLink(links, seen, url, label);
    return `${label} (${url})`;
  });

  const text = normalizeWhitespace(decodeHtmlEntities(withLinkText
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')));

  for (const match of text.matchAll(/https?:\/\/[^\s<>()"']+/gi)) {
    addUniqueLink(links, seen, match[0].replace(/[.,;:!?]+$/, ''));
  }

  return { text, links };
}

function stripPayloadBodyData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPayloadBodyData);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'data') {
      continue;
    }
    result[key] = stripPayloadBodyData(entry);
  }
  return result;
}

function buildMessageBody(message: any, bodyFormat: 'decoded' | 'sanitized', maxBodyBytes: number) {
  const textParts: Array<{ partId?: string; mimeType?: string; filename?: string; text: string; bytes: number }> = [];
  collectTextParts(message.payload, textParts);

  const textPlain = textParts.filter((part) => part.mimeType === 'text/plain').map((part) => part.text).join('\n\n');
  const textHtml = textParts.filter((part) => part.mimeType === 'text/html').map((part) => part.text).join('\n\n');

  let remainingBytes = maxBodyBytes;
  let truncated = false;
  const output: Record<string, unknown> = {
    contentFormat: bodyFormat,
    bytes: textParts.reduce((total, part) => total + part.bytes, 0),
    truncated: false,
    parts: textParts.map(({ partId, mimeType, filename, bytes }) => ({ partId, mimeType, filename, bytes })),
  };

  if (bodyFormat === 'decoded') {
    if (textPlain) {
      const limited = limitTextByBytes(textPlain, remainingBytes);
      output.textPlain = limited.text;
      remainingBytes -= limited.bytes;
      truncated ||= limited.truncated;
    }
    if (textHtml && remainingBytes > 0) {
      const limited = limitTextByBytes(textHtml, remainingBytes);
      output.textHtml = limited.text;
      remainingBytes -= limited.bytes;
      truncated ||= limited.truncated;
    } else if (textHtml) {
      truncated = true;
    }
  } else {
    const source = sanitizeHtml(textHtml || textPlain);
    const limited = limitTextByBytes(source.text, remainingBytes);
    output.sanitizedText = limited.text;
    output.links = source.links;
    truncated ||= limited.truncated;
  }

  output.truncated = truncated;
  return output;
}

export function registerGmailTools(
  server: McpServer,
  config: AppConfig,
  client: GoogleGmailClient,
  grantedScope: string,
): void {
  const register = <T extends z.ZodRawShape>(
    name: string,
    scope: 'gmail.read' | 'gmail.send' | 'gmail.modify' | 'gmail.drafts',
    description: string,
    inputSchema: T,
    outputSchema: z.ZodTypeAny,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnlyHint: boolean,
    destructiveHint = false,
    idempotentHint = readOnlyHint,
    advertisedScopes: Array<'gmail.read' | 'gmail.send' | 'gmail.modify' | 'gmail.drafts'> = [scope],
  ) => {
    if (!hasScope(grantedScope, scope)) {
      return;
    }

    (server.registerTool as any)(name, {
      title: name,
      description,
      inputSchema,
      outputSchema,
        annotations: {
          title: name,
          readOnlyHint,
          destructiveHint,
          idempotentHint,
          openWorldHint: false,
        },
        _meta: {
          securitySchemes: [{ type: 'oauth2', scopes: advertisedScopes }],
        },
    }, async (args: z.infer<z.ZodObject<T>>) => {
      try {
        ensureRequiredScope(config, grantedScope, scope);
        const parsed = z.object(inputSchema).parse(args);
        return okResult(await handler(parsed));
      } catch (error) {
        const httpError = error instanceof HttpError
          ? error
          : error instanceof z.ZodError
            ? new HttpError(400, 'invalid_request', error.issues[0]?.message ?? 'Invalid input')
            : new HttpError(500, 'internal_error', 'Internal server error');
        return errorResult(httpError);
      }
    });
  };

  register('gmail_get_profile', 'gmail.read', 'Get the Gmail profile for the authenticated account.', {}, gmailProfileOutput, async () => {
    return client.getProfile();
  }, true);

  register('gmail_list_labels', 'gmail.read', 'List Gmail labels.', {}, z.object({ labels: z.array(gmailLabelOutput) }), async () => {
    return client.listLabels();
  }, true);

  register('gmail_search_messages', 'gmail.read', 'Search Gmail messages using Gmail query syntax.', {
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).default(10).optional(),
    includeSpamTrash: z.boolean().default(false).optional(),
  }, gmailSearchOutput, async ({ query, maxResults = 10, includeSpamTrash = false }) => {
    const list = await client.listMessages({
      q: query,
      maxResults: String(maxResults),
      includeSpamTrash: String(includeSpamTrash),
    }) as any;

    const messages = await Promise.all((list.messages ?? []).map(async (message: any) => {
      const full = await client.getMessage(message.id, buildMetadataHeaderParams('metadata', ['Subject', 'From', 'To', 'Date'])) as any;
      return summarizeMessage(full);
    }));
    return { resultSizeEstimate: list.resultSizeEstimate, messages };
  }, true);

  register('gmail_get_message', 'gmail.read', 'Get one Gmail message by id. Use bodyFormat="sanitized" to return readable body text plus extracted links without Gmail base64 MIME blobs.', {
    id: z.string().min(1),
    format: z.enum(['metadata', 'full', 'minimal', 'raw']).default('metadata').optional(),
    metadataHeaders: z.array(z.string().min(1).max(100)).max(25).optional(),
    bodyFormat: z.enum(['none', 'decoded', 'sanitized']).default('none').optional(),
    includePayloadData: z.boolean().optional(),
    maxBodyBytes: z.number().int().min(1).max(MAX_MESSAGE_BODY_BYTES).default(1024 * 1024).optional(),
  }, gmailMessageOutput, async ({ id, format = 'metadata', metadataHeaders, bodyFormat = 'none', includePayloadData, maxBodyBytes = 1024 * 1024 }) => {
    const effectiveFormat = bodyFormat === 'none' ? format : 'full';
    const params = buildMetadataHeaderParams(effectiveFormat, metadataHeaders);
    const message = await client.getMessage(id, params) as any;

    if (bodyFormat === 'none') {
      return message;
    }

    const shouldIncludePayloadData = includePayloadData ?? false;
    return {
      ...message,
      ...(shouldIncludePayloadData ? {} : { payload: stripPayloadBodyData(message.payload) }),
      body: buildMessageBody(message, bodyFormat, maxBodyBytes),
    };
  }, true);

  register('gmail_create_draft', 'gmail.drafts', 'Create a Gmail draft.', {
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(998),
    textBody: z.string().max(20000).optional(),
    htmlBody: z.string().max(50000).optional(),
    threadId: z.string().optional(),
  }, gmailDraftOutput, async ({ to, cc, bcc, subject, textBody, htmlBody, threadId }) => {
    const raw = encodeMimeMessage(buildMimeMessage({
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject,
      ...(textBody !== undefined ? { textBody } : {}),
      ...(htmlBody !== undefined ? { htmlBody } : {}),
    }));
    return client.createDraft(raw, threadId);
  }, false);

  register('gmail_send_email', 'gmail.send', 'Send an email with Gmail.', {
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(998),
    textBody: z.string().max(20000).optional(),
    htmlBody: z.string().max(50000).optional(),
    replyToMessageId: z.string().optional(),
    threadId: z.string().optional(),
  }, gmailMessageOutput, async ({ to, cc, bcc, subject, textBody, htmlBody, replyToMessageId, threadId }) => {
    const raw = encodeMimeMessage(buildMimeMessage({
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject,
      ...(textBody !== undefined ? { textBody } : {}),
      ...(htmlBody !== undefined ? { htmlBody } : {}),
      ...(replyToMessageId ? { inReplyTo: replyToMessageId, references: [replyToMessageId] } : {}),
    }));
    return client.sendMessage(raw, threadId);
  }, false);

  if (hasScope(grantedScope, 'gmail.read') && hasScope(grantedScope, 'gmail.send')) {
    register('gmail_reply_to_message', 'gmail.send', 'Reply to an existing Gmail message.', {
      id: z.string().min(1),
      textBody: z.string().max(20000).optional(),
      htmlBody: z.string().max(50000).optional(),
    }, gmailMessageOutput, async ({ id, textBody, htmlBody }) => {
      const original = await client.getMessage(id, buildMetadataHeaderParams('metadata', ['Subject', 'From', 'Message-ID', 'References', 'Reply-To'])) as any;
      const to = [getHeaderValue(original.payload, 'Reply-To') ?? getHeaderValue(original.payload, 'From')]
        .filter(Boolean)
        .map((value) => extractEmailAddress(String(value)));
      const originalSubject = getHeaderValue(original.payload, 'Subject') ?? '';
      const subject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
      const messageId = getHeaderValue(original.payload, 'Message-ID');
      const references = [getHeaderValue(original.payload, 'References'), messageId].filter(Boolean).flatMap((value) => String(value).split(/\s+/));
      const raw = encodeMimeMessage(buildMimeMessage({
        to,
        subject,
        ...(textBody !== undefined ? { textBody } : {}),
        ...(htmlBody !== undefined ? { htmlBody } : {}),
        ...(messageId ? { inReplyTo: messageId } : {}),
        references,
      }));
      return client.sendMessage(raw, original.threadId);
    }, false, false, false, ['gmail.read', 'gmail.send']);
  }

  register('gmail_modify_message_labels', 'gmail.modify', 'Add or remove Gmail labels from a message.', {
    id: z.string().min(1),
    addLabelIds: z.array(z.string()).max(50).optional(),
    removeLabelIds: z.array(z.string()).max(50).optional(),
  }, gmailMessageOutput, async ({ id, addLabelIds, removeLabelIds }) => {
    if ((!addLabelIds || addLabelIds.length === 0) && (!removeLabelIds || removeLabelIds.length === 0)) {
      throw new HttpError(400, 'invalid_request', 'At least one label change is required');
    }
    return client.modifyMessageLabels(id, { addLabelIds, removeLabelIds });
  }, false);

  register('gmail_archive_message', 'gmail.modify', 'Archive a Gmail message by removing INBOX.', {
    id: z.string().min(1),
  }, gmailMessageOutput, async ({ id }) => client.modifyMessageLabels(id, { removeLabelIds: ['INBOX'] }), false);

  register('gmail_trash_message', 'gmail.modify', 'Move a Gmail message to trash.', {
    id: z.string().min(1),
  }, gmailMessageOutput, async ({ id }) => client.trashMessage(id), false, true);

  register('gmail_mark_read_unread', 'gmail.modify', 'Mark a Gmail message as read or unread.', {
    id: z.string().min(1),
    read: z.boolean(),
  }, gmailMessageOutput, async ({ id, read }) => client.modifyMessageLabels(id, {
    addLabelIds: read ? [] : ['UNREAD'],
    removeLabelIds: read ? ['UNREAD'] : [],
  }), false);
}
