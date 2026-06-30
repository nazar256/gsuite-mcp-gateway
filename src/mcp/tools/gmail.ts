import { z } from 'zod';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleGmailClient } from '../../google/gmail';
import { buildMimeMessage, encodeMimeMessage, extractEmailAddress } from '../../google/mime';
import { hasScope } from '../../oauth/scopes';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

const textDecoder = new TextDecoder();
const MAX_MESSAGE_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_ATTACHMENT_BYTES = 1024 * 1024;

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
const gmailAttachmentMetadataOutput = z.object({
  partId: z.string().optional(),
  attachmentId: z.string(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  disposition: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentId: z.string().optional(),
}).passthrough();
const gmailMessageOutput = z.object({
  id: z.string().optional(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  date: z.string().optional(),
  payload: gmailMessagePartOutput.optional(),
  attachments: z.array(gmailAttachmentMetadataOutput).optional(),
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
const gmailAttachmentOutput = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
  partId: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  disposition: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentId: z.string().optional(),
  encoding: z.enum(['base64', 'text']),
  outputMode: z.enum(['base64', 'text']),
  bytes: z.number(),
  truncated: z.boolean(),
  sha256: z.string().optional(),
  sha256Full: z.string().optional(),
  sha256Returned: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  data: z.string(),
}).passthrough();
const gmailReadAttachmentOutput = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
  partId: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  disposition: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentId: z.string().optional(),
  mode: z.enum(['auto', 'metadata', 'text', 'native', 'raw']),
  representation: z.enum(['metadata', 'text', 'image', 'audio', 'resource_link', 'raw']),
  resourceUri: z.string(),
  bytes: z.number(),
  bytesReturned: z.number().optional(),
  bytesTotal: z.number().optional(),
  truncated: z.boolean(),
  sha256: z.string().optional(),
  sha256Full: z.string().optional(),
  sha256Returned: z.string().optional(),
  text: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  textExtracted: z.boolean().optional(),
  renderedPages: z.array(z.number()).optional(),
  limitations: z.array(z.string()).optional(),
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

function compactMessage(message: any) {
  const attachments = collectAttachmentParts(message.payload);
  return {
    ...summarizeMessage(message),
    historyId: message.historyId,
    ...(attachments.length ? { attachments } : {}),
    sizeEstimate: message.sizeEstimate,
  };
}

function decodeBase64Url(value: string, context = 'Gmail message body'): Uint8Array {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'invalid_request', `${context} contains invalid base64url data`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.slice(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64(value: string, context = 'Attachment data'): Uint8Array {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'invalid_request', `${context} contains invalid base64 data`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseHeaderSize(value: string | undefined): number | undefined {
  const match = value?.match(/(?:^|;\s*)size=(\d+)(?:;|$)/i);
  if (!match) {
    return undefined;
  }
  const size = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(size) ? size : undefined;
}

function parseContentDisposition(value: string | undefined): string | undefined {
  const disposition = value?.split(';', 1)[0]?.trim().toLowerCase();
  return disposition || undefined;
}

function findAttachmentPart(part: any, attachmentId: string): any | undefined {
  if (part?.body?.attachmentId === attachmentId) {
    return part;
  }
  for (const child of part?.parts ?? []) {
    const found = findAttachmentPart(child, attachmentId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

type GmailAttachmentMetadata = {
  partId?: string;
  attachmentId: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  disposition?: string;
  contentDisposition?: string;
  contentId?: string;
};

function attachmentMetadataFromPart(part: any): GmailAttachmentMetadata | undefined {
  const attachmentId = part?.body?.attachmentId;
  if (typeof attachmentId !== 'string' || !attachmentId) {
    return undefined;
  }

  const contentDisposition = getHeaderValue(part, 'Content-Disposition');
  const contentId = getHeaderValue(part, 'Content-ID');
  const bodySize = typeof part.body?.size === 'number' ? part.body.size : undefined;
  const headerSize = parseHeaderSize(contentDisposition);
  const disposition = parseContentDisposition(contentDisposition);

  return {
    attachmentId,
    ...(part.partId ? { partId: part.partId } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
    ...(part.mimeType ? { mimeType: part.mimeType } : {}),
    ...(bodySize !== undefined ? { size: bodySize } : {}),
    ...(bodySize === undefined && headerSize !== undefined ? { size: headerSize } : {}),
    ...(contentDisposition ? { contentDisposition } : {}),
    ...(disposition ? { disposition } : {}),
    ...(contentId ? { contentId } : {}),
  };
}

function collectAttachmentParts(part: any, attachments: GmailAttachmentMetadata[] = []): GmailAttachmentMetadata[] {
  const metadata = attachmentMetadataFromPart(part);
  if (metadata) {
    attachments.push(metadata);
  }
  for (const child of part?.parts ?? []) {
    collectAttachmentParts(child, attachments);
  }
  return attachments;
}

function attachmentMetadataFromMessage(message: any, attachmentId: string): Partial<GmailAttachmentMetadata> {
  const part = findAttachmentPart(message?.payload, attachmentId);
  if (!part) {
    return {};
  }
  return attachmentMetadataFromPart(part) ?? {};
}

function isTextLikeMimeType(mimeType: string | undefined): boolean {
  const normalized = mimeType?.toLowerCase();
  return Boolean(normalized && (
    normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized === 'application/xhtml+xml'
    || normalized === 'application/javascript'
    || normalized === 'application/x-javascript'
    || normalized === 'image/svg+xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
  ));
}

function isImageMimeType(mimeType: string | undefined): boolean {
  const normalized = mimeType?.toLowerCase();
  return normalized === 'image/png'
    || normalized === 'image/jpeg'
    || normalized === 'image/jpg'
    || normalized === 'image/webp'
    || normalized === 'image/gif';
}

function isAudioMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('audio/'));
}

function isPdfMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase() === 'application/pdf';
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0)
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!;
}

function imageDimensions(bytes: Uint8Array, mimeType: string | undefined): { width: number; height: number } | undefined {
  const normalized = mimeType?.toLowerCase();
  if (normalized === 'image/png' && bytes.byteLength >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    return {
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20),
    };
  }

  if ((normalized === 'image/jpeg' || normalized === 'image/jpg') && bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const segmentLength = (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
      if (segmentLength < 2) {
        return undefined;
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return {
          height: (bytes[offset + 5]! << 8) + bytes[offset + 6]!,
          width: (bytes[offset + 7]! << 8) + bytes[offset + 8]!,
        };
      }
      offset += 2 + segmentLength;
    }
  }

  return undefined;
}

async function buildAttachmentResponse(input: {
  messageId: string;
  attachmentId: string;
  partId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  contentDisposition?: string;
  contentId?: string;
  disposition?: string;
  outputMode: 'base64' | 'text';
  maxBytes: number;
}, attachment: any) {
  if (typeof attachment?.data !== 'string') {
    throw new HttpError(400, 'invalid_request', 'Gmail attachment response is missing base64url data');
  }

  const decoded = decodeBase64Url(attachment.data, 'Gmail attachment');
  if (input.outputMode === 'text' && !isTextLikeMimeType(input.mimeType)) {
    throw new HttpError(400, 'invalid_request', `outputMode="text" decodes raw bytes and is only supported for text-like attachments; use outputMode="base64" for ${input.mimeType ?? 'binary attachments'}`);
  }

  const truncated = decoded.byteLength > input.maxBytes;
  const bytes = truncated ? decoded.slice(0, input.maxBytes) : decoded;
  const size = input.size ?? (typeof attachment.size === 'number' ? attachment.size : undefined);
  const sha256Full = await sha256Hex(decoded);
  const sha256Returned = truncated ? await sha256Hex(bytes) : sha256Full;
  const dimensions = imageDimensions(bytes, input.mimeType);

  return {
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    ...(input.partId ? { partId: input.partId } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(input.contentDisposition ? { contentDisposition: input.contentDisposition } : {}),
    ...(input.contentId ? { contentId: input.contentId } : {}),
    encoding: input.outputMode,
    outputMode: input.outputMode,
    bytes: bytes.byteLength,
    truncated,
    sha256: sha256Returned,
    sha256Full,
    sha256Returned,
    ...(dimensions ? dimensions : {}),
    data: input.outputMode === 'text' ? textDecoder.decode(bytes) : encodeBase64(bytes),
  };
}

async function downloadAttachment(input: {
  messageId: string;
  attachmentId: string;
  filename?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  contentDisposition?: string | undefined;
  contentId?: string | undefined;
  disposition?: string | undefined;
  outputMode?: 'base64' | 'text' | undefined;
  encoding?: 'base64' | 'text' | undefined;
  maxBytes?: number | undefined;
}, client: GoogleGmailClient) {
  const attachment = await client.getAttachment(input.messageId, input.attachmentId);
  const needsMessageMetadata = !input.filename || !input.mimeType || input.size === undefined || !input.contentDisposition || !input.contentId || !input.disposition;
  let messageMetadata: Partial<GmailAttachmentMetadata> = {};
  if (needsMessageMetadata) {
    try {
      messageMetadata = attachmentMetadataFromMessage(
        await client.getMessage(input.messageId, buildMetadataHeaderParams('full')) as any,
        input.attachmentId,
      );
    } catch {
      messageMetadata = {};
    }
  }
  const filename = input.filename ?? messageMetadata.filename;
  const mimeType = input.mimeType ?? messageMetadata.mimeType;
  const size = input.size ?? messageMetadata.size;
  const outputMode = input.outputMode ?? input.encoding ?? 'base64';

  return buildAttachmentResponse({
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    ...(messageMetadata.partId ? { partId: messageMetadata.partId } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(input.disposition ?? messageMetadata.disposition ? { disposition: input.disposition ?? messageMetadata.disposition } : {}),
    ...(input.contentDisposition ?? messageMetadata.contentDisposition ? { contentDisposition: input.contentDisposition ?? messageMetadata.contentDisposition } : {}),
    ...(input.contentId ?? messageMetadata.contentId ? { contentId: input.contentId ?? messageMetadata.contentId } : {}),
    outputMode,
    maxBytes: input.maxBytes ?? 1024 * 1024,
  }, attachment);
}

function gmailAttachmentResourceUri(messageId: string, attachmentId: string): string {
  return `gmail://messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function metadataFromDownloadedAttachment(downloaded: Record<string, unknown>, mode: 'auto' | 'metadata' | 'text' | 'native' | 'raw', representation: 'metadata' | 'text' | 'image' | 'audio' | 'resource_link' | 'raw', resourceUri: string, extra: Record<string, unknown> = {}) {
  const { data: _data, encoding: _encoding, outputMode: _outputMode, ...metadata } = downloaded;
  const bytesReturned = typeof metadata.bytes === 'number' ? metadata.bytes : undefined;
  const bytesTotal = typeof metadata.size === 'number' ? metadata.size : bytesReturned;
  return {
    ...metadata,
    ...(bytesReturned !== undefined ? { bytesReturned } : {}),
    ...(bytesTotal !== undefined ? { bytesTotal } : {}),
    mode,
    representation,
    resourceUri,
    ...extra,
  };
}

function attachmentDisplayName(downloaded: Record<string, unknown>): string {
  return typeof downloaded.filename === 'string' && downloaded.filename
    ? downloaded.filename
    : typeof downloaded.attachmentId === 'string'
      ? downloaded.attachmentId
      : 'Gmail attachment';
}

function resourceLink(downloaded: Record<string, unknown>, resourceUri: string, description: string): ContentBlock {
  return {
    type: 'resource_link',
    uri: resourceUri,
    name: attachmentDisplayName(downloaded),
    ...(typeof downloaded.mimeType === 'string' ? { mimeType: downloaded.mimeType } : {}),
    ...(typeof downloaded.size === 'number' ? { size: downloaded.size } : {}),
    description,
  };
}

async function readAttachment(input: {
  messageId: string;
  attachmentId: string;
  filename?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  contentDisposition?: string | undefined;
  contentId?: string | undefined;
  disposition?: string | undefined;
  mode?: 'auto' | 'metadata' | 'text' | 'native' | 'raw' | undefined;
  maxBytes?: number | undefined;
}, client: GoogleGmailClient): Promise<CallToolResult> {
  const mode = input.mode ?? 'auto';
  const resourceUri = gmailAttachmentResourceUri(input.messageId, input.attachmentId);

  if (mode === 'metadata') {
    const downloaded = await downloadAttachment({ ...input, outputMode: 'base64', maxBytes: 1 }, client) as Record<string, unknown>;
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'metadata', resourceUri);
    return {
      content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
      structuredContent: metadata,
    };
  }

  if (mode === 'raw') {
    const downloaded = await downloadAttachment({ ...input, outputMode: 'base64', maxBytes: input.maxBytes ?? DEFAULT_ATTACHMENT_BYTES }, client) as Record<string, unknown>;
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'raw', resourceUri);
    return {
      content: [{ type: 'text', text: JSON.stringify(downloaded, null, 2) }],
      structuredContent: metadata,
    };
  }

  if (mode === 'text') {
    const downloaded = await downloadAttachment({ ...input, outputMode: 'text', maxBytes: input.maxBytes ?? DEFAULT_ATTACHMENT_BYTES }, client) as Record<string, unknown>;
    const text = String(downloaded.data ?? '');
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'text', resourceUri, { text });
    return {
      content: [{ type: 'text', text }],
      structuredContent: metadata,
    };
  }

  const downloaded = await downloadAttachment({ ...input, outputMode: 'base64', maxBytes: input.maxBytes ?? DEFAULT_ATTACHMENT_BYTES }, client) as Record<string, unknown>;
  const mimeType = typeof downloaded.mimeType === 'string' ? downloaded.mimeType : undefined;
  const data = String(downloaded.data ?? '');

  if (isTextLikeMimeType(mimeType)) {
    const bytes = decodeBase64(data);
    const text = textDecoder.decode(bytes);
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'text', resourceUri, { text });
    return {
      content: [{ type: 'text', text }],
      structuredContent: metadata,
    };
  }

  if (isImageMimeType(mimeType)) {
    const imageMimeType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType ?? 'image/png';
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'image', resourceUri);
    return {
      content: [{
        type: 'image',
        data,
        mimeType: imageMimeType,
        annotations: { audience: ['assistant'], priority: 1 },
      }],
      structuredContent: metadata,
    };
  }

  if (isAudioMimeType(mimeType)) {
    const audioMimeType = mimeType ?? 'audio/mpeg';
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'audio', resourceUri);
    return {
      content: [{
        type: 'audio',
        data,
        mimeType: audioMimeType,
        annotations: { audience: ['assistant'], priority: 1 },
      }],
      structuredContent: metadata,
    };
  }

  if (isPdfMimeType(mimeType)) {
    const limitations = [
      'PDF text extraction, page rendering, and OCR are not available in this Worker build.',
      'Use the resource link to fetch the original PDF bytes in clients that can render or inspect PDFs.',
    ];
    const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'resource_link', resourceUri, {
      textExtracted: false,
      renderedPages: [],
      limitations,
    });
    return {
      content: [
        { type: 'text', text: `PDF attachment "${attachmentDisplayName(downloaded)}" is available as an MCP resource. ${limitations[0]}` },
        resourceLink(downloaded, resourceUri, 'Original PDF attachment'),
      ],
      structuredContent: metadata,
    };
  }

  const metadata = metadataFromDownloadedAttachment(downloaded, mode, 'resource_link', resourceUri, {
    limitations: ['This binary MIME type is not directly model-visible; fetch the linked MCP resource for the original bytes.'],
  });
  return {
    content: [
      { type: 'text', text: `Attachment "${attachmentDisplayName(downloaded)}" is available as an MCP resource; MIME type ${mimeType ?? 'unknown'} is not directly model-visible.` },
      resourceLink(downloaded, resourceUri, 'Original Gmail attachment'),
    ],
    structuredContent: metadata,
  };
}

function registerGmailAttachmentResources(server: McpServer, client: GoogleGmailClient): void {
  server.registerResource(
    'gmail_attachment',
    new ResourceTemplate('gmail://messages/{messageId}/attachments/{attachmentId}', { list: undefined }),
    {
      title: 'Gmail attachment',
      description: 'Read a Gmail attachment by message id and attachment id.',
    },
    async (uri, variables) => {
      const messageId = decodeURIComponent(String(variables.messageId));
      const attachmentId = decodeURIComponent(String(variables.attachmentId));
      const downloaded = await downloadAttachment({
        messageId,
        attachmentId,
        outputMode: 'base64',
        maxBytes: MAX_ATTACHMENT_BYTES,
      }, client) as Record<string, unknown>;
      const mimeType = typeof downloaded.mimeType === 'string' ? downloaded.mimeType : undefined;
      const data = String(downloaded.data ?? '');

      if (isTextLikeMimeType(mimeType)) {
        return {
          contents: [{
            uri: uri.toString(),
            mimeType,
            text: textDecoder.decode(decodeBase64(data)),
          }],
        };
      }

      return {
        contents: [{
          uri: uri.toString(),
          ...(mimeType ? { mimeType } : {}),
          blob: data,
        }],
      };
    },
  );
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
    resultMode: 'json' | 'native' = 'json',
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
        const result = await handler(parsed);
        return resultMode === 'native' ? result as CallToolResult : okResult(result);
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

  if (hasScope(grantedScope, 'gmail.read')) {
    registerGmailAttachmentResources(server, client);
  }

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

  register('gmail_get_message', 'gmail.read', 'Get one Gmail message by id. For compact LLM-safe output, use bodyFormat="sanitized" with includePayloadData=false to return concise metadata, readable body text, and extracted links without the Gmail MIME payload, transport headers, or base64 body blobs. Set includePayloadData=true only when the original Gmail payload is explicitly needed.', {
    id: z.string().min(1),
    format: z.enum(['metadata', 'full', 'minimal', 'raw']).default('metadata').optional(),
    metadataHeaders: z.array(z.string().min(1).max(100)).max(25).optional(),
    bodyFormat: z.enum(['none', 'decoded', 'sanitized']).default('none').optional(),
    includePayloadData: z.boolean().describe('When bodyFormat is decoded or sanitized, false/default omits the top-level Gmail payload for compact output; true includes the original Gmail MIME payload.').optional(),
    maxBodyBytes: z.number().int().min(1).max(MAX_MESSAGE_BODY_BYTES).default(1024 * 1024).optional(),
  }, gmailMessageOutput, async ({ id, format = 'metadata', metadataHeaders, bodyFormat = 'none', includePayloadData, maxBodyBytes = 1024 * 1024 }) => {
    const effectiveFormat = bodyFormat === 'none' ? format : 'full';
    const params = buildMetadataHeaderParams(effectiveFormat, metadataHeaders);
    const message = await client.getMessage(id, params) as any;

    if (bodyFormat === 'none') {
      return message;
    }

    const shouldIncludePayloadData = includePayloadData ?? false;
    const body = buildMessageBody(message, bodyFormat, maxBodyBytes);

    if (!shouldIncludePayloadData) {
      return {
        ...compactMessage(message),
        body,
      };
    }

    return {
      ...message,
      body,
    };
  }, true);

  const attachmentInputSchema = {
    messageId: z.string().min(1),
    attachmentId: z.string().min(1),
    filename: z.string().min(1).max(500).optional(),
    mimeType: z.string().min(1).max(200).optional(),
    size: z.number().int().min(0).optional(),
    contentDisposition: z.string().min(1).max(1000).optional(),
    contentId: z.string().min(1).max(500).optional(),
    disposition: z.string().min(1).max(100).optional(),
    outputMode: z.enum(['base64', 'text']).default('base64').describe('base64 returns attachment bytes; text decodes raw bytes only for text-like attachments and does not extract text from PDFs, images, or office documents.').optional(),
    encoding: z.enum(['base64', 'text']).describe('Deprecated alias for outputMode. Prefer outputMode.').optional(),
    maxBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES).default(1024 * 1024).optional(),
  };
  const attachmentDescription = 'Download one Gmail message attachment by messageId and attachmentId. Recommended agent flow: use gmail_search_messages to find candidate messages, call gmail_get_message(bodyFormat="sanitized", includePayloadData=false) for compact message text plus attachments metadata, then call this tool with the attachmentId. The tool can also resolve filename, mimeType, size, contentDisposition, contentId, and partId from the message MIME tree. It returns base64 bytes by default, includes sha256Full and sha256Returned, reports PNG/JPEG dimensions when detectable from returned bytes, and caps decoded bytes with maxBytes. outputMode="text" decodes raw bytes only for text-like attachments; it does not extract PDF text, render previews, perform OCR, or create workspace files.';

  register('gmail_download_attachment', 'gmail.read', attachmentDescription, attachmentInputSchema, gmailAttachmentOutput, async (input) => {
    return downloadAttachment(input, client);
  }, true);

  const readAttachmentInputSchema = {
    messageId: z.string().min(1),
    attachmentId: z.string().min(1),
    filename: z.string().min(1).max(500).optional(),
    mimeType: z.string().min(1).max(200).optional(),
    size: z.number().int().min(0).optional(),
    contentDisposition: z.string().min(1).max(1000).optional(),
    contentId: z.string().min(1).max(500).optional(),
    disposition: z.string().min(1).max(100).optional(),
    mode: z.enum(['auto', 'metadata', 'text', 'native', 'raw']).default('auto').describe('auto/native return model-visible MCP content blocks when supported; metadata returns metadata only; text decodes text-like attachments; raw returns legacy byte JSON in text content for debugging.').optional(),
    maxBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES).default(DEFAULT_ATTACHMENT_BYTES).optional(),
  };
  const readAttachmentDescription = 'Read one Gmail attachment in an LLM-native MCP shape. Use this instead of gmail_download_attachment when an assistant should inspect attachment content. Text-like attachments return TextContent and also mirror bounded decoded text in structuredContent.text for host compatibility, images return ImageContent, audio returns AudioContent, PDFs and unknown binaries return a readable ResourceLink to gmail://messages/{messageId}/attachments/{attachmentId} plus metadata. PDF text extraction, rendering, and OCR are not available in this Worker build.';
  register('gmail_read_attachment', 'gmail.read', readAttachmentDescription, readAttachmentInputSchema, gmailReadAttachmentOutput, async (input) => {
    return readAttachment(input, client);
  }, true, false, true, ['gmail.read'], 'native');

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
