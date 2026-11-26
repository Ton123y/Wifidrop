import { Check, Copy, Plus } from 'lucide-react';

interface TopBarProps {
  activeRoomCode: string | null;
  onGoHome: () => void;
  onQuickCreateRoom: () => void;
  onCopyRoomLink?: () => void;
  linkCopied?: boolean;
  creatingRoom?: boolean;
}

export function TopBar({
  activeRoomCode,
  onGoHome,
  onQuickCreateRoom,
  onCopyRoomLink,
  linkCopied = false,
  creatingRoom = false,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
        {/* Zone 1: Single-element brand wordmark */}
        <button
          type="button"
          onClick={onGoHome}
          className="cursor-pointer whitespace-nowrap shrink-0 text-lg font-bold tracking-tight text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600"
        >
          WiFiDrop
        </button>

        {/* Zone 2: Clean single-line navigation links */}
        <nav aria-label="التنقل الرئيسي" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          {activeRoomCode ? (
            <>
              <button
                type="button"
                onClick={onGoHome}
                className="cursor-pointer whitespace-nowrap shrink-0 hover:text-slate-900 hover:underline underline-offset-4 transition-colors"
              >
                الرئيسية
              </button>
              <span aria-hidden="true" className="text-slate-300">/</span>
              <span className="whitespace-nowrap shrink-0 text-slate-900 font-semibold">
                غرفة <span className="font-mono" dir="ltr">{activeRoomCode}</span>
              </span>
            </>
          ) : (
            <>
              <a
                href="#create-room"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 hover:underline underline-offset-4 transition-colors"
              >
                إنشاء غرفة
              </a>
              <a
                href="#join-room"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 hover:underline underline-offset-4 transition-colors"
              >
                دخول برمز
              </a>
              <a
                href="#how-it-works"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 hover:underline underline-offset-4 transition-colors"
              >
                كيف يعمل
              </a>
            </>
          )}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          {activeRoomCode && onCopyRoomLink ? (
            <button
              type="button"
              onClick={onCopyRoomLink}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-blue-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              {linkCopied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              <span>{linkCopied ? 'تم نسخ الرابط' : 'نسخ رابط الغرفة'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onQuickCreateRoom}
              disabled={creatingRoom}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-xs sm:text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>{creatingRoom ? 'جاري الإنشاء...' : 'غرفة جديدة'}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
