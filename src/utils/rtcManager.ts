import type { RoomFile, RtcSignalPayload } from '../types.ts';
import {
  classifyFileCategory,
  getChunkByteRange,
  P2P_RTC_CHUNK_SIZE,
  sanitizeDisplayFilename,
} from './roomLogic.ts';

interface RtcFileHeader {
  kind: 'file-start';
  transferId: string;
  fileName: string;
  relativePath?: string;
  folderBatchId?: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  senderDeviceId: string;
  senderDeviceName: string;
}

interface RtcFileEnd {
  kind: 'file-end';
  transferId: string;
}

type RtcControlFrame = RtcFileHeader | RtcFileEnd;

interface IncomingRtcTransfer {
  meta: RtcFileHeader;
  chunks: BlobPart[];
  receivedBytes: number;
}

interface PeerSlot {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  makingOffer: boolean;
  polite: boolean;
  incoming: IncomingRtcTransfer | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024; // 4 MB backpressure cap
const BUFFER_LOW_THRESHOLD = 1024 * 1024; // 1 MB resume watermark

export class RoomRtcMesh {
  private readonly selfDeviceId: string;
  private readonly sendSignalFn: (targetDeviceId: string, signal: RtcSignalPayload) => void;
  private readonly onConnectedPeersChange: (deviceIds: string[]) => void;
  private readonly onFileReceived: (file: RoomFile) => void;
  private readonly slots = new Map<string, PeerSlot>();
  private disposed = false;

  constructor(options: {
    selfDeviceId: string;
    sendSignal: (targetDeviceId: string, signal: RtcSignalPayload) => void;
    onConnectedPeersChange: (deviceIds: string[]) => void;
    onFileReceived: (file: RoomFile) => void;
  }) {
    this.selfDeviceId = options.selfDeviceId;
    this.sendSignalFn = options.sendSignal;
    this.onConnectedPeersChange = options.onConnectedPeersChange;
    this.onFileReceived = options.onFileReceived;
  }

  public syncPeers(peerDeviceIds: string[]): void {
    if (this.disposed || typeof RTCPeerConnection === 'undefined') return;
    const desired = new Set(peerDeviceIds.filter((id) => id && id !== this.selfDeviceId));

    for (const [peerId] of this.slots) {
      if (!desired.has(peerId)) {
        this.teardownPeer(peerId);
      }
    }

    for (const peerId of desired) {
      if (!this.slots.has(peerId)) {
        const initiator = this.selfDeviceId < peerId;
        this.setupPeer(peerId, initiator);
      }
    }
  }

  public async handleSignal(fromDeviceId: string, signal: RtcSignalPayload): Promise<void> {
    if (this.disposed || typeof RTCPeerConnection === 'undefined') return;
    if (!fromDeviceId || fromDeviceId === this.selfDeviceId) return;

    let slot = this.slots.get(fromDeviceId);
    if (!slot) {
      slot = this.setupPeer(fromDeviceId, false);
    }

    const { pc } = slot;
    try {
      if (signal.sdp) {
        const desc = new RTCSessionDescription(signal.sdp);
        const offerCollision =
          desc.type === 'offer' && (slot.makingOffer || pc.signalingState !== 'stable');
        if (offerCollision && !slot.polite) {
          return;
        }
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (pc.localDescription) {
            this.sendSignalFn(fromDeviceId, {
              sdp: { type: pc.localDescription.type as 'offer' | 'answer', sdp: pc.localDescription.sdp },
            });
          }
        }
      } else if (signal.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch {
          // ignore stale ICE candidates during renegotiation
        }
      }
    } catch {
      // ignore transient WebRTC negotiation failures; WS upload handles transfers cleanly
    }
  }

  public getConnectedPeerIds(): string[] {
    const ids: string[] = [];
    for (const [peerId, slot] of this.slots) {
      if (slot.channel && slot.channel.readyState === 'open') {
        ids.push(peerId);
      }
    }
    return ids;
  }

  public async sendFilesToPeers(
    rawItems: (File | { file: File; relativePath?: string; folderBatchId?: string })[],
    targetPeerIds: string[],
    senderDeviceName: string,
    onProgress: (info: {
      loaded: number;
      total: number;
      completedFiles: number;
      totalFiles: number;
      bytesPerSec: number;
    }) => void,
    signal?: AbortSignal
  ): Promise<RoomFile[]> {
    const items = rawItems.map((entry) =>
      entry instanceof File ? { file: entry } : entry
    );
    const openSlots = targetPeerIds
      .map((id) => ({ id, slot: this.slots.get(id) }))
      .filter((entry): entry is { id: string; slot: PeerSlot } =>
        Boolean(entry.slot?.channel && entry.slot.channel.readyState === 'open')
      );

    if (openSlots.length === 0) {
      throw new Error('لا يوجد اتصال مباشر مفتوح مع الأجهزة الأخرى حالياً.');
    }

    const totalBytesAll = items.reduce((sum, item) => sum + item.file.size, 0) * openSlots.length;
    const totalFiles = items.length;
    let completedBytesAll = 0;
    let completedFiles = 0;
    let lastProgressAt = 0;
    const startTime = Date.now();
    const sentRecords: RoomFile[] = [];

    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 80) return;
      lastProgressAt = now;
      const elapsedSec = Math.max(0.25, (now - startTime) / 1000);
      onProgress({
        loaded: completedBytesAll,
        total: Math.max(1, totalBytesAll),
        completedFiles,
        totalFiles,
        bytesPerSec: Math.round(completedBytesAll / elapsedSec),
      });
    };

    for (const item of items) {
      const { file, relativePath, folderBatchId } = item;
      const totalChunks = Math.max(1, Math.ceil(file.size / P2P_RTC_CHUNK_SIZE));
      const transferId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      for (const { slot } of openSlots) {
        const channel = slot.channel;
        if (!channel || channel.readyState !== 'open') {
          throw new Error('انقطع الاتصال المباشر مع أحد الأجهزة.');
        }

        const header: RtcFileHeader = {
          kind: 'file-start',
          transferId,
          fileName: file.name,
          ...(relativePath ? { relativePath } : {}),
          ...(folderBatchId ? { folderBatchId } : {}),
          fileSize: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks,
          senderDeviceId: this.selfDeviceId,
          senderDeviceName,
        };
        channel.send(JSON.stringify(header));

        for (let idx = 0; idx < totalChunks; idx += 1) {
          if (signal?.aborted) {
            throw new DOMException('Upload aborted', 'AbortError');
          }
          if (channel.readyState !== 'open') {
            throw new Error('انقطع الاتصال المباشر أثناء الإرسال.');
          }
          await this.waitForChannelDrain(channel, signal);
          const { start, end } = getChunkByteRange(file.size, idx, P2P_RTC_CHUNK_SIZE);
          const chunkBuf = await file.slice(start, end).arrayBuffer();
          channel.send(chunkBuf);
          completedBytesAll += end - start;
          emitProgress(false);
        }

        const endFrame: RtcFileEnd = { kind: 'file-end', transferId };
        channel.send(JSON.stringify(endFrame));
      }

      completedFiles += 1;
      emitProgress(true);

      const displayName = sanitizeDisplayFilename(file.name);
      const mime = file.type || 'application/octet-stream';
      sentRecords.push({
        id: transferId,
        name: displayName,
        ...(relativePath ? { relativePath } : {}),
        ...(folderBatchId ? { folderBatchId } : {}),
        size: file.size,
        mimeType: mime,
        category: classifyFileCategory(mime, displayName),
        senderDeviceId: this.selfDeviceId,
        senderDeviceName,
        uploadedAt: Date.now(),
        localObjectUrl: URL.createObjectURL(file),
        isDirectP2P: true,
      });
    }

    return sentRecords;
  }

  public dispose(): void {
    this.disposed = true;
    for (const peerId of Array.from(this.slots.keys())) {
      this.teardownPeer(peerId);
    }
  }

  private setupPeer(peerId: string, initiator: boolean): PeerSlot {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const slot: PeerSlot = {
      pc,
      channel: null,
      makingOffer: false,
      polite: !initiator,
      incoming: null,
    };
    this.slots.set(peerId, slot);

    pc.onicecandidate = (event) => {
      if (this.disposed || !event.candidate) return;
      this.sendSignalFn(peerId, {
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        },
      });
    };

    pc.ondatachannel = (event) => {
      this.attachChannel(peerId, slot, event.channel);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.notifyConnected();
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel('wifidrop-p2p', { ordered: true });
      this.attachChannel(peerId, slot, channel);

      pc.onnegotiationneeded = async () => {
        if (this.disposed) return;
        try {
          slot.makingOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (pc.localDescription) {
            this.sendSignalFn(peerId, {
              sdp: {
                type: pc.localDescription.type as 'offer' | 'answer',
                sdp: pc.localDescription.sdp,
              },
            });
          }
        } catch {
          // ignore negotiation error
        } finally {
          slot.makingOffer = false;
        }
      };
    }

    return slot;
  }

  private attachChannel(peerId: string, slot: PeerSlot, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
    slot.channel = channel;

    channel.onopen = () => {
      this.notifyConnected();
    };
    channel.onclose = () => {
      if (slot.channel === channel) {
        slot.channel = null;
      }
      this.notifyConnected();
    };
    channel.onerror = () => {
      this.notifyConnected();
    };
    channel.onmessage = (event) => {
      this.handleChannelMessage(slot, event.data);
    };
  }

  private handleChannelMessage(slot: PeerSlot, data: string | ArrayBuffer | Blob): void {
    if (typeof data === 'string') {
      let frame: RtcControlFrame;
      try {
        frame = JSON.parse(data) as RtcControlFrame;
      } catch {
        return;
      }

      if (frame.kind === 'file-start') {
        slot.incoming = {
          meta: frame,
          chunks: [],
          receivedBytes: 0,
        };
        return;
      }

      if (frame.kind === 'file-end' && slot.incoming?.meta.transferId === frame.transferId) {
        const completed = slot.incoming;
        slot.incoming = null;
        const mime = completed.meta.mimeType || 'application/octet-stream';
        const blob = new Blob(completed.chunks, { type: mime });
        const objectUrl = URL.createObjectURL(blob);
        const displayName = sanitizeDisplayFilename(completed.meta.fileName);

        this.onFileReceived({
          id: completed.meta.transferId,
          name: displayName,
          ...(completed.meta.relativePath ? { relativePath: completed.meta.relativePath } : {}),
          ...(completed.meta.folderBatchId ? { folderBatchId: completed.meta.folderBatchId } : {}),
          size: blob.size || completed.meta.fileSize,
          mimeType: mime,
          category: classifyFileCategory(mime, displayName),
          senderDeviceId: completed.meta.senderDeviceId,
          senderDeviceName: completed.meta.senderDeviceName,
          uploadedAt: Date.now(),
          localObjectUrl: objectUrl,
          isDirectP2P: true,
        });
      }
      return;
    }

    if (slot.incoming) {
      if (data instanceof ArrayBuffer) {
        slot.incoming.chunks.push(data);
        slot.incoming.receivedBytes += data.byteLength;
      } else if (data instanceof Blob) {
        slot.incoming.chunks.push(data);
        slot.incoming.receivedBytes += data.size;
      }
    }
  }

  private waitForChannelDrain(channel: RTCDataChannel, signal?: AbortSignal): Promise<void> {
    if (channel.bufferedAmount < MAX_BUFFERED_AMOUNT) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('انقطع الاتصال المباشر أثناء النقل.'));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Upload aborted', 'AbortError'));
      };
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      channel.addEventListener('bufferedamountlow', onLow, { once: true });
      channel.addEventListener('close', onClose, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private teardownPeer(peerId: string): void {
    const slot = this.slots.get(peerId);
    if (!slot) return;
    this.slots.delete(peerId);
    try {
      slot.channel?.close();
    } catch {
      // ignore close errors
    }
    try {
      slot.pc.close();
    } catch {
      // ignore close errors
    }
    this.notifyConnected();
  }

  private notifyConnected(): void {
    if (!this.disposed) {
      this.onConnectedPeersChange(this.getConnectedPeerIds());
    }
  }
}
