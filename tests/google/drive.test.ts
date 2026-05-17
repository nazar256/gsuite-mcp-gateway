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

  it('constructs folder create request with shared-drive flag', async () => {
    const mock = createGoogleFetchMock({
      'https://www.googleapis.com/drive/v3/files': jsonResponse({ id: 'folder-1', name: 'Docs', mimeType: 'application/vnd.google-apps.folder' }),
    });
    const client = createGoogleDriveClient('token-1', mock.fetch);

    await client.createFile({ name: 'Docs', mimeType: 'application/vnd.google-apps.folder' });

    expect(mock.requests[0]?.url).toContain('supportsAllDrives=true');
    expect(mock.requests[0]?.bodyText).toContain('application/vnd.google-apps.folder');
  });

  it('constructs metadata patch for rename and move', async () => {
    const mock = createGoogleFetchMock({
      'https://www.googleapis.com/drive/v3/files/file-1': jsonResponse({ id: 'file-1', name: 'Renamed.txt' }),
    });
    const client = createGoogleDriveClient('token-1', mock.fetch);

    await client.updateFile('file-1', { name: 'Renamed.txt' }, {
      addParents: 'folder-2',
      removeParents: 'folder-1',
      fields: 'id,name',
    });

    expect(mock.requests[0]?.url).toContain('supportsAllDrives=true');
    expect(mock.requests[0]?.url).toContain('addParents=folder-2');
    expect(mock.requests[0]?.url).toContain('removeParents=folder-1');
    expect(mock.requests[0]?.bodyText).toContain('Renamed.txt');
  });

  it('registers drive tools when drive.write is granted', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'drive.write',
    });

    const toolNames = Object.keys((server as any)._registeredTools ?? {});
    expect(toolNames).toEqual(expect.arrayContaining(['drive_upload_file', 'drive_create_folder', 'drive_update_file', 'drive_delete_file', 'drive_get_file', 'drive_download_file']));
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

  it('does not register write tools when only drive.read is granted', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'drive.read',
    });

    const toolNames = Object.keys((server as any)._registeredTools ?? {});
    expect(toolNames).toEqual(expect.arrayContaining(['drive_list_files', 'drive_get_file', 'drive_download_file']));
    expect(toolNames).not.toContain('drive_upload_file');
    expect(toolNames).not.toContain('drive_delete_file');
  });

  it('registers output schemas for drive tools', () => {
    const server = createGatewayMcpServer(parseConfig(createTestEnv()), {
      googleAccessToken: 'token-1',
      grantedScope: 'drive.read drive.write',
    });

    const listFiles = (server as any)._registeredTools?.drive_list_files;
    const downloadFile = (server as any)._registeredTools?.drive_download_file;
    const deleteFile = (server as any)._registeredTools?.drive_delete_file;

    expect(listFiles?.outputSchema).toBeDefined();
    expect(downloadFile?.outputSchema).toBeDefined();
    expect(deleteFile?.outputSchema).toBeDefined();
  });

});
