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
    const send = (server as any)._registeredTools?.gmail_send_email;

    expect(labels?.outputSchema).toBeDefined();
    expect(search?.outputSchema).toBeDefined();
    expect(send?.outputSchema).toBeDefined();
  });

  it('returns sanitized message body and links without Gmail base64 payload data by default', async () => {
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
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: 'Bekendmaking' }],
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
    const result = await tool.handler({ id: 'msg-1', bodyFormat: 'sanitized' }, {});

    expect(result.isError).not.toBe(true);
    expect(mock.requests[0]?.url).toContain('format=full');
    expect(result.structuredContent.body.sanitizedText).toContain('1 nieuw bericht');
    expect(result.structuredContent.body.sanitizedText).toContain('Gemeente Hoorn vergunning (https://example.test/publication?name=vergunning&id=123)');
    expect(result.structuredContent.body.sanitizedText).not.toContain('window.evil');
    expect(result.structuredContent.body.links).toEqual([
      {
        url: 'https://example.test/publication?name=vergunning&id=123',
        text: 'Gemeente Hoorn vergunning',
      },
    ]);
    expect(result.structuredContent.payload.parts[0].body.data).toBeUndefined();
    expect(result.content[0]?.text).not.toContain(encodeGmailBodyData(html));
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
});
