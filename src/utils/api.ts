import type { RoomFile, RoomSnapshot } from '../types.ts';
import {
  calculateChunkCount,
  detectDefaultDeviceName,
  getChunkByteRange,
  HTTP_FALLBACK_CHUNK_SIZE,
  selectWsChunkSize,
  WS_FAST_UPLOAD_MAX_BYTES,
} from './roomLogic.ts';

const DEVICE_ID_STORAGE_KEY = 'wifidrop_device_id';
const DEVICE_NAME_STORAGE_KEY = 'wifidrop_device_name';

export interface UploadItem {
  file: File;
  relativePath?: string;
  folderBatchId?: string;
}

export interface UploadProgressInfo {
  loaded: number;
  total: number;
  completedFiles: number;
  totalFiles: number;
  bytesPerSec: number;
}

export interface WsUploadTransport {
  isReady: () => boolean;
  getBufferedAmount: () => number;
  waitUntilReady: (timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;
  initUpload: (params: {
    fileName: string;
    relativePath?: string;
    folderBatchId?: string;
    fileSize: number;
    mimeType: string;
    chunkSize: number;
    totalChunks: number;
    deviceId: string;
    deviceName: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  sendChunk: (uploadId: string, chunkIndex: number, data: Uint8Array, signal?: AbortSignal) => Promise<void>;
  sendFastFile?: (params: {
    fileName: string;
    relativePath?: string;
    folderBatchId?: string;
    fileSize: number;
    mimeType: string;
    deviceId: string;
    deviceName: string;
    data: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<RoomFile>;
  completeUpload: (uploadId: string, signal?: AbortSignal) => Promise<RoomFile>;
  abortUpload: (uploadId: string) => void;
}

const FAST_FILE_CONCURRENCY = 12;
const LARGE_FILE_CONCURRENCY = 4;
const WS_CHUNK_PIPELINE_DEPTH = 6;
const HTTP_CHUNK_PIPELINE_DEPTH = 4;
const WS_MAX_BUFFERED_BYTES = 24 * 1024 * 1024;

export function getOrCreateDeviceId(): string {
  try {
    const existing = sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{6,64}$/.test(existing)) {
      return existing;
    }
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function getSavedDeviceName(): string {
  try {
    const saved = localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
    if (saved && saved.trim()) {
      return saved.trim();
    }
  } catch {
    // ignore storage errors
  }
  return detectDefaultDeviceName(typeof navigator !== 'undefined' ? navigator.userAgent : '');
}

export function saveDeviceName(name: string): void {
  try {
    const trimmed = name.trim();
    if (trimmed) {
      localStorage.setItem(DEVICE_NAME_STORAGE_KEY, trimmed);
    }
  } catch {
    // ignore storage errors
  }
}

export async function createRoom(roomName?: string): Promise<RoomSnapshot> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName: roomName?.trim() || undefined }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'تعذر إنشاء الغرفة.');
  }
  return data as RoomSnapshot;
}

export async function fetchRoom(code: string): Promise<RoomSnapshot> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, {
    credentials: 'same-origin',
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'الغرفة غير موجودة.');
  }
  return data as RoomSnapshot;
}

export async function fetchNetworkInfo(): Promise<{ localUrls: string[] }> {
  try {
    const res = await fetch('/api/network-info', { credentials: 'same-origin' });
    if (!res.ok) return { localUrls: [] };
    return (await res.json()) as { localUrls: string[] };
  } catch {
    return { localUrls: [] };
  }
}

export async function deleteRoomFile(code: string, fileId: string): Promise<void> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(code)}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', credentials: 'same-origin' }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'تعذر حذف الملف.');
  }
}

export async function deleteRoomFolder(code: string, batchId: string): Promise<string[]> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(code)}/folders/${encodeURIComponent(batchId)}`,
    { method: 'DELETE', credentials: 'same-origin' }
  );
  const data = (await res.json().catch(() => ({}))) as { fileIds?: string[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'تعذر حذف المجلد.');
  }
  return data.fileIds || [];
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback (required on HTTP LAN IPs or restricted contexts)
  }

  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

async function sendHttpChunkWithRetry(
  url: string,
  chunkData: ArrayBuffer,
  maxAttempts = 4,
  signal?: AbortSignal
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunkData,
        signal,
      });

      if (res.ok) {
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { error?: string };
      const message = data.error || `فشل رفع جزء من الملف (رمز ${res.status}).`;
      const err = new Error(message) as Error & { retryable?: boolean; status?: number };
      err.status = res.status;
      err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw err;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      lastError = err;
      const status = (err as { status?: number })?.status;
      // Network/CORS/proxy glitches on fetch throw TypeError -> always retryable
      const retryable =
        err instanceof TypeError || Boolean((err as { retryable?: boolean })?.retryable);
      if (!retryable || status === 413 || attempt === maxAttempts) {
        if (err instanceof TypeError) {
          throw new Error(
            navigator.onLine === false
              ? 'جهازك غير متصل بالشبكة حالياً.'
              : 'تعذر إرسال جزء من الملف عبر الشبكة، يرجى إعادة المحاولة.'
          );
        }
        throw err;
      }
      await new Promise((r) => window.setTimeout(r, attempt * 600));
    }
  }
  throw lastError;
}

async function uploadSingleFileViaHttp(
  code: string,
  item: UploadItem,
  deviceId: string,
  deviceName: string,
  chunkSize: number,
  onDeltaBytes: (bytesSent: number) => void,
  signal?: AbortSignal,
  chunkConcurrency = HTTP_CHUNK_PIPELINE_DEPTH
): Promise<RoomFile> {
  const { file, relativePath, folderBatchId } = item;
  const totalChunks = calculateChunkCount(file.size, chunkSize);

  const initRes = await fetch(`/api/rooms/${encodeURIComponent(code)}/uploads/init`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      fileName: file.name,
      relativePath,
      folderBatchId,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      chunkSize,
      totalChunks,
      deviceId,
      deviceName,
    }),
  });

  const initData = (await initRes.json().catch(() => ({}))) as {
    uploadId?: string;
    error?: string;
  };
  if (!initRes.ok || !initData.uploadId) {
    throw new Error(initData.error || 'تعذر بدء رفع الملف إلى الغرفة.');
  }

  const uploadId = initData.uploadId;

  try {
    let nextChunkIndex = 0;
    const workerCount = Math.min(chunkConcurrency, totalChunks);
    const runHttpWorker = async () => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError');
        }
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        if (chunkIndex >= totalChunks) {
          return;
        }
        const { start, end } = getChunkByteRange(file.size, chunkIndex, chunkSize);
        let chunkBuffer: ArrayBuffer;
        try {
          chunkBuffer = await file.slice(start, end).arrayBuffer();
        } catch {
          throw new Error(`تعذر قراءة الملف "${file.name}" من جهازك.`);
        }

        const chunkUrl = `/api/rooms/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}/chunk?index=${chunkIndex}`;
        await sendHttpChunkWithRetry(chunkUrl, chunkBuffer, 4, signal);
        onDeltaBytes(end - start);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runHttpWorker()));

    const completeRes = await fetch(
      `/api/rooms/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', credentials: 'same-origin', signal }
    );
    const completeData = (await completeRes.json().catch(() => ({}))) as {
      file?: RoomFile;
      error?: string;
    };
    if (!completeRes.ok || !completeData.file) {
      throw new Error(completeData.error || 'تعذر إتمام حفظ الملف في الغرفة.');
    }
    return completeData.file;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
      void fetch(`/api/rooms/${encodeURIComponent(code)}/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      }).catch(() => {});
    }
    throw err;
  }
}

async function waitForWsBufferDrain(wsTransport: WsUploadTransport, signal?: AbortSignal): Promise<void> {
  while (wsTransport.getBufferedAmount() > WS_MAX_BUFFERED_BYTES) {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }
    await new Promise((r) => window.setTimeout(r, 4));
  }
}

async function uploadSingleFileViaWs(
  wsTransport: WsUploadTransport,
  item: UploadItem,
  deviceId: string,
  deviceName: string,
  onDeltaBytes: (bytesSent: number) => void,
  signal?: AbortSignal
): Promise<RoomFile> {
  const { file, relativePath, folderBatchId } = item;

  if (file.size <= WS_FAST_UPLOAD_MAX_BYTES && wsTransport.sendFastFile) {
    await waitForWsBufferDrain(wsTransport, signal);
    let fastBuffer: ArrayBuffer;
    try {
      fastBuffer = await file.arrayBuffer();
    } catch {
      throw new Error(`تعذر قراءة الملف "${file.name}" من جهازك.`);
    }
    const result = await wsTransport.sendFastFile({
      fileName: file.name,
      relativePath,
      folderBatchId,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      deviceId,
      deviceName,
      data: new Uint8Array(fastBuffer),
      signal,
    });
    onDeltaBytes(file.size);
    return result;
  }

  const chunkSize = selectWsChunkSize(file.size);
  const totalChunks = calculateChunkCount(file.size, chunkSize);

  const uploadId = await wsTransport.initUpload({
    fileName: file.name,
    relativePath,
    folderBatchId,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    chunkSize,
    totalChunks,
    deviceId,
    deviceName,
    signal,
  });

  try {
    let nextChunkIndex = 0;
    const workerCount = Math.min(WS_CHUNK_PIPELINE_DEPTH, totalChunks);

    const runChunkWorker = async () => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError');
        }
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        if (chunkIndex >= totalChunks) {
          return;
        }

        await waitForWsBufferDrain(wsTransport, signal);
        const { start, end } = getChunkByteRange(file.size, chunkIndex, chunkSize);
        let chunkBuffer: ArrayBuffer;
        try {
          chunkBuffer = await file.slice(start, end).arrayBuffer();
        } catch {
          throw new Error(`تعذر قراءة الملف "${file.name}" من جهازك.`);
        }

        await wsTransport.sendChunk(uploadId, chunkIndex, new Uint8Array(chunkBuffer), signal);
        onDeltaBytes(end - start);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runChunkWorker()));
    return await wsTransport.completeUpload(uploadId, signal);
  } catch (err) {
    wsTransport.abortUpload(uploadId);
    throw err;
  }
}

export async function uploadFilesToRoom(
  code: string,
  rawItems: (File | UploadItem)[],
  deviceId: string,
  deviceName: string,
  onProgress: (info: UploadProgressInfo) => void,
  signal?: AbortSignal,
  wsTransport?: WsUploadTransport
): Promise<RoomFile[]> {
  const items: UploadItem[] = rawItems.map((entry) =>
    entry instanceof File ? { file: entry } : entry
  );
  const totalBytesAll = items.reduce((sum, item) => sum + item.file.size, 0);
  const totalFiles = items.length;
  const perFileBytes = new Float64Array(totalFiles);
  let totalLoaded = 0;
  let completedFiles = 0;
  let lastEmitAt = 0;
  const startTime = Date.now();
  const uploaded: RoomFile[] = new Array(totalFiles);

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 80) {
      return;
    }
    lastEmitAt = now;
    const elapsedSec = Math.max(0.25, (now - startTime) / 1000);
    onProgress({
      loaded: totalLoaded,
      total: totalBytesAll,
      completedFiles,
      totalFiles,
      bytesPerSec: Math.round(totalLoaded / elapsedSec),
    });
  };

  const setFileBytes = (idx: number, nextBytes: number) => {
    const delta = nextBytes - perFileBytes[idx];
    perFileBytes[idx] = nextBytes;
    totalLoaded += delta;
    emitProgress(false);
  };

  const uploadOneItem = async (idx: number): Promise<RoomFile> => {
    const item = items[idx];
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }

    const reportDelta = (delta: number) => {
      setFileBytes(idx, perFileBytes[idx] + delta);
    };

    const wsAvailable =
      wsTransport &&
      (wsTransport.isReady() || (await wsTransport.waitUntilReady(2500, signal)));

    let uploadedFile: RoomFile | null = null;
    if (wsAvailable && wsTransport) {
      try {
        uploadedFile = await uploadSingleFileViaWs(
          wsTransport,
          item,
          deviceId,
          deviceName,
          reportDelta,
          signal
        );
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
          throw err;
        }
        setFileBytes(idx, 0);
      }
    }

    if (!uploadedFile) {
      try {
        uploadedFile = await uploadSingleFileViaHttp(
          code,
          item,
          deviceId,
          deviceName,
          HTTP_FALLBACK_CHUNK_SIZE,
          reportDelta,
          signal
        );
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
          throw err;
        }
        setFileBytes(idx, 0);
        uploadedFile = await uploadSingleFileViaHttp(
          code,
          item,
          deviceId,
          deviceName,
          256 * 1024,
          reportDelta,
          signal,
          2
        );
      }
    }

    setFileBytes(idx, item.file.size);
    completedFiles += 1;
    emitProgress(true);
    return uploadedFile;
  };

  const smallIndices: number[] = [];
  const largeIndices: number[] = [];
  for (let i = 0; i < totalFiles; i += 1) {
    if (items[i].file.size <= WS_FAST_UPLOAD_MAX_BYTES) {
      smallIndices.push(i);
    } else {
      largeIndices.push(i);
    }
  }

  const runQueue = async (indices: number[], maxWorkers: number) => {
    if (indices.length === 0) return;
    let cursor = 0;
    const workerCount = Math.min(maxWorkers, indices.length);
    const worker = async () => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError');
        }
        const pos = cursor;
        cursor += 1;
        if (pos >= indices.length) {
          return;
        }
        const fileIdx = indices[pos];
        uploaded[fileIdx] = await uploadOneItem(fileIdx);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  };

  await Promise.all([
    runQueue(smallIndices, FAST_FILE_CONCURRENCY),
    runQueue(largeIndices, LARGE_FILE_CONCURRENCY),
  ]);
  emitProgress(true);
  return uploaded;
}

export function getFileDownloadUrl(code: string, fileId: string, inline = false): string {
  const base = `/api/rooms/${encodeURIComponent(code)}/files/${encodeURIComponent(fileId)}/download`;
  return inline ? `${base}?inline=1` : base;
}

export function getFolderDownloadUrl(code: string, batchId: string): string {
  return `/api/rooms/${encodeURIComponent(code)}/folders/${encodeURIComponent(batchId)}/download`;
}
