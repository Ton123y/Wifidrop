import type { FileCategory, RoomFile } from '../types.ts';

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;

export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_REGEX.test(code);
}

export function extractRoomCodeFromInput(raw: string): string {
  const trimmed = raw.trim();
  const roomQueryMatch = trimmed.match(/[?&]room=([a-zA-Z0-9]{1,16})/i);
  if (roomQueryMatch && roomQueryMatch[1]) {
    return normalizeRoomCode(roomQueryMatch[1]);
  }
  return normalizeRoomCode(trimmed);
}

export function generateRoomCode(randomIndex?: (max: number) => number): string {
  const getIndex =
    randomIndex ??
    ((max: number) => {
      if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        const arr = new Uint32Array(1);
        globalThis.crypto.getRandomValues(arr);
        return arr[0] % max;
      }
      return Math.floor(Math.random() * max);
    });

  let result = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    result += ROOM_CODE_ALPHABET[getIndex(ROOM_CODE_ALPHABET.length)];
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const formatted = exp === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${formatted} ${units[exp]}`;
}

export function formatTimeLabel(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

export function getFileExtension(filename: string): string {
  const base = filename.trim();
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return 'FILE';
  }
  return base.slice(dotIdx + 1, dotIdx + 15).toUpperCase();
}

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'd.ts',
  'py', 'pyw', 'pyi', 'ipynb',
  'c', 'h', 'cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++',
  'cs', 'fs', 'fsx', 'fsi', 'vb', 'vbs', 'csproj', 'vbproj', 'vcxproj', 'sln',
  'java', 'kt', 'kts', 'groovy', 'gradle', 'scala', 'clj', 'cljs', 'cljc',
  'go', 'mod', 'sum', 'rs', 'toml',
  'php', 'rb', 'erb', 'rake', 'gemspec',
  'swift', 'm', 'mm', 'pbxproj', 'storyboard', 'xib',
  'dart', 'lua', 'r', 'rmd', 'jl', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl',
  'hs', 'lhs', 'elm', 'zig', 'nim', 'v', 'sv', 'vhd', 'vhdl', 'asm', 's',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'xml', 'plist', 'ini', 'cfg', 'conf',
  'env', 'properties', 'sql', 'sqlite', 'db', 'prisma', 'graphql', 'gql', 'proto',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'tf', 'tfvars', 'hcl', 'bicep', 'nix', 'cmake', 'dockerfile', 'lock', 'wasm', 'wat',
  'sol', 'move', 'cairo', 'f90', 'f95', 'pas',
]);

const CODE_FILENAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'cmakelists.txt',
  'gemfile', 'rakefile', 'podfile', 'procfile', 'vagrantfile', 'jenkinsfile',
  'gradlew', 'mvnw', 'package.json', 'package-lock.json', 'tsconfig.json',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'requirements.txt',
  'pyproject.toml', 'pipfile', 'pubspec.yaml', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig',
  '.eslintrc', '.prettierrc', '.babelrc', '.npmrc', '.nvmrc', '.python-version',
  '.htaccess',
]);

export function classifyFileCategory(mimeType: string, filename: string): FileCategory {
  const mime = (mimeType || '').toLowerCase();
  const trimmedName = filename.trim();
  const lowerName = trimmedName.toLowerCase();
  const ext = getFileExtension(filename).toLowerCase();

  if (
    mime.startsWith('image/') ||
    ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng'].includes(ext)
  ) {
    return 'images';
  }
  if (
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    ['mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp', 'ts', 'mts', 'm2ts', 'vob', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'opus', 'aiff', 'alac', 'amr', 'mid', 'midi'].includes(ext)
  ) {
    return 'media';
  }
  if (
    mime.includes('zip') ||
    mime.includes('rar') ||
    mime.includes('tar') ||
    mime.includes('7z') ||
    mime.includes('gzip') ||
    mime.includes('bzip') ||
    mime.includes('xz') ||
    mime.includes('zstd') ||
    mime.includes('iso9660') ||
    lowerName.endsWith('.tar.gz') ||
    lowerName.endsWith('.tar.bz2') ||
    lowerName.endsWith('.tar.xz') ||
    lowerName.endsWith('.tar.zst') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz4', 'cab', 'iso', 'dmg'].includes(ext)
  ) {
    return 'archives';
  }
  if (
    CODE_FILENAMES.has(lowerName) ||
    lowerName.startsWith('.env') ||
    lowerName.startsWith('dockerfile.') ||
    CODE_EXTENSIONS.has(ext) ||
    mime.includes('javascript') ||
    mime.includes('typescript') ||
    mime.includes('ecmascript') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('x-python') ||
    mime.includes('x-sh') ||
    mime.includes('x-c') ||
    mime.includes('x-java')
  ) {
    return 'code';
  }
  if (
    mime.includes('pdf') ||
    mime.includes('word') ||
    mime.includes('document') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    mime.includes('epub') ||
    mime.startsWith('text/') ||
    [
      'pdf', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp',
      'pages', 'numbers', 'key', 'epub', 'mobi', 'txt', 'csv', 'tsv', 'md', 'mdx',
      'log', 'srt', 'vtt',
    ].includes(ext)
  ) {
    return 'documents';
  }
  return 'other';
}

export function sanitizeDisplayFilename(filename: string): string {
  const stripped = filename.replace(/[/\\?%*:|"<>]/g, '_').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!stripped || stripped === '.' || stripped === '..') {
    return 'unnamed-file';
  }
  return stripped.slice(0, 180);
}

export function sanitizeRelativePath(rawPath: string): string {
  const segments = rawPath
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map((part) => sanitizeDisplayFilename(part));

  if (segments.length === 0) {
    return 'unnamed-file';
  }
  return segments.join('/').slice(0, 1024);
}

export function getFolderNameFromPath(relativePath?: string): string | null {
  if (!relativePath) return null;
  const idx = relativePath.indexOf('/');
  if (idx <= 0) return null;
  return relativePath.slice(0, idx);
}

export function getDisplaySubpath(file: RoomFile): string {
  if (!file.relativePath) return file.name;
  const idx = file.relativePath.indexOf('/');
  if (idx <= 0) return file.relativePath;
  return file.relativePath.slice(idx + 1) || file.name;
}

export function upsertRoomFile(files: RoomFile[], incoming: RoomFile): RoomFile[] {
  const existingIdx = files.findIndex((item) => item.id === incoming.id);
  if (existingIdx !== -1) {
    const next = [...files];
    next[existingIdx] = incoming;
    return next;
  }
  return [incoming, ...files];
}

export function upsertRoomFiles(files: RoomFile[], incomingList: RoomFile[]): RoomFile[] {
  if (incomingList.length === 0) return files;
  const next = [...files];
  const indexMap = new Map<string, number>();
  for (let i = 0; i < next.length; i += 1) {
    indexMap.set(next[i].id, i);
  }
  const prepends: RoomFile[] = [];
  for (const incoming of incomingList) {
    const existingIdx = indexMap.get(incoming.id);
    if (existingIdx !== undefined) {
      next[existingIdx] = incoming;
    } else {
      indexMap.set(incoming.id, -1);
      prepends.push(incoming);
    }
  }
  if (prepends.length === 0) return next;
  return [...prepends.reverse(), ...next];
}

export function removeRoomFile(files: RoomFile[], fileId: string): RoomFile[] {
  return files.filter((item) => item.id !== fileId);
}

export function removeRoomFiles(files: RoomFile[], fileIds: string[]): RoomFile[] {
  const idSet = new Set(fileIds);
  return files.filter((item) => !idSet.has(item.id));
}

export function filterRoomFiles(
  files: RoomFile[],
  query: string,
  category: 'all' | FileCategory
): RoomFile[] {
  const q = query.trim().toLowerCase();
  return files.filter((file) => {
    if (category !== 'all' && file.category !== category) {
      return false;
    }
    if (!q) {
      return true;
    }
    return (
      file.name.toLowerCase().includes(q) ||
      (file.relativePath ? file.relativePath.toLowerCase().includes(q) : false) ||
      file.senderDeviceName.toLowerCase().includes(q) ||
      getFileExtension(file.name).toLowerCase().includes(q)
    );
  });
}

export type RoomDisplayEntry =
  | {
      kind: 'folder';
      batchId: string;
      folderName: string;
      files: RoomFile[];
      totalSize: number;
      senderDeviceId: string;
      senderDeviceName: string;
      uploadedAt: number;
      isDirectP2P: boolean;
    }
  | {
      kind: 'file';
      file: RoomFile;
    };

export function groupRoomEntries(files: RoomFile[]): RoomDisplayEntry[] {
  const entries: RoomDisplayEntry[] = [];
  const folderMap = new Map<string, Extract<RoomDisplayEntry, { kind: 'folder' }>>();

  for (const file of files) {
    const folderName = getFolderNameFromPath(file.relativePath);
    if (file.folderBatchId && folderName) {
      let group = folderMap.get(file.folderBatchId);
      if (!group) {
        group = {
          kind: 'folder',
          batchId: file.folderBatchId,
          folderName,
          files: [],
          totalSize: 0,
          senderDeviceId: file.senderDeviceId,
          senderDeviceName: file.senderDeviceName,
          uploadedAt: file.uploadedAt,
          isDirectP2P: Boolean(file.isDirectP2P),
        };
        folderMap.set(file.folderBatchId, group);
        entries.push(group);
      }
      group.files.push(file);
      group.totalSize += file.size;
      if (file.uploadedAt > group.uploadedAt) {
        group.uploadedAt = file.uploadedAt;
      }
      if (!file.isDirectP2P) {
        group.isDirectP2P = false;
      }
    } else {
      entries.push({ kind: 'file', file });
    }
  }

  for (const entry of entries) {
    if (entry.kind === 'folder') {
      entry.files.sort((a, b) =>
        (a.relativePath || a.name).localeCompare(b.relativePath || b.name)
      );
    }
  }

  return entries;
}

export function detectDefaultDeviceName(userAgent: string): string {
  const ua = userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'جهاز أندرويد';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'كمبيوتر Windows';
  if (/Linux/i.test(ua)) return 'جهاز Linux';
  return 'جهاز متصل';
}

export function isPreviewableImageMime(mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase();
  return (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/jpg' ||
    mime === 'image/webp' ||
    mime === 'image/gif' ||
    mime === 'image/avif'
  );
}

export const WS_UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1 MB default WS binary frame
export const WS_LARGE_UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB WS frame for large 100 MB+ files
export const WS_FAST_UPLOAD_MAX_BYTES = 512 * 1024; // 512 KB single-frame 1-RTT upload threshold
export const HTTP_FALLBACK_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB HTTP fallback chunk
export const DEFAULT_UPLOAD_CHUNK_SIZE = HTTP_FALLBACK_CHUNK_SIZE;
export const P2P_RTC_CHUNK_SIZE = 128 * 1024; // 128 KB per WebRTC DataChannel message

export function selectWsChunkSize(fileSize: number): number {
  return fileSize >= 100 * 1024 * 1024 ? WS_LARGE_UPLOAD_CHUNK_SIZE : WS_UPLOAD_CHUNK_SIZE;
}

export function calculateChunkCount(fileSize: number, chunkSize = WS_UPLOAD_CHUNK_SIZE): number {
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(fileSize / chunkSize));
}

export function getChunkByteRange(
  fileSize: number,
  chunkIndex: number,
  chunkSize = WS_UPLOAD_CHUNK_SIZE
): { start: number; end: number } {
  if (fileSize <= 0) {
    return { start: 0, end: 0 };
  }
  const start = chunkIndex * chunkSize;
  const end = Math.min(fileSize, start + chunkSize);
  return { start, end };
}

export interface WsChunkHeader {
  uploadId: string;
  chunkIndex: number;
}

export interface WsFastUploadHeader {
  mode: 'fast';
  clientUploadId: string;
  fileName: string;
  relativePath?: string;
  folderBatchId?: string;
  fileSize: number;
  mimeType: string;
  deviceId: string;
  deviceName: string;
}

export type WsDecodedBinaryFrame =
  | { kind: 'chunk'; header: WsChunkHeader; payload: Uint8Array }
  | { kind: 'fast'; header: WsFastUploadHeader; payload: Uint8Array };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeWsChunkFrame(
  header: WsChunkHeader,
  payload: Uint8Array
): Uint8Array<ArrayBuffer> {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + headerBytes.byteLength + payload.byteLength);
  const frame = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.byteLength);
  return frame;
}

export function encodeWsFastUploadFrame(
  header: Omit<WsFastUploadHeader, 'mode'>,
  payload: Uint8Array
): Uint8Array<ArrayBuffer> {
  const payloadHeader: WsFastUploadHeader = { mode: 'fast', ...header };
  const headerBytes = textEncoder.encode(JSON.stringify(payloadHeader));
  const buffer = new ArrayBuffer(4 + headerBytes.byteLength + payload.byteLength);
  const frame = new Uint8Array(buffer);
  const view = new DataView(buffer);
  view.setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.byteLength);
  return frame;
}

export function decodeWsBinaryFrame(raw: Uint8Array): WsDecodedBinaryFrame | null {
  if (raw.byteLength < 4) {
    return null;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen <= 0 || headerLen > 8192 || 4 + headerLen > raw.byteLength) {
    return null;
  }
  try {
    const headerSlice = raw.subarray(4, 4 + headerLen);
    const parsed = JSON.parse(textDecoder.decode(headerSlice)) as Record<string, unknown>;
    const payload = raw.subarray(4 + headerLen);

    if (parsed.mode === 'fast') {
      if (
        typeof parsed.clientUploadId !== 'string' ||
        !parsed.clientUploadId ||
        typeof parsed.fileName !== 'string' ||
        typeof parsed.fileSize !== 'number' ||
        !Number.isFinite(parsed.fileSize) ||
        parsed.fileSize < 0
      ) {
        return null;
      }
      return {
        kind: 'fast',
        header: {
          mode: 'fast',
          clientUploadId: parsed.clientUploadId,
          fileName: parsed.fileName,
          ...(typeof parsed.relativePath === 'string' && parsed.relativePath
            ? { relativePath: parsed.relativePath }
            : {}),
          ...(typeof parsed.folderBatchId === 'string' && parsed.folderBatchId
            ? { folderBatchId: parsed.folderBatchId }
            : {}),
          fileSize: parsed.fileSize,
          mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
          deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : 'anonymous-device',
          deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : 'جهاز متصل',
        },
        payload,
      };
    }

    if (
      typeof parsed.uploadId !== 'string' ||
      !parsed.uploadId ||
      typeof parsed.chunkIndex !== 'number' ||
      !Number.isInteger(parsed.chunkIndex) ||
      parsed.chunkIndex < 0
    ) {
      return null;
    }
    return {
      kind: 'chunk',
      header: { uploadId: parsed.uploadId, chunkIndex: parsed.chunkIndex },
      payload,
    };
  } catch {
    return null;
  }
}

export function decodeWsChunkFrame(
  raw: Uint8Array
): { header: WsChunkHeader; payload: Uint8Array } | null {
  const decoded = decodeWsBinaryFrame(raw);
  if (!decoded || decoded.kind !== 'chunk') {
    return null;
  }
  return { header: decoded.header, payload: decoded.payload };
}
