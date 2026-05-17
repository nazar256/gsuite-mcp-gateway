import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleDriveClient } from '../../src/google/drive';
import { createGatewayMcpServer } from '../../src/mcp/server';
import { parseConfig } from '../../src/config';
import { createTestEnv } from '../helpers/env';

describe('drive client', () => {
  it('constructs list query with shared-drive flags', async () => {
    const mock = createGoogleFetchMock({
      'https://www.googleapis.com/drive/v3/files': jsonResponse({ files: [] }),
    });
    const client = createGoogleDriveClient('token-1', mock.fetch);

    await client.listFiles({
      q: "name contains 'report'",
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    expect(mock.requests[0]?.url).toContain('supportsAllDrives=true');
    expect(mock.requests[0]?.url).toContain('includeItemsFromAllDrives=true');
    expect(mock.requests[0]?.url).toContain('q=name+contains');
  });

  it('constructs multipart upload request', async () => {
    const mock = createGoogleFetchMock({
      'https://www.googleapis.com/upload/drive/v3/files': jsonResponse({ id: 'file-1', name: 'hello.txt' }),
    });
    const client = createGoogleDriveClient('token-1', mock.fetch);

    await client.createMultipartFile({ name: 'hello.txt' }, new TextEncoder().encode('hello'), 'text/plain');

    expect(mock.requests[0]?.url).toContain('uploadType=multipart');
    expect(mock.requests[0]?.headers['content-type']).toContain('multipart/related; boundary=');
  });

  it('registers drive verification tools when drive.write is granted', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'drive.write',
    });

    const toolNames = Object.keys((server as any)._registeredTools ?? {});
    expect(toolNames).toEqual(expect.arrayContaining(['drive_upload_file', 'drive_delete_file']));
  });

  it('reports invalid base64 as invalid_request', async () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'drive.write',
    });

    const tool = (server as any)._registeredTools?.drive_upload_file;
    const result = await tool.handler({
      name: 'bad.bin',
      contentBase64: 'not-valid-***',
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/valid base64/i);
  });
});
