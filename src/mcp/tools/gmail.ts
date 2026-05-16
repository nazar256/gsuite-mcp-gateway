import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleGmailClient } from '../../google/gmail';
import { buildMimeMessage, encodeMimeMessage, extractEmailAddress } from '../../google/mime';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

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

function buildMetadataHeaderParams(format: 'metadata' | 'full' | 'minimal', metadataHeaders?: string[]): Record<string, string | string[]> {
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
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnlyHint: boolean,
    destructiveHint = false,
  ) => {
    (server.registerTool as any)(name, {
      title: name,
      description,
      inputSchema,
      annotations: {
        title: name,
        readOnlyHint,
        destructiveHint,
        idempotentHint: readOnlyHint || !destructiveHint,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
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

  register('gmail_get_profile', 'gmail.read', 'Get the Gmail profile for the authenticated account.', {}, async () => {
    return client.getProfile();
  }, true);

  register('gmail_list_labels', 'gmail.read', 'List Gmail labels.', {}, async () => {
    return client.listLabels();
  }, true);

  register('gmail_search_messages', 'gmail.read', 'Search Gmail messages using Gmail query syntax.', {
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).default(10).optional(),
    includeSpamTrash: z.boolean().default(false).optional(),
  }, async ({ query, maxResults = 10, includeSpamTrash = false }) => {
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

  register('gmail_get_message', 'gmail.read', 'Get one Gmail message by id.', {
    id: z.string().min(1),
    format: z.enum(['metadata', 'full', 'minimal']).default('metadata').optional(),
    metadataHeaders: z.array(z.string().min(1).max(100)).max(25).optional(),
  }, async ({ id, format = 'metadata', metadataHeaders }) => {
    const params = buildMetadataHeaderParams(format, metadataHeaders);
    return client.getMessage(id, params);
  }, true);

  register('gmail_create_draft', 'gmail.drafts', 'Create a Gmail draft.', {
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(998),
    textBody: z.string().max(20000).optional(),
    htmlBody: z.string().max(50000).optional(),
    threadId: z.string().optional(),
  }, async ({ to, cc, bcc, subject, textBody, htmlBody, threadId }) => {
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
  }, async ({ to, cc, bcc, subject, textBody, htmlBody, replyToMessageId, threadId }) => {
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

  register('gmail_reply_to_message', 'gmail.send', 'Reply to an existing Gmail message.', {
    id: z.string().min(1),
    textBody: z.string().max(20000).optional(),
    htmlBody: z.string().max(50000).optional(),
  }, async ({ id, textBody, htmlBody }) => {
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
  }, false);

  register('gmail_modify_message_labels', 'gmail.modify', 'Add or remove Gmail labels from a message.', {
    id: z.string().min(1),
    addLabelIds: z.array(z.string()).max(50).optional(),
    removeLabelIds: z.array(z.string()).max(50).optional(),
  }, async ({ id, addLabelIds, removeLabelIds }) => {
    if ((!addLabelIds || addLabelIds.length === 0) && (!removeLabelIds || removeLabelIds.length === 0)) {
      throw new HttpError(400, 'invalid_request', 'At least one label change is required');
    }
    return client.modifyMessageLabels(id, { addLabelIds, removeLabelIds });
  }, false);

  register('gmail_archive_message', 'gmail.modify', 'Archive a Gmail message by removing INBOX.', {
    id: z.string().min(1),
  }, async ({ id }) => client.modifyMessageLabels(id, { removeLabelIds: ['INBOX'] }), false);

  register('gmail_trash_message', 'gmail.modify', 'Move a Gmail message to trash.', {
    id: z.string().min(1),
  }, async ({ id }) => client.trashMessage(id), false, true);

  register('gmail_mark_read_unread', 'gmail.modify', 'Mark a Gmail message as read or unread.', {
    id: z.string().min(1),
    read: z.boolean(),
  }, async ({ id, read }) => client.modifyMessageLabels(id, {
    addLabelIds: read ? [] : ['UNREAD'],
    removeLabelIds: read ? ['UNREAD'] : [],
  }), false);
}
