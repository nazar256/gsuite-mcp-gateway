import { expectGoogleJson } from './errors';

function buildDriveHeaders(accessToken: string, contentType?: string): HeadersInit {
  return {
    authorization: `Bearer ${accessToken}`,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
}

export interface GoogleDriveClient {
  listFiles(params: Record<string, string>): Promise<unknown>;
  getFile(fileId: string, params: Record<string, string>): Promise<unknown>;
  downloadFile(fileId: string, params: Record<string, string>, headers?: Record<string, string>): Promise<Response>;
  exportFile(fileId: string, exportMimeType: string): Promise<Response>;
  createMultipartFile(metadata: Record<string, unknown>, content: Uint8Array, mimeType: string): Promise<unknown>;
  deleteFile(fileId: string): Promise<{ ok: true }>;
}

export function createGoogleDriveClient(accessToken: string, fetchImpl: typeof fetch): GoogleDriveClient {
  return {
    async listFiles(params) {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: buildDriveHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async getFile(fileId, params) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: buildDriveHeaders(accessToken),
      });
      return expectGoogleJson(response);
    },
    async downloadFile(fileId, params, headers) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      const response = await fetchImpl(url.toString(), {
        headers: {
          ...buildDriveHeaders(accessToken),
          ...(headers ?? {}),
        },
      });
      if (!response.ok) {
        await expectGoogleJson(response.clone());
      }
      return response;
    },
    async exportFile(fileId, exportMimeType) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
      url.searchParams.set('mimeType', exportMimeType);
      const response = await fetchImpl(url.toString(), {
        headers: buildDriveHeaders(accessToken),
      });
      if (!response.ok) {
        await expectGoogleJson(response.clone());
      }
      return response;
    },
    async createMultipartFile(metadata, content, mimeType) {
      const boundary = `drive-upload-${crypto.randomUUID()}`;
      const preamble = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
      const closing = `\r\n--${boundary}--`;
      const body = new Blob([preamble, content.slice().buffer, closing]);
      const url = new URL('https://www.googleapis.com/upload/drive/v3/files');
      url.searchParams.set('uploadType', 'multipart');
      url.searchParams.set('supportsAllDrives', 'true');
      const response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: buildDriveHeaders(accessToken, `multipart/related; boundary=${boundary}`),
        body,
      });
      return expectGoogleJson(response);
    },
    async deleteFile(fileId) {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('supportsAllDrives', 'true');
      const response = await fetchImpl(url.toString(), {
        method: 'DELETE',
        headers: buildDriveHeaders(accessToken),
      });
      if (!response.ok && response.status !== 204) {
        await expectGoogleJson(response);
      }
      return { ok: true };
    },
  };
}
