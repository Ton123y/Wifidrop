import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  RoomFile,
  RoomPeer,
  RoomSnapshot,
  WsClientMessage,
  WsServerMessage,
} from './src/types.ts';
import {
  classifyFileCategory,
  decodeWsBinaryFrame,
  formatBytes,
  generateRoomCode,
  getFolderNameFromPath,
  isPreviewableImageMime,
  isValidRoomCode,
  normalizeRoomCode,
  sanitizeDisplayFilename,
  sanitizeRelativePath,
  WS_FAST_UPLOAD_MAX_BYTES,
  type WsFastUploadHeader,
} from './src/utils/roomLogic.ts';
import { streamZipArchive, type ZipSourceEntry } from './src/utils/zipStream.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB per file
const MAX_FILES_PER_UPLOAD = 500;
const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours when empty
const UPLOAD_ROOT = path.resolve(os.tmpdir(), 'wifidrop-uploads');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

interface StoredRoomFile extends RoomFile {
  storagePath: string;
}

interface RoomPeerState extends RoomPeer {
  connectionCount: number;
}

interface RoomClientSocket extends WebSocket {
  isAlive?: boolean;
  roomCode?: string;
  deviceId?: string;
}

interface RoomRecord {
  code: string;
  roomName: string;
  createdAt: number;
  lastActivityAt: number;
  files: Map<string, StoredRoomFile>;
  peers: Map<string, RoomPeerState>;
  sockets: Set<RoomClientSocket>;
}

const rooms = new Map<string, RoomRecord>();

function getSafeRoomDir(code: string): string | null {
  if (!isValidRoomCode(code)) {
    return null;
  }
  const resolved = path.resolve(UPLOAD_ROOT, code);
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

function getSafeFilePath(roomDir: string, fileId: string): string | null {
  if (!UUID_REGEX.test(fileId)) {
    return null;
  }
  const resolved = path.resolve(roomDir, fileId);
  if (!resolved.startsWith(roomDir + path.sep)) {
    return null;
  }
  return resolved;
}

function toPublicFile(file: StoredRoomFile): RoomFile {
  const { storagePath: _unused, ...publicFields } = file;
  return publicFields;
}

function toPublicPeers(room: RoomRecord): RoomPeer[] {
  return Array.from(room.peers.values())
    .map(({ connectionCount: _unused, ...peer }) => peer)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function toRoomSnapshot(room: RoomRecord): RoomSnapshot {
  const files = Array.from(room.files.values())
    .map(toPublicFile)
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  return {
    code: room.code,
    roomName: room.roomName,
    createdAt: room.createdAt,
    files,
    peers: toPublicPeers(room),
  };
}

function sendWs(ws: WebSocket, payload: WsServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(room: RoomRecord, payload: WsServerMessage): void {
  const serialized = JSON.stringify(payload);
  for (const client of room.sockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function sanitizeShortText(raw: unknown, maxLength: number, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLength);
}

function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function createUniqueRoomCode(): string {
  for (let i = 0; i < 32; i += 1) {
    const code = generateRoomCode((max) => crypto.randomInt(0, max));
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error('Could not allocate unique room code');
}

function cleanupRoom(code: string): void {
  const pendingTimer = manifestTimers.get(code);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    manifestTimers.delete(code);
  }
  ensuredRoomDirs.delete(code);
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  const roomDir = getSafeRoomDir(code);
  if (roomDir) {
    fs.rm(roomDir, { recursive: true, force: true }, () => {});
  }
}

function sanitizeFolderBatchId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.trim();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

interface PendingUpload {
  id: string;
  roomCode: string;
  fileName: string;
  relativePath?: string;
  folderBatchId?: string;
  fileSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  stagingPath: string;
  fileHandle?: fs.promises.FileHandle;
  openingPromise?: Promise<fs.promises.FileHandle>;
  senderDeviceId: string;
  senderDeviceName: string;
  createdAt: number;
  lastActivityAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();
const manifestTimers = new Map<string, NodeJS.Timeout>();
const ensuredRoomDirs = new Set<string>();
const MAX_CHUNK_SIZE_BYTES = 16 * 1024 * 1024; // Max 16 MB per chunk request

async function ensureRoomDir(roomDir: string, code: string): Promise<void> {
  if (ensuredRoomDirs.has(code)) return;
  await fs.promises.mkdir(roomDir, { recursive: true });
  ensuredRoomDirs.add(code);
}

function getAvailableDiskBytes(): number | null {
  try {
    const stat = fs.statfsSync(UPLOAD_ROOT);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function saveRoomManifest(room: RoomRecord): void {
  const roomDir = getSafeRoomDir(room.code);
  if (!roomDir) return;
  try {
    fs.mkdirSync(roomDir, { recursive: true });
    const manifestPath = path.resolve(roomDir, 'room.json');
    if (!manifestPath.startsWith(roomDir + path.sep)) return;
    const payload = {
      code: room.code,
      roomName: room.roomName,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      files: Array.from(room.files.values()).map(toPublicFile),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(payload));
  } catch {
    // ignore manifest write errors
  }
}

function scheduleSaveRoomManifest(room: RoomRecord): void {
  const existing = manifestTimers.get(room.code);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    manifestTimers.delete(room.code);
    const current = rooms.get(room.code);
    if (current) {
      saveRoomManifest(current);
    }
  }, 250);
  manifestTimers.set(room.code, timer);
}

function flushAllRoomManifests(): void {
  for (const [code, timer] of manifestTimers.entries()) {
    clearTimeout(timer);
    manifestTimers.delete(code);
    const room = rooms.get(code);
    if (room) {
      saveRoomManifest(room);
    }
  }
}

function loadRoomsFromDisk(): void {
  try {
    const entries = fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRoomCode(entry.name)) continue;
      const roomDir = getSafeRoomDir(entry.name);
      if (!roomDir) continue;
      const manifestPath = path.resolve(roomDir, 'room.json');
      if (!manifestPath.startsWith(roomDir + path.sep) || !fs.existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          code?: string;
          roomName?: string;
          createdAt?: number;
          lastActivityAt?: number;
          files?: RoomFile[];
        };
        if (!raw.code || !isValidRoomCode(raw.code)) continue;
        const filesMap = new Map<string, StoredRoomFile>();
        for (const f of raw.files || []) {
          const safeFile = getSafeFilePath(roomDir, f.id);
          if (safeFile && fs.existsSync(safeFile)) {
            filesMap.set(f.id, { ...f, storagePath: safeFile });
          }
        }
        rooms.set(raw.code, {
          code: raw.code,
          roomName: sanitizeShortText(raw.roomName, 48, `غرفة ${raw.code}`),
          createdAt: Number(raw.createdAt) || Date.now(),
          lastActivityAt: Number(raw.lastActivityAt) || Date.now(),
          files: filesMap,
          peers: new Map(),
          sockets: new Set(),
        });
      } catch {
        // skip corrupted manifest
      }
    }
  } catch {
    // ignore startup restore errors
  }
}

function getLocalIpv4Urls(port: number): string[] {
  const interfaces = os.networkInterfaces();
  const urls: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (
        entry.family === 'IPv4' &&
        !entry.internal &&
        !entry.address.startsWith('169.254.')
      ) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

// Configure Multer disk storage to a quarantine staging directory first,
// then move or store directly inside validated room directory.
const stagingDir = path.resolve(UPLOAD_ROOT, '_staging');
fs.mkdirSync(stagingDir, { recursive: true });
loadRoomsFromDisk();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, stagingDir);
    },
    filename: (_req, _file, cb) => {
      cb(null, crypto.randomUUID());
    },
  }),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_UPLOAD,
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, activeRooms: rooms.size });
});

app.get('/api/network-info', (_req, res) => {
  res.json({
    localUrls: getLocalIpv4Urls(PORT),
  });
});

app.post('/api/rooms', (req, res) => {
  const code = createUniqueRoomCode();
  const roomDir = getSafeRoomDir(code);
  if (!roomDir) {
    res.status(500).json({ error: 'تعذر إنشاء مجلد الغرفة.' });
    return;
  }
  fs.mkdirSync(roomDir, { recursive: true });

  const roomName = sanitizeShortText(req.body?.roomName, 48, `غرفة ${code}`);
  const now = Date.now();
  const room: RoomRecord = {
    code,
    roomName,
    createdAt: now,
    lastActivityAt: now,
    files: new Map(),
    peers: new Map(),
    sockets: new Set(),
  };

  rooms.set(code, room);
  saveRoomManifest(room);
  res.status(201).json(toRoomSnapshot(room));
});

app.get('/api/rooms/:code', (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  if (!isValidRoomCode(code)) {
    res.status(400).json({ error: 'رمز الغرفة يجب أن يتكون من 6 أحرف أو أرقام.' });
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    res.status(404).json({ error: 'الغرفة غير موجودة أو انتهت صلاحيتها.' });
    return;
  }
  room.lastActivityAt = Date.now();
  res.json(toRoomSnapshot(room));
});

app.post('/api/rooms/:code/files', (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!room || !roomDir) {
    res.status(404).json({ error: 'الغرفة غير موجودة.' });
    return;
  }

  upload.array('files', MAX_FILES_PER_UPLOAD)(req, res, (err: unknown) => {
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];

    const discardStaged = () => {
      for (const f of uploadedFiles) {
        fs.unlink(f.path, () => {});
      }
    };

    if (err) {
      discardStaged();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'حجم الملف يتجاوز الحد الأقصى المسموح به (100 GB).' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: 'يمكن رفع 500 ملف بحد أقصى في المرة الواحدة.' });
          return;
        }
      }
      res.status(400).json({ error: 'تعذر رفع الملفات. حاول مرة أخرى.' });
      return;
    }

    if (uploadedFiles.length === 0) {
      res.status(400).json({ error: 'لم يتم اختيار أي ملفات للرفع.' });
      return;
    }

    const senderDeviceId = sanitizeDeviceId(req.body?.deviceId) || 'anonymous-device';
    const senderDeviceName = sanitizeShortText(req.body?.deviceName, 36, 'جهاز متصل');

    let customNames: string[] = [];
    if (typeof req.body?.filenames === 'string') {
      try {
        const parsed = JSON.parse(req.body.filenames);
        if (Array.isArray(parsed)) {
          customNames = parsed.map((entry) => (typeof entry === 'string' ? entry : ''));
        }
      } catch {
        customNames = [];
      }
    }

    fs.mkdirSync(roomDir, { recursive: true });
    const added: RoomFile[] = [];

    for (let idx = 0; idx < uploadedFiles.length; idx += 1) {
      const file = uploadedFiles[idx];
      const fileId = crypto.randomUUID();
      const targetPath = getSafeFilePath(roomDir, fileId);
      if (!targetPath) {
        fs.unlink(file.path, () => {});
        continue;
      }

      try {
        fs.renameSync(file.path, targetPath);
      } catch {
        // Fallback across filesystems if /tmp mounts differ
        fs.copyFileSync(file.path, targetPath);
        fs.unlink(file.path, () => {});
      }

      const rawName =
        customNames[idx] ||
        Buffer.from(file.originalname || 'file', 'latin1').toString('utf8');
      const displayName = sanitizeDisplayFilename(rawName);
      const mimeType = sanitizeShortText(file.mimetype, 255, 'application/octet-stream');

      const record: StoredRoomFile = {
        id: fileId,
        name: displayName,
        size: file.size,
        mimeType,
        category: classifyFileCategory(mimeType, displayName),
        senderDeviceId,
        senderDeviceName,
        uploadedAt: Date.now() + idx,
        storagePath: targetPath,
      };

      room.files.set(fileId, record);
      const publicRecord = toPublicFile(record);
      added.push(publicRecord);
      broadcastToRoom(room, { type: 'file:added', file: publicRecord });
    }

    room.lastActivityAt = Date.now();
    scheduleSaveRoomManifest(room);
    res.status(201).json({ files: added });
  });
});

interface UploadInitInput {
  fileName?: unknown;
  relativePath?: unknown;
  folderBatchId?: unknown;
  fileSize?: unknown;
  mimeType?: unknown;
  chunkSize?: unknown;
  totalChunks?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
}

async function initializePendingUpload(
  code: string,
  room: RoomRecord,
  input: UploadInitInput
): Promise<{ status: number; error?: string; uploadId?: string }> {
  const fileSize = Number(input.fileSize);
  const chunkSize = Number(input.chunkSize);
  const totalChunks = Number(input.totalChunks);

  if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_SIZE_BYTES) {
    return { status: 413, error: 'حجم الملف يتجاوز الحد الأقصى المسموح به (100 GB).' };
  }
  const availableBytes = getAvailableDiskBytes();
  if (availableBytes !== null && fileSize > availableBytes) {
    return {
      status: 507,
      error: `المساحة المتوفرة على الخادم حالياً (${formatBytes(availableBytes)}) أقل من حجم الملف المطلوب.`,
    };
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE_BYTES) {
    return { status: 400, error: 'حجم الجزء غير صالح.' };
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 1500000) {
    return { status: 400, error: 'عدد الأجزاء غير صالح.' };
  }

  const uploadId = crypto.randomUUID();
  const stagingPath = getSafeFilePath(stagingDir, uploadId);
  if (!stagingPath) {
    return { status: 500, error: 'تعذر تهيئة الرفع.' };
  }

  const fileHandle = await fs.promises.open(stagingPath, 'w+');

  const rawRelativePath =
    typeof input.relativePath === 'string' && input.relativePath.trim()
      ? sanitizeRelativePath(input.relativePath)
      : undefined;
  const folderBatchId = sanitizeFolderBatchId(input.folderBatchId);

  const pending: PendingUpload = {
    id: uploadId,
    roomCode: code,
    fileName: sanitizeDisplayFilename(String(input.fileName || 'unnamed-file')),
    relativePath: rawRelativePath,
    folderBatchId,
    fileSize,
    mimeType: sanitizeShortText(input.mimeType, 255, 'application/octet-stream'),
    chunkSize,
    totalChunks,
    receivedChunks: new Set<number>(),
    stagingPath,
    fileHandle,
    senderDeviceId: sanitizeDeviceId(input.deviceId) || 'anonymous-device',
    senderDeviceName: sanitizeShortText(input.deviceName, 36, 'جهاز متصل'),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  pendingUploads.set(uploadId, pending);
  room.lastActivityAt = Date.now();
  return { status: 201, uploadId };
}

async function getPendingHandle(pending: PendingUpload): Promise<fs.promises.FileHandle> {
  if (pending.fileHandle) {
    return pending.fileHandle;
  }
  if (!pending.openingPromise) {
    pending.openingPromise = fs.promises.open(pending.stagingPath, 'r+').then((handle) => {
      pending.fileHandle = handle;
      return handle;
    });
  }
  return pending.openingPromise;
}

async function closePendingHandle(pending: PendingUpload): Promise<void> {
  if (pending.openingPromise && !pending.fileHandle) {
    await pending.openingPromise.catch(() => {});
  }
  if (pending.fileHandle) {
    const h = pending.fileHandle;
    pending.fileHandle = undefined;
    pending.openingPromise = undefined;
    await h.close().catch(() => {});
  }
}

async function writeUploadChunk(
  pending: PendingUpload,
  chunkIndex: number,
  buffer: Buffer
): Promise<{ status: number; error?: string; received?: number }> {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= pending.totalChunks) {
    return { status: 400, error: 'رقم الجزء غير صالح.' };
  }
  if (buffer.length > pending.chunkSize) {
    return { status: 413, error: 'حجم الجزء أكبر من المتوقع.' };
  }

  try {
    if (buffer.length > 0) {
      const handle = await getPendingHandle(pending);
      const offset = chunkIndex * pending.chunkSize;
      await handle.write(buffer, 0, buffer.length, offset);
    }
    pending.receivedChunks.add(chunkIndex);
    pending.lastActivityAt = Date.now();
    const room = rooms.get(pending.roomCode);
    if (room) room.lastActivityAt = Date.now();
    return { status: 200, received: pending.receivedChunks.size };
  } catch {
    return { status: 500, error: 'تعذر حفظ جزء من الملف.' };
  }
}

async function finalizePendingUpload(
  code: string,
  uploadId: string
): Promise<{ status: number; error?: string; file?: RoomFile }> {
  const pending = pendingUploads.get(uploadId);
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!pending || pending.roomCode !== code || !room || !roomDir) {
    return { status: 404, error: 'جلسة الرفع أو الغرفة غير موجودة.' };
  }

  if (pending.receivedChunks.size !== pending.totalChunks) {
    return { status: 400, error: 'لم تكتمل جميع أجزاء الملف بعد.' };
  }

  const fileId = crypto.randomUUID();
  const targetPath = getSafeFilePath(roomDir, fileId);
  if (!targetPath) {
    return { status: 500, error: 'مسار الحفظ غير صالح.' };
  }

  await closePendingHandle(pending);
  await ensureRoomDir(roomDir, code);
  try {
    await fs.promises.rename(pending.stagingPath, targetPath);
  } catch {
    await fs.promises.copyFile(pending.stagingPath, targetPath);
    fs.unlink(pending.stagingPath, () => {});
  }
  pendingUploads.delete(uploadId);

  const actualSize = (await fs.promises.stat(targetPath)).size;
  const record: StoredRoomFile = {
    id: fileId,
    name: pending.fileName,
    ...(pending.relativePath ? { relativePath: pending.relativePath } : {}),
    ...(pending.folderBatchId ? { folderBatchId: pending.folderBatchId } : {}),
    size: actualSize,
    mimeType: pending.mimeType,
    category: classifyFileCategory(pending.mimeType, pending.fileName),
    senderDeviceId: pending.senderDeviceId,
    senderDeviceName: pending.senderDeviceName,
    uploadedAt: Date.now(),
    storagePath: targetPath,
  };

  room.files.set(fileId, record);
  room.lastActivityAt = Date.now();
  scheduleSaveRoomManifest(room);

  const publicRecord = toPublicFile(record);
  broadcastToRoom(room, { type: 'file:added', file: publicRecord });
  return { status: 201, file: publicRecord };
}

async function handleFastBinaryUpload(
  ws: RoomClientSocket,
  header: WsFastUploadHeader,
  payloadBuffer: Buffer
): Promise<void> {
  const code = ws.roomCode;
  if (!code) {
    sendWs(ws, {
      type: 'upload:error',
      clientUploadId: header.clientUploadId,
      message: 'يرجى الانضمام إلى الغرفة قبل إرسال الملفات.',
    });
    return;
  }

  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);
  if (!room || !roomDir) {
    sendWs(ws, {
      type: 'upload:error',
      clientUploadId: header.clientUploadId,
      message: 'الغرفة غير موجودة.',
    });
    return;
  }

  if (payloadBuffer.byteLength > WS_FAST_UPLOAD_MAX_BYTES) {
    sendWs(ws, {
      type: 'upload:error',
      clientUploadId: header.clientUploadId,
      message: 'حجم الملف يتجاوز حد الإرسال السريع.',
    });
    return;
  }

  const fileId = crypto.randomUUID();
  const targetPath = getSafeFilePath(roomDir, fileId);
  if (!targetPath) {
    sendWs(ws, {
      type: 'upload:error',
      clientUploadId: header.clientUploadId,
      message: 'مسار الحفظ غير صالح.',
    });
    return;
  }

  await ensureRoomDir(roomDir, code);
  await fs.promises.writeFile(targetPath, payloadBuffer);

  const displayName = sanitizeDisplayFilename(header.fileName || 'unnamed-file');
  const relativePath = header.relativePath
    ? sanitizeRelativePath(header.relativePath)
    : undefined;
  const folderBatchId = sanitizeFolderBatchId(header.folderBatchId);
  const mimeType = sanitizeShortText(header.mimeType, 255, 'application/octet-stream');

  const record: StoredRoomFile = {
    id: fileId,
    name: displayName,
    ...(relativePath ? { relativePath } : {}),
    ...(folderBatchId ? { folderBatchId } : {}),
    size: payloadBuffer.byteLength,
    mimeType,
    category: classifyFileCategory(mimeType, displayName),
    senderDeviceId: sanitizeDeviceId(header.deviceId) || 'anonymous-device',
    senderDeviceName: sanitizeShortText(header.deviceName, 36, 'جهاز متصل'),
    uploadedAt: Date.now(),
    storagePath: targetPath,
  };

  room.files.set(fileId, record);
  room.lastActivityAt = Date.now();
  scheduleSaveRoomManifest(room);

  const publicRecord = toPublicFile(record);
  sendWs(ws, {
    type: 'upload:fast-done',
    clientUploadId: header.clientUploadId,
    file: publicRecord,
  });
  broadcastToRoom(room, { type: 'file:added', file: publicRecord });
}

async function abortPendingUpload(code: string, uploadId: string): Promise<boolean> {
  const pending = pendingUploads.get(uploadId);
  if (!pending || pending.roomCode !== code) {
    return false;
  }
  pendingUploads.delete(uploadId);
  await closePendingHandle(pending);
  fs.unlink(pending.stagingPath, () => {});
  return true;
}

// Chunked upload protocol (supports both WebSocket binary streaming & HTTP chunk fallback)
app.post('/api/rooms/:code/uploads/init', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);
  if (!room || !roomDir) {
    res.status(404).json({ error: 'الغرفة غير موجودة أو انتهت صلاحيتها.' });
    return;
  }

  const result = await initializePendingUpload(code, room, req.body || {});
  if (result.error || !result.uploadId) {
    res.status(result.status).json({ error: result.error || 'تعذر تهيئة الرفع.' });
    return;
  }
  res.status(201).json({ uploadId: result.uploadId });
});

app.get('/api/rooms/:code/uploads/:uploadId/status', (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const uploadId = req.params.uploadId || '';
  const pending = pendingUploads.get(uploadId);
  if (!pending || pending.roomCode !== code) {
    res.status(404).json({ error: 'جلسة الرفع غير موجودة.' });
    return;
  }
  res.json({
    receivedChunks: Array.from(pending.receivedChunks),
    totalChunks: pending.totalChunks,
  });
});

app.post(
  '/api/rooms/:code/uploads/:uploadId/chunk',
  express.raw({ type: 'application/octet-stream', limit: '16mb' }),
  async (req, res) => {
    const code = normalizeRoomCode(req.params.code || '');
    const uploadId = req.params.uploadId || '';
    const chunkIndex = Number(req.query.index);

    const pending = pendingUploads.get(uploadId);
    if (!pending || pending.roomCode !== code) {
      res.status(404).json({ error: 'جلسة الرفع غير موجودة أو انتهت.' });
      return;
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const writeResult = await writeUploadChunk(pending, chunkIndex, buffer);
    if (writeResult.error) {
      res.status(writeResult.status).json({ error: writeResult.error });
      return;
    }

    res.json({
      received: writeResult.received,
      totalChunks: pending.totalChunks,
    });
  }
);

app.post('/api/rooms/:code/uploads/:uploadId/complete', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const uploadId = req.params.uploadId || '';
  const result = await finalizePendingUpload(code, uploadId);
  if (result.error || !result.file) {
    res.status(result.status).json({ error: result.error || 'تعذر إتمام حفظ الملف.' });
    return;
  }
  res.status(201).json({ file: result.file });
});

app.delete('/api/rooms/:code/uploads/:uploadId', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const uploadId = req.params.uploadId || '';
  await abortPendingUpload(code, uploadId);
  res.json({ ok: true });
});

app.get('/api/rooms/:code/files/:fileId/download', (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const fileId = req.params.fileId || '';
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!room || !roomDir) {
    res.status(404).json({ error: 'الغرفة غير موجودة.' });
    return;
  }

  const safePath = getSafeFilePath(roomDir, fileId);
  const record = room.files.get(fileId);
  if (!safePath || !record || record.storagePath !== safePath || !fs.existsSync(safePath)) {
    res.status(404).json({ error: 'الملف غير موجود أو تم حذفه.' });
    return;
  }

  room.lastActivityAt = Date.now();
  const isInlineRequested = req.query.inline === '1';
  const allowInline = isInlineRequested && isPreviewableImageMime(record.mimeType);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const asciiFallback = record.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_') || 'download';

  if (allowInline) {
    res.setHeader('Content-Type', record.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(record.name)}`
    );
  } else {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(record.name)}`
    );
  }

  res.sendFile(safePath, { dotfiles: 'allow', cacheControl: false });
});

app.delete('/api/rooms/:code/files/:fileId', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const fileId = req.params.fileId || '';
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!room || !roomDir) {
    res.status(404).json({ error: 'الغرفة غير موجودة.' });
    return;
  }

  const safePath = getSafeFilePath(roomDir, fileId);
  const record = room.files.get(fileId);
  if (!safePath || !record) {
    res.status(404).json({ error: 'الملف غير موجود.' });
    return;
  }

  room.files.delete(fileId);
  room.lastActivityAt = Date.now();
  scheduleSaveRoomManifest(room);
  await fs.promises.unlink(safePath).catch(() => {});
  broadcastToRoom(room, { type: 'file:removed', fileId });
  res.json({ ok: true, fileId });
});

app.get('/api/rooms/:code/folders/:batchId/download', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const batchId = sanitizeFolderBatchId(req.params.batchId);
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!room || !roomDir || !batchId) {
    res.status(404).json({ error: 'المجلد أو الغرفة غير موجودة.' });
    return;
  }

  const matchingFiles = Array.from(room.files.values()).filter(
    (f) => f.folderBatchId === batchId && fs.existsSync(f.storagePath)
  );
  if (matchingFiles.length === 0) {
    res.status(404).json({ error: 'المجلد فارغ أو تم حذفه.' });
    return;
  }

  const firstFolderName =
    getFolderNameFromPath(matchingFiles[0].relativePath) || 'folder';
  const zipFilename = sanitizeDisplayFilename(`${firstFolderName}.zip`);
  const asciiFallback =
    zipFilename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'folder.zip';

  const entries: ZipSourceEntry[] = matchingFiles.map((f) => ({
    archivePath: f.relativePath || `${firstFolderName}/${f.name}`,
    filePath: f.storagePath,
    size: f.size,
    mtimeMs: f.uploadedAt,
  }));

  room.lastActivityAt = Date.now();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(zipFilename)}`
  );

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.on('close', onClose);
  res.on('close', onClose);

  try {
    await streamZipArchive(entries, res, abortController.signal);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ error: 'تعذر تجهيز ملف ZIP للمجلد.' });
    } else if (!res.destroyed) {
      res.destroy();
    }
  } finally {
    req.off('close', onClose);
    res.off('close', onClose);
  }
});

app.delete('/api/rooms/:code/folders/:batchId', async (req, res) => {
  const code = normalizeRoomCode(req.params.code || '');
  const batchId = sanitizeFolderBatchId(req.params.batchId);
  const room = rooms.get(code);
  const roomDir = getSafeRoomDir(code);

  if (!room || !roomDir || !batchId) {
    res.status(404).json({ error: 'المجلد أو الغرفة غير موجودة.' });
    return;
  }

  const removedIds: string[] = [];
  const unlinkPromises: Promise<void>[] = [];

  for (const [fileId, record] of room.files.entries()) {
    if (record.folderBatchId === batchId) {
      removedIds.push(fileId);
      room.files.delete(fileId);
      const safePath = getSafeFilePath(roomDir, fileId);
      if (safePath) {
        unlinkPromises.push(fs.promises.unlink(safePath).catch(() => {}));
      }
    }
  }

  if (removedIds.length === 0) {
    res.status(404).json({ error: 'المجلد غير موجود.' });
    return;
  }

  room.lastActivityAt = Date.now();
  scheduleSaveRoomManifest(room);
  await Promise.all(unlinkPromises);
  broadcastToRoom(room, { type: 'files:removed', fileIds: removedIds });
  res.json({ ok: true, fileIds: removedIds });
});

const server = http.createServer(app);
server.requestTimeout = 0; // Allow large file transfers over slower Wi-Fi without premature timeout
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: false,
  maxPayload: 16 * 1024 * 1024,
});

function detachSocketFromRoom(ws: RoomClientSocket): void {
  const { roomCode, deviceId } = ws;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  ws.roomCode = undefined;
  if (!room) return;

  room.sockets.delete(ws);
  if (deviceId) {
    const peer = room.peers.get(deviceId);
    if (peer) {
      peer.connectionCount -= 1;
      if (peer.connectionCount <= 0) {
        room.peers.delete(deviceId);
      }
    }
    broadcastToRoom(room, { type: 'peers:updated', peers: toPublicPeers(room) });
  }
}

wss.on('connection', (ws: RoomClientSocket) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (rawData, isBinary) => {
    ws.isAlive = true;

    if (isBinary) {
      if (!ws.roomCode) {
        sendWs(ws, { type: 'upload:error', message: 'يرجى الانضمام إلى الغرفة قبل إرسال الملفات.' });
        return;
      }

      const rawBuffer = Buffer.isBuffer(rawData)
        ? rawData
        : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData);
      const rawBytes = new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

      const decoded = decodeWsBinaryFrame(rawBytes);
      if (!decoded) {
        sendWs(ws, { type: 'upload:error', message: 'تنسيق جزء الملف غير صالح.' });
        return;
      }

      const payloadBuffer = Buffer.from(
        decoded.payload.buffer,
        decoded.payload.byteOffset,
        decoded.payload.byteLength
      );

      if (decoded.kind === 'fast') {
        await handleFastBinaryUpload(ws, decoded.header, payloadBuffer);
        return;
      }

      const { uploadId, chunkIndex } = decoded.header;
      const pending = pendingUploads.get(uploadId);
      if (!pending || pending.roomCode !== ws.roomCode) {
        sendWs(ws, {
          type: 'upload:error',
          uploadId,
          message: 'جلسة الرفع غير موجودة أو انتهت.',
        });
        return;
      }

      const writeResult = await writeUploadChunk(pending, chunkIndex, payloadBuffer);
      if (writeResult.error) {
        sendWs(ws, {
          type: 'upload:error',
          uploadId,
          message: writeResult.error,
        });
        return;
      }

      sendWs(ws, {
        type: 'upload:ack',
        uploadId,
        chunkIndex,
        received: writeResult.received || 0,
      });
      return;
    }

    let message: WsClientMessage;
    try {
      message = JSON.parse(rawData.toString()) as WsClientMessage;
    } catch {
      sendWs(ws, { type: 'error', message: 'رسالة غير صالحة.' });
      return;
    }

    if (message.type === 'join') {
      const code = normalizeRoomCode(message.roomCode || '');
      const room = rooms.get(code);
      if (!room) {
        sendWs(ws, { type: 'error', message: 'الغرفة غير موجودة أو انتهت صلاحيتها.' });
        return;
      }

      const deviceId = sanitizeDeviceId(message.deviceId) || crypto.randomUUID();
      const deviceName = sanitizeShortText(message.deviceName, 36, 'جهاز متصل');

      if (ws.roomCode && ws.roomCode !== code) {
        detachSocketFromRoom(ws);
      }

      const alreadyInRoom = ws.roomCode === code && ws.deviceId === deviceId;
      ws.roomCode = code;
      ws.deviceId = deviceId;
      room.sockets.add(ws);
      room.lastActivityAt = Date.now();

      const existingPeer = room.peers.get(deviceId);
      if (existingPeer) {
        existingPeer.deviceName = deviceName;
        if (!alreadyInRoom) {
          existingPeer.connectionCount += 1;
        }
      } else {
        room.peers.set(deviceId, {
          deviceId,
          deviceName,
          joinedAt: Date.now(),
          connectionCount: 1,
        });
      }

      sendWs(ws, { type: 'room:state', room: toRoomSnapshot(room) });
      broadcastToRoom(room, { type: 'peers:updated', peers: toPublicPeers(room) });
      return;
    }

    if (message.type === 'peer:rename' && ws.roomCode && ws.deviceId) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const peer = room.peers.get(ws.deviceId);
      if (!peer) return;
      peer.deviceName = sanitizeShortText(message.deviceName, 36, peer.deviceName);
      room.lastActivityAt = Date.now();
      broadcastToRoom(room, { type: 'peers:updated', peers: toPublicPeers(room) });
      return;
    }

    if (message.type === 'upload:init' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (!room) {
        sendWs(ws, {
          type: 'upload:error',
          clientUploadId: message.clientUploadId,
          message: 'الغرفة غير موجودة.',
        });
        return;
      }
      const initResult = await initializePendingUpload(ws.roomCode, room, message);
      if (initResult.error || !initResult.uploadId) {
        sendWs(ws, {
          type: 'upload:error',
          clientUploadId: message.clientUploadId,
          message: initResult.error || 'تعذر بدء رفع الملف.',
        });
        return;
      }
      sendWs(ws, {
        type: 'upload:ready',
        clientUploadId: message.clientUploadId,
        uploadId: initResult.uploadId,
      });
      return;
    }

    if (message.type === 'upload:complete' && ws.roomCode) {
      const doneResult = await finalizePendingUpload(ws.roomCode, message.uploadId);
      if (doneResult.error || !doneResult.file) {
        sendWs(ws, {
          type: 'upload:error',
          uploadId: message.uploadId,
          message: doneResult.error || 'تعذر إتمام حفظ الملف.',
        });
        return;
      }
      sendWs(ws, {
        type: 'upload:done',
        uploadId: message.uploadId,
        file: doneResult.file,
      });
      return;
    }

    if (message.type === 'upload:abort' && ws.roomCode) {
      await abortPendingUpload(ws.roomCode, message.uploadId);
      return;
    }

    if (message.type === 'rtc:signal' && ws.roomCode && ws.deviceId) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const targetId = sanitizeDeviceId(message.targetDeviceId);
      if (!targetId || targetId === ws.deviceId) return;

      for (const client of room.sockets) {
        if (client.deviceId === targetId && client.readyState === WebSocket.OPEN) {
          sendWs(client, {
            type: 'rtc:signal',
            fromDeviceId: ws.deviceId,
            signal: message.signal,
          });
        }
      }
    }
  });

  ws.on('close', () => {
    detachSocketFromRoom(ws);
  });
});

// Heartbeat & idle room cleanup intervals
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    const sock = client as RoomClientSocket;
    if (sock.isAlive === false) {
      sock.terminate();
      continue;
    }
    sock.isAlive = false;
    sock.ping();
  }
}, 25000);

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.sockets.size === 0 && now - room.lastActivityAt > ROOM_IDLE_TTL_MS) {
      cleanupRoom(code);
    }
  }
  for (const [uploadId, pending] of pendingUploads.entries()) {
    if (now - pending.lastActivityAt > 60 * 60 * 1000) {
      pendingUploads.delete(uploadId);
      void closePendingHandle(pending).then(() => {
        fs.unlink(pending.stagingPath, () => {});
      });
    }
  }
}, 5 * 60 * 1000);

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WiFiDrop server listening on http://0.0.0.0:${PORT}`);
  });
}

process.on('SIGTERM', () => {
  clearInterval(heartbeatTimer);
  clearInterval(cleanupTimer);
  flushAllRoomManifests();
  server.close();
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
