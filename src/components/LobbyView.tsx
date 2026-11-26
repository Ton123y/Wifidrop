import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Laptop, Plus, Wifi } from 'lucide-react';
import { fetchNetworkInfo } from '../utils/api.ts';
import { extractRoomCodeFromInput, isValidRoomCode, detectDefaultDeviceName } from '../utils/roomLogic.ts';

interface LobbyViewProps {
  deviceName: string;
  onDeviceNameChange: (name: string) => void;
  onCreateRoom: (roomName: string) => Promise<void>;
  onJoinRoom: (roomCode: string) => Promise<void>;
  creatingRoom: boolean;
  joiningRoom: boolean;
  errorMessage: string | null;
  onClearError: () => void;
}

export function LobbyView({
  deviceName,
  onDeviceNameChange,
  onCreateRoom,
  onJoinRoom,
  creatingRoom,
  joiningRoom,
  errorMessage,
  onClearError,
}: LobbyViewProps) {
  const [roomNameInput, setRoomNameInput] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [localUrls, setLocalUrls] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    fetchNetworkInfo().then((info) => {
      if (active) {
        setLocalUrls(info.localUrls);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    onClearError();
    await onCreateRoom(roomNameInput);
  };

  const handleJoinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    onClearError();
    const normalized = extractRoomCodeFromInput(joinCodeInput);
    if (!isValidRoomCode(normalized)) {
      setLocalError('يرجى إدخال رمز غرفة صحيح مكوّن من 6 أحرف أو أرقام.');
      return;
    }
    await onJoinRoom(normalized);
  };

  const activeError = localError || errorMessage;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-stretch">
        {/* Primary Column: Entry & Room Actions */}
        <section className="flex flex-col justify-between gap-8 lg:col-span-7">
          <div className="space-y-4">
            <h1 className="max-w-xl text-right text-3xl font-bold leading-snug text-slate-900 sm:text-4xl">
              نقل الملفات بين أجهزتك عبر الواي فاي بغرف معزولة
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-slate-600">
              أنشئ غرفة برمز خاص أو انضم إلى غرفة قائمة؛ كل الأجهزة المتصلة بنفس الغرفة ترى وتستقبل نفس الملفات فورياً دون اختلاطها ببقية الشبكة.
            </p>
          </div>

          {activeError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800"
            >
              {activeError}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-6">
            {/* Device Identity */}
            <div>
              <label
                htmlFor="device-name-input"
                className="mb-1.5 block text-sm font-medium text-slate-800"
              >
                اسم هذا الجهاز داخل الغرفة
              </label>
              <div className="relative">
                <Laptop
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="device-name-input"
                  type="text"
                  maxLength={36}
                  value={deviceName}
                  onChange={(e) => onDeviceNameChange(e.target.value)}
                  onBlur={() => {
                    if (!deviceName.trim()) {
                      onDeviceNameChange(
                        detectDefaultDeviceName(typeof navigator !== 'undefined' ? navigator.userAgent : '')
                      );
                    }
                  }}
                  placeholder="مثال: هاتف أحمد أو لابتوب العمل"
                  className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-10 pl-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>
            </div>

            <hr className="border-slate-200" />

            {/* Two Clear Room Paths */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {/* Create Room */}
              <form id="create-room" onSubmit={handleCreateSubmit} className="flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">إنشاء غرفة جديدة</h2>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">
                      توليد رمز خاص من 6 خانات ورمز QR لمشاركته مع أجهزتك.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="room-name-input"
                      className="mb-1 block text-xs font-medium text-slate-700"
                    >
                      اسم الغرفة (اختياري)
                    </label>
                    <input
                      id="room-name-input"
                      type="text"
                      maxLength={48}
                      value={roomNameInput}
                      onChange={(e) => setRoomNameInput(e.target.value)}
                      placeholder="مثال: صور الرحلة"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={creatingRoom || joiningRoom}
                  className="inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>{creatingRoom ? 'جاري إنشاء الغرفة...' : 'إنشاء غرفة جديدة'}</span>
                </button>
              </form>

              {/* Join Room */}
              <form id="join-room" onSubmit={handleJoinSubmit} className="flex flex-col justify-between gap-4 sm:border-r sm:border-slate-200 sm:pr-6">
                <div className="space-y-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">دخول غرفة برمز</h2>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">
                      أدخل الرمز الظاهر على الجهاز الآخر للانضمام لنفس الغرفة.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="room-code-input"
                      className="mb-1 block text-xs font-medium text-slate-700"
                    >
                      رمز الغرفة (6 خانات)
                    </label>
                    <input
                      id="room-code-input"
                      type="text"
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                      value={joinCodeInput}
                      onChange={(e) => {
                        setLocalError(null);
                        onClearError();
                        setJoinCodeInput(extractRoomCodeFromInput(e.target.value));
                      }}
                      placeholder="A7K9M2 أو الصق الرابط"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center font-mono text-base font-semibold tracking-[0.25em] text-slate-900 uppercase placeholder:tracking-normal placeholder:font-normal placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={joiningRoom || creatingRoom}
                  className="inline-flex w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                >
                  <span>{joiningRoom ? 'جاري التحقق...' : 'دخول الغرفة'}</span>
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
              </form>
            </div>
          </div>
        </section>

        {/* Secondary Column: Mechanism & Network Access */}
        <aside
          id="how-it-works"
          className="flex flex-col justify-between gap-6 rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5"
        >
          <div className="space-y-5">
            <div className="flex items-center gap-2.5 text-slate-900">
              <Wifi className="h-5 w-5 text-blue-600" aria-hidden="true" />
              <h2 className="text-base font-semibold">كيف تضمن الغرف عدم تداخل الملفات؟</h2>
            </div>

            <ol className="divide-y divide-slate-200">
              <li className="py-4 first:pt-0">
                <div className="text-sm font-semibold text-slate-900">01. غرفة معزولة برمز فريد</div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  كل غرفة تمتلك معرفاً عشوائياً وقناة بث مستقلة؛ لا يمكن لأي جهاز خارج الغرفة رؤية ملفاتها أو الوصول إليها.
                </p>
              </li>
              <li className="py-4">
                <div className="text-sm font-semibold text-slate-900">02. ربط الأجهزة بالرمز أو الباركود</div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  افتح الغرفة من اللابتوب ثم امسح رمز QR بكاميرا الهاتف أو اكتب الرمز المكوّن من 6 أحرف للانضمام فوراً.
                </p>
              </li>
              <li className="py-4 last:pb-0">
                <div className="text-sm font-semibold text-slate-900">03. وصول فوري لجميع الأجهزة</div>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">
                  عند رفع أي ملف، يظهر في اللحظة نفسها لدى جميع الأجهزة داخل الغرفة مع خيار التنزيل التلقائي أو اليدوي.
                </p>
              </li>
            </ol>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
            <div className="text-xs font-semibold text-slate-700">عنوان الوصول عبر الشبكة</div>
            <p className="text-xs leading-relaxed text-slate-600">
              افتح هذا الرابط على أي جهاز متصل بنفس شبكة الواي فاي للانضمام بسرعة:
            </p>
            <div className="space-y-1 pt-1">
              <div
                dir="ltr"
                className="truncate rounded border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-800"
              >
                {typeof window !== 'undefined' ? window.location.origin : ''}
              </div>
              {localUrls.slice(0, 2).map((url) => (
                <div
                  key={url}
                  dir="ltr"
                  className="truncate rounded border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-600"
                >
                  {url}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
