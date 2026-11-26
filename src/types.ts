export type FileCategory = 'images' | 'documents' | 'code' | 'media' | 'archives' | 'other';

export interface RoomFile {
  id: string;
  name: string;
  relativePath?: string;
  folderBatchId?: string;
  size: number;
  mimeType: string;
  category: FileCategory;
  senderDeviceId: string;
  senderDeviceName: string;
  uploadedAt: number;
  localObjectUrl?: string;
  isDirectP2P?: boolean;
}

export interface RoomPeer {
  deviceId: string;
  deviceName: string;
  joinedAt: number;
}

export interface RoomSnapshot {
  code: string;
  roomName: string;
  createdAt: number;
  files: RoomFile[];
  peers: RoomPeer[];
}

export interface RtcSignalPayload {
  sdp?: { type: 'offer' | 'answer'; sdp?: string };
  candidate?: {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
}

export type WsClientMessage =
  | {
      type: 'join';
      roomCode: string;
      deviceId: string;
      deviceName: string;
    }
  | {
      type: 'peer:rename';
      deviceName: string;
    }
  | {
      type: 'upload:init';
      clientUploadId: string;
      fileName: string;
      relativePath?: string;
      folderBatchId?: string;
      fileSize: number;
      mimeType: string;
      chunkSize: number;
      totalChunks: number;
      deviceId: string;
      deviceName: string;
    }
  | {
      type: 'upload:complete';
      uploadId: string;
    }
  | {
      type: 'upload:abort';
      uploadId: string;
    }
  | {
      type: 'rtc:signal';
      targetDeviceId: string;
      signal: RtcSignalPayload;
    };

export type WsServerMessage =
  | {
      type: 'room:state';
      room: RoomSnapshot;
    }
  | {
      type: 'peers:updated';
      peers: RoomPeer[];
    }
  | {
      type: 'file:added';
      file: RoomFile;
    }
  | {
      type: 'file:removed';
      fileId: string;
    }
  | {
      type: 'files:removed';
      fileIds: string[];
    }
  | {
      type: 'upload:ready';
      clientUploadId: string;
      uploadId: string;
    }
  | {
      type: 'upload:ack';
      uploadId: string;
      chunkIndex: number;
      received: number;
    }
  | {
      type: 'upload:done';
      uploadId: string;
      file: RoomFile;
    }
  | {
      type: 'upload:fast-done';
      clientUploadId: string;
      file: RoomFile;
    }
  | {
      type: 'upload:error';
      uploadId?: string;
      clientUploadId?: string;
      message: string;
    }
  | {
      type: 'rtc:signal';
      fromDeviceId: string;
      signal: RtcSignalPayload;
    }
  | {
      type: 'error';
      message: string;
    };
