import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleGmailClient } from '../../src/google/gmail';
import { extractEmailAddress } from '../../src/google/mime';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

function encodeGmailBodyData(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeGmailBytesData(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('gmail client', () => {
  it('constructs send request', async () => {
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send': jsonResponse({ id: '123' }),
    });
    const client = createGoogleGmailClient('token-1', mock.fetch);
    await client.sendMessage('raw-message', 'thread-1');
    expect(mock.requests[0]?.bodyText).toContain('raw-message');
    expect(mock.requests[0]?.bodyText).toContain('thread-1');
  });

  it('preserves repeated metadataHeaders query params', async () => {
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1': jsonResponse({ id: 'msg-1' }),
    });
    const client = createGoogleGmailClient('token-1', mock.fetch);

    await client.getMessage('msg-1', {
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Reply-To'],
    });

    const url = mock.requests[0]?.url ?? '';
    expect(url).toContain('metadataHeaders=Subject');
    expect(url).toContain('metadataHeaders=From');
    expect(url).toContain('metadataHeaders=To');
    expect(url).toContain('metadataHeaders=Date');
    expect(url).toContain('metadataHeaders=Reply-To');
  });

  it('constructs attachment download request', async () => {
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2F1/attachments/att%2F1': jsonResponse({ data: encodeGmailBodyData('pdf') }),
    });
    const client = createGoogleGmailClient('token-1', mock.fetch);

    await client.getAttachment('msg/1', 'att/1');

    expect(mock.requests[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/msg%2F1/attachments/att%2F1');
    expect(mock.requests[0]?.headers.authorization).toBe('Bearer token-1');
  });

  it('extracts bare email from display-name header value', () => {
    expect(extractEmailAddress('Example User <user@example.com>')).toBe('user@example.com');
  });

  it('registers output schemas for gmail tools', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read gmail.send gmail.modify gmail.drafts',
    });

    const labels = (server as any)._registeredTools?.gmail_list_labels;
    const search = (server as any)._registeredTools?.gmail_search_messages;
    const readAttachment = (server as any)._registeredTools?.gmail_read_attachment;
    const send = (server as any)._registeredTools?.gmail_send_email;

    expect(labels?.outputSchema).toBeDefined();
    expect(search?.outputSchema).toBeDefined();
    expect(readAttachment?.outputSchema).toBeDefined();
    expect(send?.outputSchema).toBeDefined();
  });

  it('returns compact sanitized message body and links without Gmail payload data by default', async () => {
    const html = `
      <html>
        <head><style>.hidden { display: none; }</style></head>
        <body>
          <p>1 nieuw bericht</p>
          <a href="https://example.test/publication?name=vergunning&amp;id=123">Gemeente Hoorn vergunning</a>
          <script>window.evil = true;</script>
        </body>
      </html>
    `;
    const message = {
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      snippet: '1 nieuw bericht',
      historyId: 'history-1',
      internalDate: '1710000000000',
      sizeEstimate: 2048,
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'Subject', value: 'Bekendmaking' },
          { name: 'From', value: 'Sender <sender@example.test>' },
          { name: 'To', value: 'Recipient <recipient@example.test>' },
          { name: 'Date', value: 'Mon, 10 Jun 2026 12:00:00 +0000' },
          { name: 'Authentication-Results', value: 'mx.example.test; dkim=pass very-large-transport-header' },
        ],
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            body: { size: 29, data: encodeGmailBodyData('Plain fallback body') },
          },
          {
            partId: '1',
            mimeType: 'text/html',
            body: { size: html.length, data: encodeGmailBodyData(html) },
          },
          {
            partId: '2',
            mimeType: 'application/pdf',
            filename: 'permit.pdf',
            headers: [
              { name: 'Content-Disposition', value: 'attachment; filename=permit.pdf; size=4321' },
              { name: 'Content-ID', value: '<permit-1@example.test>' },
            ],
            body: { attachmentId: 'att-permit', size: 4321 },
          },
        ],
      },
    };
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1': jsonResponse(message),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_get_message;
    const result = await tool.handler({
      id: 'msg-1',
      format: 'full',
      bodyFormat: 'sanitized',
      includePayloadData: false,
      maxBodyBytes: 20000,
    }, {});

    expect(result.isError).not.toBe(true);
    expect(mock.requests[0]?.url).toContain('format=full');
    expect(result.structuredContent).toMatchObject({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      snippet: '1 nieuw bericht',
      historyId: 'history-1',
      internalDate: '1710000000000',
      sizeEstimate: 2048,
      subject: 'Bekendmaking',
      from: 'Sender <sender@example.test>',
      to: 'Recipient <recipient@example.test>',
      date: 'Mon, 10 Jun 2026 12:00:00 +0000',
    });
    expect(result.structuredContent.payload).toBeUndefined();
    expect(result.structuredContent.raw).toBeUndefined();
    expect(result.structuredContent.body.sanitizedText).toContain('1 nieuw bericht');
    expect(result.structuredContent.body.sanitizedText).toContain('Gemeente Hoorn vergunning (https://example.test/publication?name=vergunning&id=123)');
    expect(result.structuredContent.body.sanitizedText).not.toContain('window.evil');
    expect(result.structuredContent.body.links).toEqual([
      {
        url: 'https://example.test/publication?name=vergunning&id=123',
        text: 'Gemeente Hoorn vergunning',
      },
    ]);
    expect(result.structuredContent.attachments).toEqual([
      {
        partId: '2',
        attachmentId: 'att-permit',
        filename: 'permit.pdf',
        mimeType: 'application/pdf',
        size: 4321,
        disposition: 'attachment',
        contentDisposition: 'attachment; filename=permit.pdf; size=4321',
        contentId: '<permit-1@example.test>',
      },
    ]);
    expect(result.content[0]?.text).not.toContain(encodeGmailBodyData(html));
    expect(result.content[0]?.text).not.toContain('Authentication-Results');
    expect(result.content[0]?.text).not.toContain('very-large-transport-header');
    expect(result.content[0]?.text).not.toContain('multipart/alternative');
  });

  it('returns compact sanitized message body without Gmail payload data when includePayloadData is omitted', async () => {
    const message = {
      id: 'msg-default-compact',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Compact default' }],
        body: { data: encodeGmailBodyData('Compact body') },
      },
    };
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-default-compact': jsonResponse(message),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_get_message;
    const result = await tool.handler({ id: 'msg-default-compact', bodyFormat: 'sanitized' }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.payload).toBeUndefined();
    expect(result.structuredContent.subject).toBe('Compact default');
    expect(result.structuredContent.body.sanitizedText).toBe('Compact body');
    expect(result.content[0]?.text).not.toContain(encodeGmailBodyData('Compact body'));
  });

  it('returns decoded text and html body when requested', async () => {
    const html = '<p>Full HTML body with <strong>details</strong></p>';
    const message = {
      id: 'msg-2',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            body: { data: encodeGmailBodyData('Full plain body') },
          },
          {
            partId: '1',
            mimeType: 'text/html',
            body: { data: encodeGmailBodyData(html) },
          },
        ],
      },
    };
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-2': jsonResponse(message),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_get_message;
    const result = await tool.handler({ id: 'msg-2', bodyFormat: 'decoded', includePayloadData: true }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.body.textPlain).toBe('Full plain body');
    expect(result.structuredContent.body.textHtml).toBe(html);
    expect(result.structuredContent.body.truncated).toBe(false);
    expect(result.structuredContent.payload.parts[0].body.data).toBe(encodeGmailBodyData('Full plain body'));
  });

  it('allows requesting Gmail raw message format', async () => {
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-raw': jsonResponse({ id: 'msg-raw', raw: encodeGmailBodyData('raw rfc822 message') }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_get_message;
    const result = await tool.handler({ id: 'msg-raw', format: 'raw' }, {});

    expect(result.isError).not.toBe(true);
    expect(mock.requests[0]?.url).toContain('format=raw');
    expect(result.structuredContent.raw).toBe(encodeGmailBodyData('raw rfc822 message'));
  });

  it('downloads a small PDF attachment as base64 with metadata', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-pdf/attachments/att-pdf': jsonResponse({
        data: encodeGmailBytesData(pdfBytes),
        size: pdfBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: 'msg-pdf',
      attachmentId: 'att-pdf',
      filename: 'Tarievenoverzicht.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
      outputMode: 'base64',
      maxBytes: 100,
    }, {});

    expect(result.isError).not.toBe(true);
    expect(mock.requests[0]?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-pdf/attachments/att-pdf');
    expect(result.structuredContent).toMatchObject({
      messageId: 'msg-pdf',
      attachmentId: 'att-pdf',
      filename: 'Tarievenoverzicht.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
      encoding: 'base64',
      outputMode: 'base64',
      bytes: pdfBytes.byteLength,
      truncated: false,
      data: Buffer.from(pdfBytes).toString('base64'),
    });
    expect(result.structuredContent.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent.sha256Full).toBe(result.structuredContent.sha256);
    expect(result.structuredContent.sha256Returned).toBe(result.structuredContent.sha256);
  });

  it('exposes gmail_download_attachment and resolves metadata from the message MIME tree', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const message = {
      id: '19e72737aed9cc02',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'Tarievenoverzicht.pdf',
            headers: [
              { name: 'Content-Type', value: 'application/pdf; name=Tarievenoverzicht.pdf' },
              { name: 'Content-Disposition', value: 'attachment; filename=Tarievenoverzicht.pdf; size=23467' },
              { name: 'Content-ID', value: '<tarieven@example.test>' },
            ],
            body: {
              attachmentId: 'att-tarieven',
              size: 23467,
            },
          },
        ],
      },
    };
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/19e72737aed9cc02/attachments/att-tarieven': jsonResponse({
        data: encodeGmailBytesData(pdfBytes),
        size: 23467,
      }),
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/19e72737aed9cc02': jsonResponse(message),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: '19e72737aed9cc02',
      attachmentId: 'att-tarieven',
      encoding: 'base64',
      maxBytes: 10485760,
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      messageId: '19e72737aed9cc02',
      attachmentId: 'att-tarieven',
      filename: 'Tarievenoverzicht.pdf',
      mimeType: 'application/pdf',
      size: 23467,
      partId: '1',
      disposition: 'attachment',
      contentDisposition: 'attachment; filename=Tarievenoverzicht.pdf; size=23467',
      contentId: '<tarieven@example.test>',
      encoding: 'base64',
      outputMode: 'base64',
      data: Buffer.from(pdfBytes).toString('base64'),
      truncated: false,
    });
    expect(result.structuredContent.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps downloaded attachments by maxBytes and reports truncation', async () => {
    const attachmentBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-large/attachments/att-large': jsonResponse({
        data: encodeGmailBytesData(attachmentBytes),
        size: attachmentBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: 'msg-large',
      attachmentId: 'att-large',
      outputMode: 'base64',
      maxBytes: 3,
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      messageId: 'msg-large',
      attachmentId: 'att-large',
      size: attachmentBytes.byteLength,
      encoding: 'base64',
      outputMode: 'base64',
      bytes: 3,
      truncated: true,
      data: Buffer.from([1, 2, 3]).toString('base64'),
    });
    expect(result.structuredContent.sha256Full).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent.sha256Returned).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent.sha256Full).not.toBe(result.structuredContent.sha256Returned);
    expect(result.structuredContent.sha256).toBe(result.structuredContent.sha256Returned);
  });

  it('reports PNG image dimensions for returned attachment bytes', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x10,
      0x00, 0x00, 0x00, 0x20,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-image/attachments/att-image': jsonResponse({
        data: encodeGmailBytesData(pngBytes),
        size: pngBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: 'msg-image',
      attachmentId: 'att-image',
      mimeType: 'image/png',
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      width: 16,
      height: 32,
    });
  });

  it('reads PNG attachments as MCP image content instead of JSON base64 text', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x10,
      0x00, 0x00, 0x00, 0x20,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-native-image/attachments/att-native-image': jsonResponse({
        data: encodeGmailBytesData(pngBytes),
        size: pngBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_read_attachment;
    const result = await tool.handler({
      messageId: 'msg-native-image',
      attachmentId: 'att-native-image',
      filename: 'image001.png',
      mimeType: 'image/png',
      size: pngBytes.byteLength,
      contentDisposition: 'attachment; filename=image001.png',
      contentId: '<image001@example.test>',
      disposition: 'attachment',
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from(pngBytes).toString('base64'),
      }),
    ]);
    expect(result.content[0]?.text).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      messageId: 'msg-native-image',
      attachmentId: 'att-native-image',
      filename: 'image001.png',
      mimeType: 'image/png',
      representation: 'image',
      resourceUri: 'gmail://messages/msg-native-image/attachments/att-native-image',
      width: 16,
      height: 32,
      truncated: false,
    });
    expect(result.structuredContent.data).toBeUndefined();
    expect(result.structuredContent.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads text-like attachments as MCP text content', async () => {
    const text = 'BEGIN:VCALENDAR\nSUMMARY:Project check\nEND:VCALENDAR';
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-text/attachments/att-text': jsonResponse({
        data: encodeGmailBodyData(text),
        size: Buffer.byteLength(text),
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_read_attachment;
    const result = await tool.handler({
      messageId: 'msg-text',
      attachmentId: 'att-text',
      filename: 'invite.ics',
      mimeType: 'text/calendar',
      size: Buffer.byteLength(text),
      contentDisposition: 'attachment; filename=invite.ics',
      disposition: 'attachment',
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text,
    });
    expect(result.structuredContent).toMatchObject({
      filename: 'invite.ics',
      mimeType: 'text/calendar',
      representation: 'text',
      text,
      bytesReturned: Buffer.byteLength(text),
      bytesTotal: Buffer.byteLength(text),
      truncated: false,
    });
    expect(result.structuredContent.data).toBeUndefined();
  });

  it('returns PDFs as resource links with explicit extraction limitations', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-native-pdf/attachments/att-native-pdf': jsonResponse({
        data: encodeGmailBytesData(pdfBytes),
        size: pdfBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_read_attachment;
    const result = await tool.handler({
      messageId: 'msg-native-pdf',
      attachmentId: 'att-native-pdf',
      filename: 'Tarievenoverzicht.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
      contentDisposition: 'attachment; filename=Tarievenoverzicht.pdf',
      disposition: 'attachment',
    }, {});

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('PDF text extraction, page rendering, and OCR are not available'),
      }),
      expect.objectContaining({
        type: 'resource_link',
        uri: 'gmail://messages/msg-native-pdf/attachments/att-native-pdf',
        name: 'Tarievenoverzicht.pdf',
        mimeType: 'application/pdf',
      }),
    ]));
    expect(result.structuredContent).toMatchObject({
      filename: 'Tarievenoverzicht.pdf',
      mimeType: 'application/pdf',
      representation: 'resource_link',
      textExtracted: false,
      renderedPages: [],
      truncated: false,
    });
    expect(result.structuredContent.data).toBeUndefined();
  });

  it('reads Gmail attachment resources as text or blob contents', async () => {
    const text = 'hello from resource';
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-resource/attachments/att-resource': jsonResponse({
        data: encodeGmailBodyData(text),
        size: Buffer.byteLength(text),
      }),
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-resource': jsonResponse({
        id: 'msg-resource',
        payload: {
          parts: [{
            mimeType: 'text/plain',
            filename: 'note.txt',
            body: { attachmentId: 'att-resource', size: Buffer.byteLength(text) },
          }],
        },
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const template = (server as any)._registeredResourceTemplates?.gmail_attachment;
    const uri = new URL('gmail://messages/msg-resource/attachments/att-resource');
    const result = await template.readCallback(uri, {
      messageId: 'msg-resource',
      attachmentId: 'att-resource',
    }, {});

    expect(result.contents).toEqual([{
      uri: 'gmail://messages/msg-resource/attachments/att-resource',
      mimeType: 'text/plain',
      text,
    }]);
  });

  it('rejects text output for non-text attachments instead of pretending to extract PDF text', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-pdf-text/attachments/att-pdf-text': jsonResponse({
        data: encodeGmailBytesData(pdfBytes),
        size: pdfBytes.byteLength,
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: 'msg-pdf-text',
      attachmentId: 'att-pdf-text',
      mimeType: 'application/pdf',
      outputMode: 'text',
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('outputMode="text" decodes raw bytes and is only supported for text-like attachments');
    expect(result.content[0]?.text).toContain('application/pdf');
  });

  it('rejects invalid Gmail attachment base64url data', async () => {
    const mock = createGoogleFetchMock({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-bad/attachments/att-bad': jsonResponse({
        data: '%%%not-base64url%%%',
      }),
    });
    const server = createGatewayMcpServer(parseConfig(createTestEnv({ fetch: mock.fetch })), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read',
    });

    const tool = (server as any)._registeredTools?.gmail_download_attachment;
    const result = await tool.handler({
      messageId: 'msg-bad',
      attachmentId: 'att-bad',
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Gmail attachment contains invalid base64url data');
  });
});
