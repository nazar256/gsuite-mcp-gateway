import { describe, expect, it } from 'vitest';
import { createGoogleFetchMock, jsonResponse } from '../helpers/google-fetch';
import { createGoogleDriveClient } from '../../src/google/drive';

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

});
