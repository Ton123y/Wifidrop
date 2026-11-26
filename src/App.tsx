import { useCallback, useEffect, useState } from 'react';
import { LobbyView } from './components/LobbyView.tsx';
import { RoomWorkspace } from './components/RoomWorkspace.tsx';
import { TopBar } from './components/TopBar.tsx';
import type { RoomSnapshot } from './types.ts';
import {
  copyTextToClipboard,
  createRoom,
  fetchRoom,
  getOrCreateDeviceId,
  getSavedDeviceName,
  saveDeviceName,
} from './utils/api.ts';
import { detectDefaultDeviceName, isValidRoomCode, normalizeRoomCode } from './utils/roomLogic.ts';

function readRoomCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('room');
  if (!raw) return null;
  const normalized = normalizeRoomCode(raw);
  return isValidRoomCode(normalized) ? normalized : null;
}

function updateRoomUrl(code: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (code) {
    url.searchParams.set('room', code);
  } else {
    url.searchParams.delete('room');
  }
  window.history.pushState({}, '', url.toString());
}

export default function App() {
  const [deviceId] = useState<string>(() => getOrCreateDeviceId());
  const [deviceName, setDeviceName] = useState<string>(() => getSavedDeviceName());

  const [activeRoom, setActiveRoom] = useState<RoomSnapshot | null>(null);
  const [loadingRoom, setLoadingRoom] = useState<boolean>(() => Boolean(readRoomCodeFromUrl()));
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleDeviceNameChange = useCallback((nextName: string) => {
    setDeviceName(nextName);
    saveDeviceName(nextName);
  }, []);

  const ensureDeviceName = useCallback(() => {
    if (!deviceName.trim()) {
      const fallback = detectDefaultDeviceName(typeof navigator !== 'undefined' ? navigator.userAgent : '');
      setDeviceName(fallback);
      saveDeviceName(fallback);
    }
  }, [deviceName]);

  const enterRoomByCode = useCallback(async (code: string, pushHistory = true) => {
    setJoiningRoom(true);
    setErrorMessage(null);
    ensureDeviceName();
    try {
      const snapshot = await fetchRoom(code);
      setActiveRoom(snapshot);
      if (pushHistory) {
        updateRoomUrl(snapshot.code);
      }
    } catch (err) {
      setActiveRoom(null);
      updateRoomUrl(null);
      setErrorMessage(err instanceof Error ? err.message : 'تعذر الانضمام إلى الغرفة.');
    } finally {
      setJoiningRoom(false);
      setLoadingRoom(false);
    }
  }, [ensureDeviceName]);

  // Sync with ?room= query parameter on load and browser back/forward
  useEffect(() => {
    const initialCode = readRoomCodeFromUrl();
    if (initialCode) {
      void enterRoomByCode(initialCode, false);
    } else {
      setLoadingRoom(false);
    }

    const onPopState = () => {
      const nextCode = readRoomCodeFromUrl();
      if (nextCode) {
        void enterRoomByCode(nextCode, false);
      } else {
        setActiveRoom(null);
        setErrorMessage(null);
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [enterRoomByCode]);

  const handleCreateRoom = useCallback(async (roomName = '') => {
    setCreatingRoom(true);
    setErrorMessage(null);
    ensureDeviceName();
    try {
      const snapshot = await createRoom(roomName);
      setActiveRoom(snapshot);
      updateRoomUrl(snapshot.code);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'تعذر إنشاء الغرفة.');
    } finally {
      setCreatingRoom(false);
    }
  }, [ensureDeviceName]);

  const handleLeaveRoom = useCallback(() => {
    setActiveRoom(null);
    setErrorMessage(null);
    updateRoomUrl(null);
  }, []);

  const handleCopyRoomLink = useCallback(async () => {
    if (!activeRoom) return;
    const url = new URL(window.location.href);
    url.search = `?room=${activeRoom.code}`;
    url.hash = '';
    const ok = await copyTextToClipboard(url.toString());
    if (ok) {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    }
  }, [activeRoom]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <TopBar
        activeRoomCode={activeRoom?.code || null}
        onGoHome={handleLeaveRoom}
        onQuickCreateRoom={() => void handleCreateRoom('')}
        onCopyRoomLink={() => void handleCopyRoomLink()}
        linkCopied={linkCopied}
        creatingRoom={creatingRoom}
      />

      {loadingRoom ? (
        <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
            جاري الاتصال بالغرفة...
          </div>
        </main>
      ) : activeRoom ? (
        <RoomWorkspace
          initialRoom={activeRoom}
          deviceId={deviceId}
          deviceName={deviceName}
          onDeviceNameChange={handleDeviceNameChange}
          onLeaveRoom={handleLeaveRoom}
          onCopySuccess={() => {
            setLinkCopied(true);
            window.setTimeout(() => setLinkCopied(false), 1800);
          }}
        />
      ) : (
        <LobbyView
          deviceName={deviceName}
          onDeviceNameChange={handleDeviceNameChange}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={(code) => enterRoomByCode(code, true)}
          creatingRoom={creatingRoom}
          joiningRoom={joiningRoom}
          errorMessage={errorMessage}
          onClearError={() => setErrorMessage(null)}
        />
      )}
    </div>
  );
}
