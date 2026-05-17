import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppConfig } from '../../config';
import type { GoogleDriveClient } from '../../google/drive';
import { hasScope } from '../../oauth/scopes';
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
const driveUserOutput = z.object({
  displayName: z.string().optional(),
  me: z.boolean().optional(),
}).passthrough();
const driveFileOutput = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  parents: z.array(z.string()).optional(),
  driveId: z.string().optional(),
  ownedByMe: z.boolean().optional(),
  trashed: z.boolean().optional(),
  explicitlyTrashed: z.boolean().optional(),
  webViewLink: z.string().optional(),
  webContentLink: z.string().optional(),
  iconLink: z.string().optional(),
  md5Checksum: z.string().optional(),
  sha1Checksum: z.string().optional(),
  sha256Checksum: z.string().optional(),
  capabilities: z.object({
    canDownload: z.boolean().optional(),
    canDelete: z.boolean().optional(),
    canTrash: z.boolean().optional(),
  }).passthrough().optional(),
  owners: z.array(driveUserOutput).optional(),
  lastModifyingUser: driveUserOutput.optional(),
}).passthrough();
const driveListFilesOutput = z.object({
  nextPageToken: z.string().optional(),
  incompleteSearch: z.boolean().optional(),
  files: z.array(driveFileOutput),
});
const driveDownloadFileOutput = z.object({
  file: driveFileOutput,
  contentMimeType: z.string().optional(),
  contentEncoding: z.enum(['text', 'base64']),
  bytes: z.number(),
  textContent: z.string().optional(),
  contentBase64: z.string().optional(),
}).passthrough();
const okOutput = z.object({ ok: z.literal(true) });

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
    outputSchema: z.ZodTypeAny,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
    readOnlyHint: boolean,
    destructiveHint = false,
  ) => {
    if (!hasScope(grantedScope, scope)) {
      return;
    }

    (server.registerTool as any)(name, {
      title: name,
      description,
      inputSchema,
      outputSchema,
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
  }, driveListFilesOutput, async ({ query, pageSize = 25, pageToken, orderBy, corpora = 'user', driveId, includeTrashed = false }) => {
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
  }, driveFileOutput, async ({ fileId }) => {
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
  }, driveDownloadFileOutput, async ({ fileId, exportMimeType, acknowledgeAbuse = false, encoding = 'auto', maxBytes = 1024 * 1024 }) => {
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
  }, driveFileOutput, async ({ name, mimeType, description, parentIds, textContent, contentBase64 }) => {
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

  register('drive_create_folder', 'drive.write', 'Create a Google Drive folder, optionally inside one or more parent folders.', {
    name: z.string().min(1).max(512),
    parentIds: z.array(z.string().min(1)).max(20).optional(),
  }, driveFileOutput, async ({ name, parentIds }) => {
    const response = await client.createFile({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentIds?.length ? { parents: parentIds } : {}),
    }) as any;

    return summarizeFile(response);
  }, false);

  register('drive_update_file', 'drive.write', 'Rename or move a Google Drive file or folder by patching metadata.', {
    fileId: z.string().min(1),
    name: z.string().min(1).max(512).optional(),
    addParentIds: z.array(z.string().min(1)).max(20).optional(),
    removeParentIds: z.array(z.string().min(1)).max(20).optional(),
  }, driveFileOutput, async ({ fileId, name, addParentIds, removeParentIds }) => {
    if (!name && (!addParentIds || addParentIds.length === 0) && (!removeParentIds || removeParentIds.length === 0)) {
      throw new HttpError(400, 'invalid_request', 'At least one of name, addParentIds, or removeParentIds is required');
    }

    const response = await client.updateFile(fileId, {
      ...(name ? { name } : {}),
    }, {
      ...(addParentIds?.length ? { addParents: addParentIds.join(',') } : {}),
      ...(removeParentIds?.length ? { removeParents: removeParentIds.join(',') } : {}),
      fields: DRIVE_FILE_FIELDS,
    }) as any;

    return summarizeFile(response);
  }, false);

  register('drive_delete_file', 'drive.write', 'Permanently delete a Google Drive file or folder.', {
    fileId: z.string().min(1),
  }, okOutput, async ({ fileId }) => {
    return client.deleteFile(fileId);
  }, false, true);
}
