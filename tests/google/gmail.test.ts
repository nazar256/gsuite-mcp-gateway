import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleGmailClient } from '../../src/google/gmail';
import { extractEmailAddress } from '../../src/google/mime';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

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
});
