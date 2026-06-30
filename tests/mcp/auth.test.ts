import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createWorkerTestContext } from '../helpers/worker';
import { extractHiddenInput, registerClient } from '../helpers/oauth-flow';
import { createS256CodeChallenge } from '../../src/oauth/pkce';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

async function completeFlow(scope = 'calendar.write gmail.send offline_access', extraGoogleRoutes: Record<string, Response | ((request: Request) => Response | Promise<Response>)> = {}) {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
  const challenge = await createS256CodeChallenge(verifier);
  const googleScopesByRequestedScope: Record<string, string> = {
    'calendar.write': 'https://www.googleapis.com/auth/calendar.events',
    'drive.read': 'https://www.googleapis.com/auth/drive',
    'drive.write': 'https://www.googleapis.com/auth/drive',
    'gmail.read': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
    'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.drafts': 'https://www.googleapis.com/auth/gmail.compose',
  };
  const googleScopeSet = new Set(['openid', 'email', 'profile']);
  for (const requestedScope of scope.split(' ').filter(Boolean)) {
    const googleScope = googleScopesByRequestedScope[requestedScope];
    if (googleScope) {
      googleScopeSet.add(googleScope);
    }
  }
  const googleMock = createGoogleFetchMock({
    'https://oauth2.googleapis.com/token': jsonResponse({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      scope: [...googleScopeSet].join(' '),
      token_type: 'Bearer',
    }),
    'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
      sub: 'google-user-123',
      email: 'me@example.com',
    }),
    ...extraGoogleRoutes,
  });

  const ctx = createWorkerTestContext({ fetch: googleMock.fetch });
  const registration = await registerClient(ctx);
  const clientId = String(registration.json.client_id);

  const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent(scope)}`);
  const csrfToken = extractHiddenInput(await authorizeResponse.text(), 'csrf_token');
  const postAuthorize = await ctx.callWorker('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'http://localhost:8787/mcp',
      scope,
      csrf_token: csrfToken,
    }),
    redirect: 'manual',
  });

  const state = new URL(postAuthorize.headers.get('location')!).searchParams.get('state')!;
  const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=google-auth-code`, { redirect: 'manual' });
  const authCode = new URL(callbackResponse.headers.get('location')!).searchParams.get('code')!;
  const tokenResponse = await ctx.callWorker('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_verifier: verifier,
      resource: 'http://localhost:8787/mcp',
    }),
  });

  return {
    ctx,
    token: String((await tokenResponse.json() as Record<string, unknown>).access_token),
  };
}

async function completeFlowInContext(ctx: ReturnType<typeof createWorkerTestContext>, scope: string, subject = 'google-user-123') {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-._~a';
  const challenge = await createS256CodeChallenge(verifier);
  const googleScopesByRequestedScope: Record<string, string> = {
    'calendar.write': 'https://www.googleapis.com/auth/calendar.events',
    'drive.read': 'https://www.googleapis.com/auth/drive',
    'drive.write': 'https://www.googleapis.com/auth/drive',
    'gmail.read': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
    'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
    'gmail.drafts': 'https://www.googleapis.com/auth/gmail.compose',
  };
  const googleScopeSet = new Set(['openid', 'email', 'profile']);
  for (const requestedScope of scope.split(' ').filter(Boolean)) {
    const googleScope = googleScopesByRequestedScope[requestedScope];
    if (googleScope) {
      googleScopeSet.add(googleScope);
    }
  }

  ctx.env.fetch = createGoogleFetchMock({
    'https://oauth2.googleapis.com/token': jsonResponse({
      access_token: 'google-access',
      refresh_token: 'google-refresh',
      expires_in: 3600,
      scope: [...googleScopeSet].join(' '),
      token_type: 'Bearer',
    }),
    'https://openidconnect.googleapis.com/v1/userinfo': jsonResponse({
      sub: subject,
      email: 'me@example.com',
    }),
  }).fetch;

  const registration = await registerClient(ctx);
  const clientId = String(registration.json.client_id);

  const authorizeResponse = await ctx.callWorker(`/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(registration.redirectUri)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&resource=${encodeURIComponent('http://localhost:8787/mcp')}&scope=${encodeURIComponent(scope)}`);
  const csrfToken = extractHiddenInput(await authorizeResponse.text(), 'csrf_token');
  const postAuthorize = await ctx.callWorker('/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'http://localhost:8787/mcp',
      scope,
      csrf_token: csrfToken,
    }),
    redirect: 'manual',
  });

  const state = new URL(postAuthorize.headers.get('location')!).searchParams.get('state')!;
  const callbackResponse = await ctx.callWorker(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=google-auth-code-${encodeURIComponent(scope)}`, { redirect: 'manual' });
  const authCode = new URL(callbackResponse.headers.get('location')!).searchParams.get('code')!;
  const tokenResponse = await ctx.callWorker('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: clientId,
      redirect_uri: registration.redirectUri,
      code_verifier: verifier,
      resource: 'http://localhost:8787/mcp',
    }),
  });

  return {
    ctx,
    token: String((await tokenResponse.json() as Record<string, unknown>).access_token),
    clientId,
  };
}

async function listToolNames(ctx: ReturnType<typeof createWorkerTestContext>, token: string): Promise<string[]> {
  const response = await ctx.callWorker('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  const json = await response.json() as { result?: { tools?: Array<{ name: string }> } };
  return (json.result?.tools ?? []).map((tool) => tool.name);
}

async function callMcpTool(ctx: ReturnType<typeof createWorkerTestContext>, token: string, name: string, args: Record<string, unknown>) {
  const response = await ctx.callWorker('/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    }),
  });
  const json = await response.json() as { result?: { content?: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown> } };
  return { response, json };
}

function encodeGmailBytesData(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('mcp auth and tool registration', () => {
  it('accepts lowercase bearer authorization scheme on /mcp', async () => {
    const flow = await completeFlow();
    const response = await flow.ctx.callWorker('/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `bearer ${flow.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).not.toBe(401);
  });

  it('only registers tools for granted scopes', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'calendar.read calendar.write gmail.send',
    });

    const toolNames = Object.keys((server as any)._registeredTools ?? {});
    expect(toolNames).toContain('calendar_list_calendars');
    expect(toolNames).toContain('calendar_create_event');
    expect(toolNames).toContain('gmail_send_email');
    expect(toolNames).not.toContain('gmail_reply_to_message');
    expect(toolNames).not.toContain('gmail_get_profile');
    expect(toolNames).not.toContain('gmail_get_attachment');
    expect(toolNames).not.toContain('gmail_download_attachment');
    expect(toolNames).not.toContain('gmail_read_attachment');
    expect(toolNames).not.toContain('drive_list_files');
  });

  it('exposes calendar, drive, and gmail tools after a widened grant', async () => {
    const flow = await completeFlow('calendar.write drive.write gmail.modify gmail.drafts offline_access');
    const toolNames = await listToolNames(flow.ctx, flow.token);

    expect(toolNames).toEqual(expect.arrayContaining([
      'calendar_create_event',
      'drive_list_files',
      'drive_update_file',
      'gmail_get_profile',
      'gmail_download_attachment',
      'gmail_read_attachment',
      'gmail_modify_message_labels',
      'gmail_create_draft',
    ]));
    expect(toolNames).not.toContain('gmail_get_attachment');
  });

  it('returns Gmail image attachments as MCP image content through /mcp tools/call', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x08,
      0x00, 0x00, 0x00, 0x09,
      0x08, 0x02, 0x00, 0x00, 0x00,
    ]);
    const flow = await completeFlow('gmail.read offline_access', {
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-mcp-image/attachments/att-mcp-image': jsonResponse({
        data: encodeGmailBytesData(pngBytes),
        size: pngBytes.byteLength,
      }),
    });

    const { response, json } = await callMcpTool(flow.ctx, flow.token, 'gmail_read_attachment', {
      messageId: 'msg-mcp-image',
      attachmentId: 'att-mcp-image',
      filename: 'mcp-image.png',
      mimeType: 'image/png',
      size: pngBytes.byteLength,
    });

    expect(response.status).toBe(200);
    expect(json.result?.content).toEqual([
      expect.objectContaining({
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from(pngBytes).toString('base64'),
      }),
    ]);
    expect(json.result?.structuredContent).toMatchObject({
      filename: 'mcp-image.png',
      mimeType: 'image/png',
      representation: 'image',
      resourceUri: 'gmail://messages/msg-mcp-image/attachments/att-mcp-image',
      width: 8,
      height: 9,
      truncated: false,
    });
    expect(json.result?.structuredContent?.data).toBeUndefined();
  });

  it('returns Gmail text attachments as MCP text content through /mcp tools/call in auto and text modes', async () => {
    const calendarText = 'BEGIN:VCALENDAR\nVERSION:2.0\nSUMMARY:MCP text test\nEND:VCALENDAR';
    const flow = await completeFlow('gmail.read offline_access', {
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-mcp-text/attachments/att-mcp-text': jsonResponse({
        data: encodeGmailBytesData(Buffer.from(calendarText, 'utf8')),
        size: Buffer.byteLength(calendarText),
      }),
    });

    for (const mode of ['auto', 'text']) {
      const { response, json } = await callMcpTool(flow.ctx, flow.token, 'gmail_read_attachment', {
        messageId: 'msg-mcp-text',
        attachmentId: 'att-mcp-text',
        filename: 'invite.ics',
        mimeType: 'text/calendar',
        size: Buffer.byteLength(calendarText),
        mode,
      });

      expect(response.status).toBe(200);
      expect(json.result?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('BEGIN:VCALENDAR'),
        }),
      ]));
      expect(json.result?.structuredContent).toMatchObject({
        filename: 'invite.ics',
        mimeType: 'text/calendar',
        representation: 'text',
        text: expect.stringContaining('BEGIN:VCALENDAR'),
        bytesReturned: Buffer.byteLength(calendarText),
        bytesTotal: Buffer.byteLength(calendarText),
        truncated: false,
      });
      expect(json.result?.structuredContent?.data).toBeUndefined();
    }
  });

  it('returns Gmail PDFs as resource links through /mcp tools/call without extraction', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const flow = await completeFlow('gmail.read offline_access', {
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-mcp-pdf/attachments/att-mcp-pdf': jsonResponse({
        data: encodeGmailBytesData(pdfBytes),
        size: pdfBytes.byteLength,
      }),
    });

    const { response, json } = await callMcpTool(flow.ctx, flow.token, 'gmail_read_attachment', {
      messageId: 'msg-mcp-pdf',
      attachmentId: 'att-mcp-pdf',
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
    });

    expect(response.status).toBe(200);
    expect(json.result?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'resource_link',
        uri: 'gmail://messages/msg-mcp-pdf/attachments/att-mcp-pdf',
        name: 'document.pdf',
        mimeType: 'application/pdf',
      }),
    ]));
    expect(json.result?.structuredContent).toMatchObject({
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      representation: 'resource_link',
      textExtracted: false,
      renderedPages: [],
    });
    expect(json.result?.structuredContent?.text).toBeUndefined();
    expect(json.result?.structuredContent?.data).toBeUndefined();
  });

  it('does not silently broaden an existing access token after the stored grant widens', async () => {
    const ctx = createWorkerTestContext();
    const initial = await completeFlowInContext(ctx, 'calendar.write offline_access');
    const initialTools = await listToolNames(ctx, initial.token);
    expect(initialTools).toContain('calendar_create_event');
    expect(initialTools).not.toContain('drive_list_files');

    await completeFlowInContext(ctx, 'calendar.write drive.write offline_access');

    const afterWidenTools = await listToolNames(ctx, initial.token);
    expect(afterWidenTools).toContain('calendar_create_event');
    expect(afterWidenTools).not.toContain('drive_list_files');
  });

  it('marks non-destructive writes as non-idempotent and reply tool advertises both scopes', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'gmail.read gmail.send gmail.modify gmail.drafts calendar.write drive.write',
    });

    const tools = (server as any)._registeredTools ?? {};
    expect(tools.calendar_create_event?.annotations?.idempotentHint).toBe(false);
    expect(tools.drive_upload_file?.annotations?.idempotentHint).toBe(false);
    expect(tools.gmail_send_email?.annotations?.idempotentHint).toBe(false);
    expect(tools.gmail_reply_to_message?._meta?.securitySchemes?.[0]?.scopes).toEqual(['gmail.read', 'gmail.send']);
  });
});
