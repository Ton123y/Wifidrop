import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react';
import {
  Check,
  Copy,
  Download,
  FolderUp,
  Laptop,
  LogOut,
  Pencil,
  Search,
  Upload,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import type {
  FileCategory,
  RoomFile,
  RoomPeer,
  RoomSnapshot,
  WsClientMessage,
  WsServerMessage,
} from '../types.ts';
import {
  copyTextToClipboard,
  deleteRoomFile,
  deleteRoomFolder,
  getFileDownloadUrl,
  getFolderDownloadUrl,
  uploadFilesToRoom,
  type UploadItem,
  type UploadProgressInfo,
  type WsUploadTransport,
} from '../utils/api.ts';
import {
  detectDefaultDeviceName,
  encodeWsChunkFrame,
  encodeWsFastUploadFrame,
  filterRoomFiles,
  formatBytes,
  getFolderNameFromPath,
  groupRoomEntries,
  removeRoomFile,
  removeRoomFiles,
  sanitizeRelativePath,
  upsertRoomFile,
  upsertRoomFiles,
} from '../utils/roomLogic.ts';
import { RoomRtcMesh } from '../utils/rtcManager.ts';
import { RoomFilesList } from './RoomFilesList.tsx';

interface RoomWorkspaceProps {
  initialRoom: RoomSnapshot;
  deviceId: string;
  deviceName: string;
  onDeviceNameChange: (name: string) => void;
  onLeaveRoom: () => void;
  onCopySuccess: () => void;
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

const CATEGORY_TABS: { id: 'all' | FileCategory; label: string }[] = [
  { id: 'all', label: 'الكل' },
  { id: 'images', label: 'صور' },
  { id: 'documents', label: 'مستندات' },
  { id: 'code', label: 'برمجة ومشاريع' },
  { id: 'media', label: 'وسائط' },
  { id: 'archives', label: 'مضغوطة' },
  { id: 'other', label: 'أخرى' },
];

function createBatchId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `fld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  return entries;
}

async function extractDroppedItems(
  dataTransfer: DataTransfer
): Promise<{ items: UploadItem[]; sawDirectory: boolean }> {
  const rawItems = Array.from(dataTransfer.items || []);
  const rootEntries: FileSystemEntry[] = [];
  const directItems: UploadItem[] = [];

  for (const dtItem of rawItems) {
    const entry =
      typeof dtItem.webkitGetAsEntry === 'function' ? dtItem.webkitGetAsEntry() : null;
    if (entry) {
      rootEntries.push(entry);
    } else if (dtItem.kind === 'file') {
      const f = dtItem.getAsFile();
      if (f) {
        directItems.push({ file: f });
      }
    }
  }

  if (rootEntries.length > 0) {
    const sawDirectory = rootEntries.some((entry) => entry.isDirectory);
    const rootBatchMap = new Map<string, string>();
    const queue: FileSystemEntry[] = [...rootEntries];
    const items: UploadItem[] = [...directItems];
    let processedCount = 0;

    while (queue.length > 0) {
      const entry = queue.shift()!;
      processedCount += 1;
      // Yield periodically so large trees (thousands of files) don't freeze UI
      if (processedCount % 150 === 0) {
        await new Promise((r) => window.setTimeout(r, 0));
      }

      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File | null>((resolve) => {
          fileEntry.file(
            (f) => resolve(f),
            () => resolve(null)
          );
        });
        if (!file) continue;

        const cleanPath = entry.fullPath
          ? sanitizeRelativePath(entry.fullPath.replace(/^\/+/, ''))
          : '';
        const folderName = getFolderNameFromPath(cleanPath);
        if (folderName) {
          let batchId = rootBatchMap.get(folderName);
          if (!batchId) {
            batchId = createBatchId();
            rootBatchMap.set(folderName, batchId);
          }
          items.push({ file, relativePath: cleanPath, folderBatchId: batchId });
        } else {
          items.push({ file });
        }
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const reader = dirEntry.createReader();
        try {
          const children = await readAllDirectoryEntries(reader);
          queue.push(...children);
        } catch {
          // skip unreadable directory
        }
      }
    }

    if (items.length === 0 && !sawDirectory && dataTransfer.files?.length > 0) {
      return {
        items: Array.from(dataTransfer.files).map((file) => ({ file })),
        sawDirectory: false,
      };
    }

    return { items, sawDirectory };
  }

  if (directItems.length > 0) {
    return { items: directItems, sawDirectory: false };
  }

  const fallbackFiles = Array.from(dataTransfer.files || []).map((file) => ({ file }));
  return { items: fallbackFiles, sawDirectory: false };
}

function buildFolderInputItems(fileList: FileList): UploadItem[] {
  const rootBatchMap = new Map<string, string>();
  const items: UploadItem[] = [];

  for (const file of Array.from(fileList)) {
    const rawRel = file.webkitRelativePath || file.name;
    const cleanRel = sanitizeRelativePath(rawRel);
    const folderName = getFolderNameFromPath(cleanRel) || 'مجلد';
    const normalizedRel = cleanRel.includes('/') ? cleanRel : `${folderName}/${cleanRel}`;
    let batchId = rootBatchMap.get(folderName);
    if (!batchId) {
      batchId = createBatchId();
      rootBatchMap.set(folderName, batchId);
    }
    items.push({
      file,
      relativePath: normalizedRel,
      folderBatchId: batchId,
    });
  }

  return items;
}

function triggerFileDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function RoomWorkspace({
  initialRoom,
  deviceId,
  deviceName,
  onDeviceNameChange,
  onLeaveRoom,
  onCopySuccess,
}: RoomWorkspaceProps) {
  const [roomName, setRoomName] = useState(initialRoom.roomName);
  const [files, setFiles] = useState<RoomFile[]>(initialRoom.files);
  const [peers, setPeers] = useState<RoomPeer[]>(initialRoom.peers);
  const [wsState, setWsState] = useState<ConnectionState>('connecting');
  const [wsError, setWsError] = useState<string | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopiedLocal, setLinkCopiedLocal] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [isScanningFolder, setIsScanningFolder] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressInfo | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const [deletingFolderIds, setDeletingFolderIds] = useState<Record<string, boolean>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | FileCategory>('all');
  const [autoDownload, setAutoDownload] = useState(false);
  const [preferDirectP2P, setPreferDirectP2P] = useState(false);
  const [p2pPeerIds, setP2pPeerIds] = useState<string[]>([]);

  const [editingDeviceName, setEditingDeviceName] = useState(false);
  const [draftDeviceName, setDraftDeviceName] = useState(deviceName);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rtcMeshRef = useRef<RoomRtcMesh | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const createdObjectUrlsRef = useRef<Set<string>>(new Set());
  const pendingWsInitRef = useRef<
    Map<string, { resolve: (uploadId: string) => void; reject: (err: Error) => void }>
  >(new Map());
  const pendingWsAckRef = useRef<
    Map<string, { resolve: () => void; reject: (err: Error) => void }>
  >(new Map());
  const pendingWsCompleteRef = useRef<
    Map<string, { resolve: (file: RoomFile) => void; reject: (err: Error) => void }>
  >(new Map());
  const pendingWsFastRef = useRef<
    Map<string, { resolve: (file: RoomFile) => void; reject: (err: Error) => void }>
  >(new Map());
  const wsReadyWaitersRef = useRef<Array<(ready: boolean) => void>>([]);
  const queuedAddedFilesRef = useRef<RoomFile[]>([]);
  const queuedFlushTimerRef = useRef<number | null>(null);
  const knownFileIdsRef = useRef<Set<string>>(new Set(initialRoom.files.map((f) => f.id)));

  const autoDownloadRef = useRef(autoDownload);
  autoDownloadRef.current = autoDownload;
  const effectiveDeviceName =
    deviceName.trim() ||
    detectDefaultDeviceName(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const deviceNameRef = useRef(effectiveDeviceName);
  deviceNameRef.current = effectiveDeviceName;

  useEffect(() => {
    const urlsRef = createdObjectUrlsRef.current;
    return () => {
      uploadAbortRef.current?.abort();
      for (const url of urlsRef) {
        URL.revokeObjectURL(url);
      }
      urlsRef.clear();
    };
  }, []);

  const roomCode = initialRoom.code;
  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return `?room=${roomCode}`;
    const url = new URL(window.location.href);
    url.search = `?room=${roomCode}`;
    url.hash = '';
    return url.toString();
  }, [roomCode]);

  const wsTransport = useMemo<WsUploadTransport>(() => {
    const nextClientUploadId = () =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      isReady: () => Boolean(wsRef.current && wsRef.current.readyState === WebSocket.OPEN),
      getBufferedAmount: () => wsRef.current?.bufferedAmount ?? 0,
      waitUntilReady: (timeoutMs, signal) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          const timer = window.setTimeout(() => {
            cleanup();
            resolve(false);
          }, timeoutMs);
          const waiter = (ready: boolean) => {
            cleanup();
            resolve(ready);
          };
          const onAbort = () => {
            cleanup();
            resolve(false);
          };
          const cleanup = () => {
            window.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            wsReadyWaitersRef.current = wsReadyWaitersRef.current.filter((fn) => fn !== waiter);
          };
          wsReadyWaitersRef.current.push(waiter);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      initUpload: (params) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('الاتصال اللحظي غير مفتوح.'));
        }
        const clientUploadId = nextClientUploadId();
        return new Promise<string>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingWsInitRef.current.delete(clientUploadId);
            reject(new Error('انتهت مهلة بدء الرفع.'));
          }, 15000);
          const onAbort = () => {
            window.clearTimeout(timer);
            pendingWsInitRef.current.delete(clientUploadId);
            reject(new DOMException('Upload aborted', 'AbortError'));
          };
          params.signal?.addEventListener('abort', onAbort, { once: true });
          pendingWsInitRef.current.set(clientUploadId, {
            resolve: (uploadId) => {
              window.clearTimeout(timer);
              params.signal?.removeEventListener('abort', onAbort);
              resolve(uploadId);
            },
            reject: (err) => {
              window.clearTimeout(timer);
              params.signal?.removeEventListener('abort', onAbort);
              reject(err);
            },
          });
          const msg: WsClientMessage = {
            type: 'upload:init',
            clientUploadId,
            fileName: params.fileName,
            ...(params.relativePath ? { relativePath: params.relativePath } : {}),
            ...(params.folderBatchId ? { folderBatchId: params.folderBatchId } : {}),
            fileSize: params.fileSize,
            mimeType: params.mimeType,
            chunkSize: params.chunkSize,
            totalChunks: params.totalChunks,
            deviceId: params.deviceId,
            deviceName: params.deviceName,
          };
          socket.send(JSON.stringify(msg));
        });
      },
      sendChunk: (uploadId, chunkIndex, data, signal) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('انقطع الاتصال اللحظي أثناء الرفع.'));
        }
        const ackKey = `${uploadId}:${chunkIndex}`;
        return new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingWsAckRef.current.delete(ackKey);
            reject(new Error('انتهت مهلة تأكيد جزء الملف.'));
          }, 60000);
          const onAbort = () => {
            window.clearTimeout(timer);
            pendingWsAckRef.current.delete(ackKey);
            reject(new DOMException('Upload aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          pendingWsAckRef.current.set(ackKey, {
            resolve: () => {
              window.clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              resolve();
            },
            reject: (err) => {
              window.clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              reject(err);
            },
          });
          const frame = encodeWsChunkFrame({ uploadId, chunkIndex }, data);
          socket.send(frame);
        });
      },
      sendFastFile: (params) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('انقطع الاتصال اللحظي أثناء الرفع السريع.'));
        }
        const clientUploadId = nextClientUploadId();
        return new Promise<RoomFile>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingWsFastRef.current.delete(clientUploadId);
            reject(new Error('انتهت مهلة الرفع السريع.'));
          }, 45000);
          const onAbort = () => {
            window.clearTimeout(timer);
            pendingWsFastRef.current.delete(clientUploadId);
            reject(new DOMException('Upload aborted', 'AbortError'));
          };
          params.signal?.addEventListener('abort', onAbort, { once: true });
          pendingWsFastRef.current.set(clientUploadId, {
            resolve: (file) => {
              window.clearTimeout(timer);
              params.signal?.removeEventListener('abort', onAbort);
              resolve(file);
            },
            reject: (err) => {
              window.clearTimeout(timer);
              params.signal?.removeEventListener('abort', onAbort);
              reject(err);
            },
          });
          const frame = encodeWsFastUploadFrame(
            {
              clientUploadId,
              fileName: params.fileName,
              ...(params.relativePath ? { relativePath: params.relativePath } : {}),
              ...(params.folderBatchId ? { folderBatchId: params.folderBatchId } : {}),
              fileSize: params.fileSize,
              mimeType: params.mimeType,
              deviceId: params.deviceId,
              deviceName: params.deviceName,
            },
            params.data
          );
          socket.send(frame);
        });
      },
      completeUpload: (uploadId, signal) => {
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('انقطع الاتصال اللحظي قبل إتمام الملف.'));
        }
        return new Promise<RoomFile>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pendingWsCompleteRef.current.delete(uploadId);
            reject(new Error('انتهت مهلة إتمام الملف.'));
          }, 60000);
          const onAbort = () => {
            window.clearTimeout(timer);
            pendingWsCompleteRef.current.delete(uploadId);
            reject(new DOMException('Upload aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          pendingWsCompleteRef.current.set(uploadId, {
            resolve: (file) => {
              window.clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              resolve(file);
            },
            reject: (err) => {
              window.clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              reject(err);
            },
          });
          const msg: WsClientMessage = { type: 'upload:complete', uploadId };
          socket.send(JSON.stringify(msg));
        });
      },
      abortUpload: (uploadId) => {
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          const msg: WsClientMessage = { type: 'upload:abort', uploadId };
          socket.send(JSON.stringify(msg));
        }
      },
    };
  }, []);

  // Generate QR code for joining from phones on the same Wi-Fi
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(shareUrl, {
      width: 176,
      margin: 1,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl]);

  // WebSocket connection for real-time room sync + WebRTC peer mesh
  useEffect(() => {
    let closedByUser = false;
    let reconnectTimer: number | null = null;

    const rejectAllPendingWsUploads = (reason: string) => {
      const err = new Error(reason);
      for (const [, p] of pendingWsInitRef.current) p.reject(err);
      pendingWsInitRef.current.clear();
      for (const [, p] of pendingWsAckRef.current) p.reject(err);
      pendingWsAckRef.current.clear();
      for (const [, p] of pendingWsCompleteRef.current) p.reject(err);
      pendingWsCompleteRef.current.clear();
      for (const [, p] of pendingWsFastRef.current) p.reject(err);
      pendingWsFastRef.current.clear();
    };

    const rtcMesh = new RoomRtcMesh({
      selfDeviceId: deviceId,
      sendSignal: (targetDeviceId, signal) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const msg: WsClientMessage = { type: 'rtc:signal', targetDeviceId, signal };
          wsRef.current.send(JSON.stringify(msg));
        }
      },
      onConnectedPeersChange: (ids) => {
        setP2pPeerIds(ids);
      },
      onFileReceived: (incomingFile) => {
        if (incomingFile.localObjectUrl) {
          createdObjectUrlsRef.current.add(incomingFile.localObjectUrl);
        }
        let isNew = false;
        setFiles((prev) => {
          isNew = !prev.some((item) => item.id === incomingFile.id);
          return upsertRoomFile(prev, incomingFile);
        });
        if (isNew && autoDownloadRef.current && incomingFile.localObjectUrl) {
          triggerFileDownload(incomingFile.localObjectUrl, incomingFile.name);
        }
      },
    });
    rtcMeshRef.current = rtcMesh;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = 'arraybuffer';
      wsRef.current = socket;

      socket.onopen = () => {
        setWsState('connected');
        setWsError(null);
        const joinMsg: WsClientMessage = {
          type: 'join',
          roomCode,
          deviceId,
          deviceName: deviceNameRef.current,
        };
        socket.send(JSON.stringify(joinMsg));
        const waiters = [...wsReadyWaitersRef.current];
        wsReadyWaitersRef.current = [];
        for (const resolve of waiters) resolve(true);
      };

      socket.onmessage = (event) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(event.data)) as WsServerMessage;
        } catch {
          return;
        }

        if (msg.type === 'room:state') {
          setRoomName(msg.room.roomName);
          for (const rf of msg.room.files) {
            knownFileIdsRef.current.add(rf.id);
          }
          setFiles((prev) => {
            let merged = [...msg.room.files];
            for (const localItem of prev) {
              if (localItem.isDirectP2P && !merged.some((m) => m.id === localItem.id)) {
                merged = upsertRoomFile(merged, localItem);
              }
            }
            return merged;
          });
          setPeers(msg.room.peers);
          rtcMesh.syncPeers(msg.room.peers.map((p) => p.deviceId));
          return;
        }

        if (msg.type === 'peers:updated') {
          setPeers(msg.peers);
          rtcMesh.syncPeers(msg.peers.map((p) => p.deviceId));
          return;
        }

        if (msg.type === 'rtc:signal') {
          void rtcMesh.handleSignal(msg.fromDeviceId, msg.signal);
          return;
        }

        if (msg.type === 'upload:ready') {
          const waiter = pendingWsInitRef.current.get(msg.clientUploadId);
          if (waiter) {
            pendingWsInitRef.current.delete(msg.clientUploadId);
            waiter.resolve(msg.uploadId);
          }
          return;
        }

        if (msg.type === 'upload:ack') {
          const ackKey = `${msg.uploadId}:${msg.chunkIndex}`;
          const waiter = pendingWsAckRef.current.get(ackKey);
          if (waiter) {
            pendingWsAckRef.current.delete(ackKey);
            waiter.resolve();
          }
          return;
        }

        if (msg.type === 'upload:done') {
          const waiter = pendingWsCompleteRef.current.get(msg.uploadId);
          if (waiter) {
            pendingWsCompleteRef.current.delete(msg.uploadId);
            waiter.resolve(msg.file);
          }
          return;
        }

        if (msg.type === 'upload:fast-done') {
          const waiter = pendingWsFastRef.current.get(msg.clientUploadId);
          if (waiter) {
            pendingWsFastRef.current.delete(msg.clientUploadId);
            waiter.resolve(msg.file);
          }
          return;
        }

        if (msg.type === 'upload:error') {
          const err = new Error(msg.message);
          if (msg.clientUploadId) {
            const initWaiter = pendingWsInitRef.current.get(msg.clientUploadId);
            if (initWaiter) {
              pendingWsInitRef.current.delete(msg.clientUploadId);
              initWaiter.reject(err);
            }
            const fastWaiter = pendingWsFastRef.current.get(msg.clientUploadId);
            if (fastWaiter) {
              pendingWsFastRef.current.delete(msg.clientUploadId);
              fastWaiter.reject(err);
            }
          }
          if (msg.uploadId) {
            const completeWaiter = pendingWsCompleteRef.current.get(msg.uploadId);
            if (completeWaiter) {
              pendingWsCompleteRef.current.delete(msg.uploadId);
              completeWaiter.reject(err);
            }
            for (const [key, ackWaiter] of pendingWsAckRef.current) {
              if (key.startsWith(`${msg.uploadId}:`)) {
                pendingWsAckRef.current.delete(key);
                ackWaiter.reject(err);
              }
            }
          }
          return;
        }

        if (msg.type === 'file:added') {
          const isNew = !knownFileIdsRef.current.has(msg.file.id);
          knownFileIdsRef.current.add(msg.file.id);
          queuedAddedFilesRef.current.push(msg.file);
          if (queuedFlushTimerRef.current === null) {
            queuedFlushTimerRef.current = window.setTimeout(() => {
              queuedFlushTimerRef.current = null;
              const batch = queuedAddedFilesRef.current;
              queuedAddedFilesRef.current = [];
              if (batch.length > 0) {
                setFiles((prev) => upsertRoomFiles(prev, batch));
              }
            }, 80);
          }
          if (isNew && autoDownloadRef.current && msg.file.senderDeviceId !== deviceId) {
            triggerFileDownload(getFileDownloadUrl(roomCode, msg.file.id), msg.file.name);
          }
          return;
        }

        if (msg.type === 'file:removed') {
          knownFileIdsRef.current.delete(msg.fileId);
          queuedAddedFilesRef.current = queuedAddedFilesRef.current.filter(
            (f) => f.id !== msg.fileId
          );
          setFiles((prev) => removeRoomFile(prev, msg.fileId));
          return;
        }

        if (msg.type === 'files:removed') {
          const removedSet = new Set(msg.fileIds);
          for (const id of removedSet) knownFileIdsRef.current.delete(id);
          queuedAddedFilesRef.current = queuedAddedFilesRef.current.filter(
            (f) => !removedSet.has(f.id)
          );
          setFiles((prev) => removeRoomFiles(prev, msg.fileIds));
          return;
        }

        if (msg.type === 'error') {
          setWsError(msg.message);
        }
      };

      socket.onclose = () => {
        rejectAllPendingWsUploads('انقطع الاتصال اللحظي، جاري المتابعة بالبديل.');
        if (closedByUser) return;
        setWsState('reconnecting');
        reconnectTimer = window.setTimeout(connect, 2500);
      };

      socket.onerror = () => {
        // onclose handles reconnect & pending rejection
      };
    };

    connect();

    return () => {
      closedByUser = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (queuedFlushTimerRef.current !== null) {
        window.clearTimeout(queuedFlushTimerRef.current);
        queuedFlushTimerRef.current = null;
      }
      queuedAddedFilesRef.current = [];
      rejectAllPendingWsUploads('تمت مغادرة الغرفة.');
      const waiters = [...wsReadyWaitersRef.current];
      wsReadyWaitersRef.current = [];
      for (const resolve of waiters) resolve(false);
      rtcMesh.dispose();
      rtcMeshRef.current = null;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [roomCode, deviceId]);

  const handleUploadItems = useCallback(
    async (rawSelected: FileList | (File | UploadItem)[]) => {
      const list: UploadItem[] = Array.from(rawSelected).map((entry) =>
        entry instanceof File ? { file: entry } : entry
      );
      if (list.length === 0) return;

      uploadAbortRef.current?.abort();
      const controller = new AbortController();
      uploadAbortRef.current = controller;

      const totalBytes = list.reduce((sum, item) => sum + item.file.size, 0);
      setUploadError(null);
      setUploadingCount(list.length);
      setUploadProgress({
        loaded: 0,
        total: totalBytes,
        completedFiles: 0,
        totalFiles: list.length,
        bytesPerSec: 0,
      });

      try {
        let added: RoomFile[];
        const p2pTargets = rtcMeshRef.current?.getConnectedPeerIds() || [];

        if (preferDirectP2P && p2pTargets.length > 0 && rtcMeshRef.current) {
          added = await rtcMeshRef.current.sendFilesToPeers(
            list,
            p2pTargets,
            deviceNameRef.current,
            (info) => setUploadProgress(info),
            controller.signal
          );
          for (const item of added) {
            if (item.localObjectUrl) {
              createdObjectUrlsRef.current.add(item.localObjectUrl);
            }
          }
        } else {
          added = await uploadFilesToRoom(
            roomCode,
            list,
            deviceId,
            deviceNameRef.current,
            (info) => setUploadProgress(info),
            controller.signal,
            wsTransport
          );
        }

        // Idempotent local reconciliation in case WS arrives slightly after upload finishes
        for (const item of added) {
          knownFileIdsRef.current.add(item.id);
        }
        setFiles((prev) => upsertRoomFiles(prev, added));
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError' || controller.signal.aborted) {
          return;
        }
        setUploadError(err instanceof Error ? err.message : 'تعذر رفع الملفات.');
      } finally {
        if (uploadAbortRef.current === controller) {
          uploadAbortRef.current = null;
        }
        setUploadingCount(0);
        setUploadProgress(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        if (folderInputRef.current) {
          folderInputRef.current.value = '';
        }
      }
    },
    [roomCode, deviceId, preferDirectP2P, wsTransport]
  );

  const handleCancelUpload = () => {
    uploadAbortRef.current?.abort();
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void handleUploadItems(e.target.files);
    }
  };

  const handleFolderInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const items = buildFolderInputItems(e.target.files);
      void handleUploadItems(items);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    setUploadError(null);
    setIsScanningFolder(true);
    try {
      const { items, sawDirectory } = await extractDroppedItems(e.dataTransfer);
      if (items.length > 0) {
        void handleUploadItems(items);
      } else if (sawDirectory) {
        setUploadError('المجلد المختار فارغ ولا يحتوي على ملفات.');
      }
    } finally {
      setIsScanningFolder(false);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      void handleUploadItems(e.clipboardData.files);
      return;
    }
    const pastedFiles = Array.from(e.clipboardData.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void handleUploadItems(pastedFiles);
    }
  };

  const handleDeleteFile = async (file: RoomFile) => {
    if (file.isDirectP2P) {
      if (file.localObjectUrl) {
        URL.revokeObjectURL(file.localObjectUrl);
        createdObjectUrlsRef.current.delete(file.localObjectUrl);
      }
      setFiles((prev) => removeRoomFile(prev, file.id));
      return;
    }
    setDeletingIds((prev) => ({ ...prev, [file.id]: true }));
    try {
      await deleteRoomFile(roomCode, file.id);
      setFiles((prev) => removeRoomFile(prev, file.id));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'تعذر حذف الملف.');
    } finally {
      setDeletingIds((prev) => {
        const next = { ...prev };
        delete next[file.id];
        return next;
      });
    }
  };

  const handleDeleteFolder = async (batchId: string, folderFiles: RoomFile[]) => {
    if (folderFiles.every((f) => f.isDirectP2P)) {
      const removedIds: string[] = [];
      for (const f of folderFiles) {
        removedIds.push(f.id);
        if (f.localObjectUrl) {
          URL.revokeObjectURL(f.localObjectUrl);
          createdObjectUrlsRef.current.delete(f.localObjectUrl);
        }
      }
      setFiles((prev) => removeRoomFiles(prev, removedIds));
      return;
    }

    setDeletingFolderIds((prev) => ({ ...prev, [batchId]: true }));
    try {
      const removedIds = await deleteRoomFolder(roomCode, batchId);
      setFiles((prev) => removeRoomFiles(prev, removedIds));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'تعذر حذف المجلد.');
    } finally {
      setDeletingFolderIds((prev) => {
        const next = { ...prev };
        delete next[batchId];
        return next;
      });
    }
  };

  const handleCopyCode = async () => {
    const ok = await copyTextToClipboard(roomCode);
    if (ok) {
      setCodeCopied(true);
      window.setTimeout(() => setCodeCopied(false), 1800);
    }
  };

  const handleCopyShareLink = async () => {
    const ok = await copyTextToClipboard(shareUrl);
    if (ok) {
      setLinkCopiedLocal(true);
      onCopySuccess();
      window.setTimeout(() => setLinkCopiedLocal(false), 1800);
    }
  };

  const handleSaveDeviceName = () => {
    const cleaned = draftDeviceName.trim() || effectiveDeviceName;
    onDeviceNameChange(cleaned);
    setDraftDeviceName(cleaned);
    setEditingDeviceName(false);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = { type: 'peer:rename', deviceName: cleaned };
      wsRef.current.send(JSON.stringify(msg));
    }
  };

  const filteredFiles = useMemo(
    () => filterRoomFiles(files, searchQuery, categoryFilter),
    [files, searchQuery, categoryFilter]
  );

  const groupedEntries = useMemo(
    () => groupRoomEntries(filteredFiles),
    [filteredFiles]
  );

  const handleDownloadAll = () => {
    let idx = 0;
    for (const entry of groupedEntries) {
      if (entry.kind === 'folder' && !entry.isDirectP2P) {
        const delay = idx * 180;
        idx += 1;
        window.setTimeout(() => {
          triggerFileDownload(
            getFolderDownloadUrl(roomCode, entry.batchId),
            `${entry.folderName}.zip`
          );
        }, delay);
      } else if (entry.kind === 'folder') {
        for (const f of entry.files) {
          const delay = idx * 180;
          idx += 1;
          window.setTimeout(() => {
            triggerFileDownload(
              f.localObjectUrl || getFileDownloadUrl(roomCode, f.id),
              f.name
            );
          }, delay);
        }
      } else {
        const delay = idx * 180;
        idx += 1;
        window.setTimeout(() => {
          triggerFileDownload(
            entry.file.localObjectUrl || getFileDownloadUrl(roomCode, entry.file.id),
            entry.file.name
          );
        }, delay);
      }
    }
  };

  const uploadPercent =
    uploadProgress && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
      : 0;

  return (
    <main
      onPaste={handlePaste}
      className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8"
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Sidebar: Room Identity, QR & Connected Devices (appears below files on mobile, right column on desktop) */}
        <aside className="order-2 w-full shrink-0 space-y-5 lg:order-1 lg:w-[300px]">
          {/* Room Identity & QR Card */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-slate-900">{roomName}</h1>
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-600">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${
                      wsState === 'connected'
                        ? 'bg-emerald-600'
                        : 'bg-amber-500'
                    }`}
                  />
                  <span>
                    {wsState === 'connected'
                      ? 'متصل بالغرفة لحظياً'
                      : wsState === 'connecting'
                      ? 'جاري الاتصال بالغرفة...'
                      : 'جاري إعادة الاتصال...'}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
              <div className="text-xs text-slate-500">رمز الغرفة</div>
              <div
                dir="ltr"
                data-testid="active-room-code"
                className="mt-1 font-mono text-2xl font-semibold tracking-[0.22em] text-slate-900 select-all"
              >
                {roomCode}
              </div>
            </div>

            <div className="flex flex-col items-center rounded-lg border border-slate-200 bg-white p-3">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`رمز QR للانضمام إلى الغرفة ${roomCode}`}
                  referrerPolicy="no-referrer"
                  className="h-40 w-40 object-contain"
                />
              ) : (
                <div className="flex h-40 w-40 items-center justify-center text-xs text-slate-400">
                  جاري تجهيز الباركود...
                </div>
              )}
              <p className="mt-2 text-center text-xs text-slate-500">
                امسح الباركود من كاميرا الهاتف للدخول لنفس الغرفة
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleCopyCode}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors"
              >
                {codeCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                <span>{codeCopied ? 'تم النسخ' : 'نسخ الرمز'}</span>
              </button>
              <button
                type="button"
                onClick={handleCopyShareLink}
                className="inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors"
              >
                {linkCopiedLocal ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                <span>{linkCopiedLocal ? 'تم نسخ الرابط' : 'نسخ الرابط'}</span>
              </button>
            </div>
          </section>

          {/* Connected Peers List */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">الأجهزة المتصلة في الغرفة</h2>
              <span
                data-testid="peer-count"
                className="font-mono text-xs font-semibold text-slate-600 tabular-nums"
              >
                {peers.length}
              </span>
            </div>

            <ul data-testid="peers-list" className="divide-y divide-slate-100">
              {peers.map((peer) => {
                const isSelf = peer.deviceId === deviceId;
                return (
                  <li key={peer.deviceId} className="flex items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Laptop className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                      <div className="min-w-0">
                        {isSelf && editingDeviceName ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              maxLength={36}
                              aria-label="تعديل اسم هذا الجهاز"
                              value={draftDeviceName}
                              onChange={(e) => setDraftDeviceName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveDeviceName();
                                if (e.key === 'Escape') setEditingDeviceName(false);
                              }}
                              className="w-32 rounded border border-blue-500 px-2 py-1 text-xs text-slate-900 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={handleSaveDeviceName}
                              className="cursor-pointer rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                            >
                              حفظ
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                            <span className="truncate">{peer.deviceName}</span>
                            {isSelf && <span className="text-xs font-normal text-slate-500">(هذا الجهاز)</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    {isSelf && !editingDeviceName && (
                      <button
                        type="button"
                        aria-label="تعديل اسم جهازك"
                        onClick={() => {
                          setDraftDeviceName(deviceName);
                          setEditingDeviceName(true);
                        }}
                        className="cursor-pointer rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>

            {peers.length <= 1 && (
              <p className="text-xs leading-relaxed text-slate-500">
                في انتظار انضمام جهاز آخر عبر رمز الغرفة أو مسح الباركود.
              </p>
            )}
          </section>

          {/* Room Options */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-slate-900">تنزيل تلقائي للملفات الواردة</div>
                <div className="text-xs text-slate-500">حفظ أي ملف يرسله جهاز آخر تلقائياً</div>
              </div>
              <input
                type="checkbox"
                checked={autoDownload}
                onChange={(e) => setAutoDownload(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
            </label>

            <hr className="border-slate-200" />

            <button
              type="button"
              onClick={onLeaveRoom}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>مغادرة الغرفة</span>
            </button>
          </section>
        </aside>

        {/* Main Viewport: Upload Dropzone + Shared Files List */}
        <div className="order-1 min-w-0 flex-1 space-y-6 lg:order-2">
          {/* Compact Mobile Room Summary */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 lg:hidden">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{roomName}</div>
              <div className="text-xs text-slate-500 tabular-nums">
                {peers.length} {peers.length === 1 ? 'جهاز متصل' : 'أجهزة متصلة'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopyCode}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm font-semibold tracking-wider text-slate-900"
              dir="ltr"
            >
              <span>{roomCode}</span>
              {codeCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />}
            </button>
          </div>

          {wsError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800"
            >
              {wsError}
            </div>
          )}

          {/* Upload Dropzone */}
          <section
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors sm:p-8 ${
              isDragging
                ? 'border-blue-600 bg-blue-50/70'
                : 'border-slate-300 bg-white hover:border-slate-400'
            }`}
          >
            <input
              ref={fileInputRef}
              id="room-file-upload"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={handleFileInputChange}
              className="sr-only"
            />
            <input
              ref={folderInputRef}
              id="room-folder-upload"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={handleFolderInputChange}
              className="sr-only"
            />
            <div className="mx-auto flex max-w-lg flex-col items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <Upload className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-slate-900">
                  اسحب أي ملفات أو مجلدات كاملة وأفلتها هنا للإرسال
                </h2>
                <p className="text-xs text-slate-500">
                  يقبل كل أنواع الملفات والمشاريع البرمجية (Python، C/C++، Java، JS/TS، Dart، C#، Go، Rust، PHP، SQL، Docker، .env، فيديوهات ومجلدات ثقيلة) — حتى 100 GB للملف الواحد
                </p>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingCount > 0 || isScanningFolder}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>{uploadingCount > 0 ? 'جاري الرفع...' : 'اختيار ملفات'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={uploadingCount > 0 || isScanningFolder}
                  className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <FolderUp className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span>{isScanningFolder ? 'جاري فحص المجلد...' : 'اختيار مجلد كامل'}</span>
                </button>
              </div>

              {p2pPeerIds.length > 0 && (
                <label className="mt-1 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={preferDirectP2P}
                    onChange={(e) => setPreferDirectP2P(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                  />
                  <span>
                    نقل مباشر P2P عبر الواي فاي ({p2pPeerIds.length}{' '}
                    {p2pPeerIds.length === 1 ? 'جهاز متصل مباشرة' : 'أجهزة متصلة مباشرة'})
                  </span>
                </label>
              )}
            </div>

            {uploadingCount > 0 && uploadProgress && (
              <div className="mx-auto mt-5 max-w-md space-y-2 text-right">
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-700">
                  <span className="truncate">
                    {uploadProgress.totalFiles === 1
                      ? 'جاري إرسال ملف واحد إلى الغرفة...'
                      : `جاري رفع ${uploadProgress.completedFiles} من ${uploadProgress.totalFiles} ملفاً...`}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono tabular-nums">{uploadPercent}%</span>
                    <button
                      type="button"
                      onClick={handleCancelUpload}
                      className="inline-flex cursor-pointer items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      <span>إلغاء الرفع</span>
                    </button>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-blue-600 transition-[width] duration-150"
                    style={{ width: `${uploadPercent}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs font-mono text-slate-500 tabular-nums">
                  <span dir="ltr">
                    {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
                  </span>
                  {uploadProgress.bytesPerSec > 0 && (
                    <span dir="ltr">{formatBytes(uploadProgress.bytesPerSec)}/s</span>
                  )}
                </div>
              </div>
            )}

            {uploadError && (
              <div
                role="alert"
                className="mx-auto mt-4 max-w-md rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
              >
                {uploadError}
              </div>
            )}
          </section>

          {/* Shared Files Section */}
          <section className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-bold text-slate-900">ملفات الغرفة</h2>
                <span
                  data-testid="file-count"
                  className="font-mono text-sm text-slate-500 tabular-nums"
                >
                  ({files.length})
                </span>
              </div>

              {files.length > 0 && (
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  className="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap self-start rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors sm:self-auto"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>تنزيل الكل ({filteredFiles.length})</span>
                </button>
              )}
            </div>

            {/* Search & Category Filter Bar */}
            {files.length > 0 && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative flex-1 max-w-sm">
                  <Search
                    className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ابحث باسم الملف أو الجهاز المرسل..."
                    aria-label="ابحث في ملفات الغرفة"
                    className="w-full rounded-lg border border-slate-300 bg-white py-2 pr-9 pl-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                  />
                </div>

                <div
                  role="tablist"
                  aria-label="تصفية الملفات حسب النوع"
                  className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1"
                >
                  {CATEGORY_TABS.map((tab) => {
                    const active = categoryFilter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setCategoryFilter(tab.id)}
                        className={`cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                          active
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* File & Folder List States */}
            <RoomFilesList
              roomCode={roomCode}
              entries={groupedEntries}
              totalFilesCount={files.length}
              filteredFilesCount={filteredFiles.length}
              hasActiveFilter={Boolean(searchQuery.trim() || categoryFilter !== 'all')}
              deletingIds={deletingIds}
              deletingFolderIds={deletingFolderIds}
              onDeleteFile={(file) => void handleDeleteFile(file)}
              onDeleteFolder={(batchId, folderFiles) => void handleDeleteFolder(batchId, folderFiles)}
              onClearFilter={() => {
                setSearchQuery('');
                setCategoryFilter('all');
              }}
              onChooseFiles={() => fileInputRef.current?.click()}
              onChooseFolder={() => folderInputRef.current?.click()}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
