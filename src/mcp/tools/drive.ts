import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleDriveClient } from '../../google/drive';
import { HttpError } from '../../security/errors';
import { ensureRequiredScope } from '../auth';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_TRANSFER_BYTES = 5 * 1024 * 1024;
const TEXTUAL_MIME_PREFIXES = ['text/'];
const TEXTUAL_MIME_EXACT = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/xhtml+xml',
  'application/csv',
  'image/svg+xml',
]);
const DRIVE_FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'createdTime',
  'modifiedTime',
  'parents',
  'driveId',
  'ownedByMe',
  'trashed',
  'explicitlyTrashed',
  'webViewLink',
  'webContentLink',
  'iconLink',
  'md5Checksum',
  'sha1Checksum',
  'sha256Checksum',
  'capabilities/canDownload',
  'capabilities/canDelete',
  'capabilities/canTrash',
  'owners/displayName',
  'owners/me',
  'lastModifyingUser/displayName',
  'lastModifyingUser/me',
].join(',');

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

function encodeBase64(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value.replace(/\s+/g, ''));
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    throw new HttpError(400, 'invalid_request', 'contentBase64 must be valid base64');
  }
}

function parseContentType(value: string | null): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || undefined;
}

function isTextualMimeType(mimeType?: string): boolean {
  if (!mimeType) return false;
  return TEXTUAL_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXTUAL_MIME_EXACT.has(mimeType);
}

function summarizeFile(file: any) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    parents: file.parents,
    driveId: file.driveId,
    ownedByMe: file.ownedByMe,
    trashed: file.trashed,
    explicitlyTrashed: file.explicitlyTrashed,
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink,
    iconLink: file.iconLink,
    md5Checksum: file.md5Checksum,
    sha1Checksum: file.sha1Checksum,
    sha256Checksum: file.sha256Checksum,
    capabilities: file.capabilities,
    owners: file.owners,
    lastModifyingUser: file.lastModifyingUser,
  };
}

function combineDriveQuery(userQuery: string | undefined, includeTrashed: boolean): string | undefined {
  if (includeTrashed) {
    return userQuery?.trim() || undefined;
  }

  return userQuery?.trim()
    ? `(${userQuery.trim()}) and trashed = false`
    : 'trashed = false';
}

export function registerDriveTools(
  server: McpServer,
  config: AppConfig,
  client: GoogleDriveClient,
  grantedScope: string,
): void {
  const register = <T extends z.ZodRawShape>(
    name: string,
    scope: 'drive.read' | 'drive.write',
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

  register('drive_list_files', 'drive.read', 'List and search Google Drive files and folders.', {
    query: z.string().max(1000).optional(),
    pageSize: z.number().int().min(1).max(100).default(25).optional(),
    pageToken: z.string().max(500).optional(),
    orderBy: z.string().max(200).optional(),
    corpora: z.enum(['user', 'domain', 'drive', 'allDrives']).default('user').optional(),
    driveId: z.string().optional(),
    includeTrashed: z.boolean().default(false).optional(),
  }, async ({ query, pageSize = 25, pageToken, orderBy, corpora = 'user', driveId, includeTrashed = false }) => {
    const response = await client.listFiles({
      fields: `nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`,
      pageSize: String(pageSize),
      spaces: 'drive',
      corpora,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      ...(driveId ? { driveId } : {}),
      ...(pageToken ? { pageToken } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(combineDriveQuery(query, includeTrashed) ? { q: combineDriveQuery(query, includeTrashed)! } : {}),
    }) as any;

    return {
      nextPageToken: response.nextPageToken,
      incompleteSearch: response.incompleteSearch,
      files: (response.files ?? []).map(summarizeFile),
    };
  }, true);

  register('drive_get_file', 'drive.read', 'Get Google Drive file or folder metadata by id.', {
    fileId: z.string().min(1),
  }, async ({ fileId }) => {
    const response = await client.getFile(fileId, {
      fields: DRIVE_FILE_FIELDS,
      supportsAllDrives: 'true',
    }) as any;
    return summarizeFile(response);
  }, true);

  register('drive_download_file', 'drive.read', 'Download a Google Drive file. Blob files use direct download; Google Workspace files require exportMimeType.', {
    fileId: z.string().min(1),
    exportMimeType: z.string().max(200).optional(),
    acknowledgeAbuse: z.boolean().default(false).optional(),
    encoding: z.enum(['auto', 'text', 'base64']).default('auto').optional(),
    maxBytes: z.number().int().min(1).max(MAX_TRANSFER_BYTES).default(1024 * 1024).optional(),
  }, async ({ fileId, exportMimeType, acknowledgeAbuse = false, encoding = 'auto', maxBytes = 1024 * 1024 }) => {
    const metadata = await client.getFile(fileId, {
      fields: `${DRIVE_FILE_FIELDS},exportLinks`,
      supportsAllDrives: 'true',
    }) as any;

    const file = summarizeFile(metadata);
    if (metadata.capabilities?.canDownload === false) {
      throw new HttpError(403, 'insufficient_scope', 'This file cannot be downloaded');
    }

    let bytes: Uint8Array;
    let contentMimeType: string | undefined;
    if (String(metadata.mimeType ?? '').startsWith('application/vnd.google-apps.')) {
      if (!exportMimeType) {
        throw new HttpError(400, 'invalid_request', 'exportMimeType is required for Google Workspace files');
      }
      const response = await client.exportFile(fileId, exportMimeType);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new HttpError(400, 'invalid_request', `Exported file exceeds maxBytes (${maxBytes})`);
      }
      bytes = buffer;
      contentMimeType = parseContentType(response.headers.get('content-type')) ?? exportMimeType;
    } else {
      const declaredSize = Number(metadata.size ?? 0);
      if (declaredSize > maxBytes) {
        throw new HttpError(400, 'invalid_request', `File exceeds maxBytes (${maxBytes})`);
      }
      const response = await client.downloadFile(fileId, {
        alt: 'media',
        supportsAllDrives: 'true',
        ...(acknowledgeAbuse ? { acknowledgeAbuse: 'true' } : {}),
      });
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw new HttpError(400, 'invalid_request', `Downloaded file exceeds maxBytes (${maxBytes})`);
      }
      bytes = buffer;
      contentMimeType = parseContentType(response.headers.get('content-type')) ?? metadata.mimeType;
    }

    const resolvedEncoding = encoding === 'auto'
      ? (isTextualMimeType(contentMimeType) ? 'text' : 'base64')
      : encoding;

    return {
      file,
      contentMimeType,
      contentEncoding: resolvedEncoding,
      bytes: bytes.byteLength,
      ...(resolvedEncoding === 'text'
        ? { textContent: textDecoder.decode(bytes) }
        : { contentBase64: encodeBase64(bytes) }),
    };
  }, true);

  register('drive_upload_file', 'drive.write', 'Upload a small file to Google Drive using metadata + content.', {
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    parentIds: z.array(z.string().min(1)).max(20).optional(),
    textContent: z.string().max(MAX_TRANSFER_BYTES).optional(),
    contentBase64: z.string().max(Math.ceil(MAX_TRANSFER_BYTES * 4 / 3) + 16).optional(),
  }, async ({ name, mimeType, description, parentIds, textContent, contentBase64 }) => {
    if ((textContent ? 1 : 0) + (contentBase64 ? 1 : 0) !== 1) {
      throw new HttpError(400, 'invalid_request', 'Exactly one of textContent or contentBase64 is required');
    }

    const content = textContent !== undefined ? textEncoder.encode(textContent) : decodeBase64(contentBase64!);
    if (content.byteLength > MAX_TRANSFER_BYTES) {
      throw new HttpError(400, 'invalid_request', `Upload exceeds ${MAX_TRANSFER_BYTES} bytes`);
    }

    const resolvedMimeType = mimeType ?? (textContent !== undefined ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    const response = await client.createMultipartFile({
      name,
      ...(description ? { description } : {}),
      ...(parentIds?.length ? { parents: parentIds } : {}),
    }, content, resolvedMimeType) as any;

    return summarizeFile(response);
  }, false);

  register('drive_delete_file', 'drive.write', 'Permanently delete a Google Drive file or folder.', {
    fileId: z.string().min(1),
  }, async ({ fileId }) => {
    return client.deleteFile(fileId);
  }, false, true);
}
