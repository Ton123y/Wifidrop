import { useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Download,
  File as FileIcon,
  FileCode2,
  FileText,
  Film,
  Folder,
  FolderUp,
  Image as ImageIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import type { FileCategory, RoomFile } from '../types.ts';
import { getFileDownloadUrl, getFolderDownloadUrl } from '../utils/api.ts';
import {
  formatBytes,
  formatTimeLabel,
  getDisplaySubpath,
  getFileExtension,
  isPreviewableImageMime,
  type RoomDisplayEntry,
} from '../utils/roomLogic.ts';

interface RoomFilesListProps {
  roomCode: string;
  entries: RoomDisplayEntry[];
  totalFilesCount: number;
  filteredFilesCount: number;
  hasActiveFilter: boolean;
  deletingIds: Record<string, boolean>;
  deletingFolderIds: Record<string, boolean>;
  onDeleteFile: (file: RoomFile) => void;
  onDeleteFolder: (batchId: string, files: RoomFile[]) => void;
  onClearFilter: () => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
}

const INITIAL_FOLDER_ITEMS_LIMIT = 80;

function renderCategoryIcon(category: FileCategory, small = false) {
  const sizeClass = small ? 'h-4 w-4' : 'h-5 w-5';
  switch (category) {
    case 'images':
      return <ImageIcon className={`${sizeClass} text-blue-600`} aria-hidden="true" />;
    case 'code':
      return <FileCode2 className={`${sizeClass} text-emerald-600`} aria-hidden="true" />;
    case 'documents':
      return <FileText className={`${sizeClass} text-slate-700`} aria-hidden="true" />;
    case 'media':
      return <Film className={`${sizeClass} text-indigo-600`} aria-hidden="true" />;
    case 'archives':
      return <Archive className={`${sizeClass} text-amber-600`} aria-hidden="true" />;
    default:
      return <FileIcon className={`${sizeClass} text-slate-500`} aria-hidden="true" />;
  }
}

function triggerLocalFileDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function RoomFilesList({
  roomCode,
  entries,
  totalFilesCount,
  filteredFilesCount,
  hasActiveFilter,
  deletingIds,
  deletingFolderIds,
  onDeleteFile,
  onDeleteFolder,
  onClearFilter,
  onChooseFiles,
  onChooseFolder,
}: RoomFilesListProps) {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [folderVisibleLimits, setFolderVisibleLimits] = useState<Record<string, number>>({});

  const toggleFolder = (batchId: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [batchId]: !prev[batchId],
    }));
  };

  if (totalFilesCount === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
        <p className="text-sm font-medium text-slate-800">
          لا توجد ملفات في هذه الغرفة بعد
        </p>
        <p className="mt-1 text-xs text-slate-500">
          ارفع ملفاً أو مجلداً كاملاً من هذا الجهاز أو من أي جهاز آخر ليظهر هنا فوراً للجميع.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onChooseFiles}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span>اختيار ملفات</span>
          </button>
          <button
            type="button"
            onClick={onChooseFolder}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors"
          >
            <FolderUp className="h-3.5 w-3.5" aria-hidden="true" />
            <span>اختيار مجلد كامل</span>
          </button>
        </div>
      </div>
    );
  }

  if (filteredFilesCount === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-slate-800">
          لا توجد ملفات مطابقة لمعايير البحث الحالية
        </p>
        <button
          type="button"
          onClick={onClearFilter}
          className="mt-3 cursor-pointer text-xs font-medium text-blue-600 hover:underline"
        >
          مسح التصفية
        </button>
      </div>
    );
  }

  return (
    <ul
      data-testid="room-files-list"
      className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white"
    >
      {entries.map((entry) => {
        if (entry.kind === 'folder') {
          const isExpanded = Boolean(expandedFolders[entry.batchId]) || hasActiveFilter;
          const isDeletingFolder = Boolean(deletingFolderIds[entry.batchId]);
          const limit = folderVisibleLimits[entry.batchId] ?? INITIAL_FOLDER_ITEMS_LIMIT;
          const visibleFiles = isExpanded ? entry.files.slice(0, limit) : [];
          const remainingCount = Math.max(0, entry.files.length - visibleFiles.length);

          return (
            <li
              key={`folder-${entry.batchId}`}
              data-testid={`folder-entry-${entry.batchId}`}
              className="bg-white"
            >
              <div className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700">
                    <Folder className="h-5 w-5" aria-hidden="true" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div
                      dir="auto"
                      title={entry.folderName}
                      className="truncate text-sm font-semibold text-slate-900 text-right"
                    >
                      {entry.folderName}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <span className="font-medium text-blue-700">مجلد</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{entry.files.length} ملف</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className="inline-block font-mono tabular-nums [unicode-bidi:isolate]"
                        dir="ltr"
                      >
                        {formatBytes(entry.totalSize)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>مرسل من {entry.senderDeviceName}</span>
                      {entry.isDirectP2P && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-blue-700">نقل مباشر P2P</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatTimeLabel(entry.uploadedAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap shrink-0 items-center gap-2 self-end sm:self-center">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => toggleFolder(entry.batchId)}
                    className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{isExpanded ? 'إخفاء الملفات' : 'عرض الملفات'}</span>
                  </button>

                  {!entry.isDirectP2P ? (
                    <a
                      href={getFolderDownloadUrl(roomCode, entry.batchId)}
                      download={`${entry.folderName}.zip`}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>تنزيل ZIP</span>
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        entry.files.forEach((f, idx) => {
                          if (f.localObjectUrl) {
                            window.setTimeout(() => {
                              triggerLocalFileDownload(f.localObjectUrl!, f.name);
                            }, idx * 150);
                          }
                        });
                      }}
                      className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>تنزيل الكل</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isDeletingFolder}
                    aria-label={`حذف مجلد ${entry.folderName}`}
                    onClick={() => onDeleteFolder(entry.batchId, entry.files)}
                    className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-2">
                  <ul className="divide-y divide-slate-200/70">
                    {visibleFiles.map((file) => {
                      const downloadHref =
                        file.localObjectUrl || getFileDownloadUrl(roomCode, file.id);
                      const ext = getFileExtension(file.name);
                      const isDeleting = Boolean(deletingIds[file.id]);
                      const subpath = getDisplaySubpath(file);

                      return (
                        <li
                          key={file.id}
                          className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white">
                              {renderCategoryIcon(file.category, true)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div
                                dir="auto"
                                title={file.relativePath || file.name}
                                className="truncate text-xs font-medium text-slate-800"
                              >
                                {subpath}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                                <span
                                  className="inline-block font-mono tabular-nums [unicode-bidi:isolate]"
                                  dir="ltr"
                                >
                                  {formatBytes(file.size)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono">{ext}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-center">
                            <a
                              href={downloadHref}
                              download={file.name}
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-800 hover:bg-slate-100 transition-colors"
                            >
                              <Download className="h-3 w-3" aria-hidden="true" />
                              <span>تنزيل</span>
                            </a>
                            <button
                              type="button"
                              disabled={isDeleting}
                              aria-label={`حذف ${file.name}`}
                              onClick={() => onDeleteFile(file)}
                              className="inline-flex cursor-pointer items-center justify-center rounded-md border border-slate-200 bg-white p-1.5 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {remainingCount > 0 && (
                    <div className="pt-2 pb-1 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setFolderVisibleLimits((prev) => ({
                            ...prev,
                            [entry.batchId]: limit + INITIAL_FOLDER_ITEMS_LIMIT,
                          }))
                        }
                        className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        عرض المزيد ({remainingCount} ملف متبقٍ)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        }

        const { file } = entry;
        const downloadHref = file.localObjectUrl || getFileDownloadUrl(roomCode, file.id);
        const previewHref = isPreviewableImageMime(file.mimeType)
          ? file.localObjectUrl || getFileDownloadUrl(roomCode, file.id, true)
          : null;
        const ext = getFileExtension(file.name);
        const isDeleting = Boolean(deletingIds[file.id]);

        return (
          <li
            key={file.id}
            className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3.5">
              {previewHref ? (
                <img
                  src={previewHref}
                  alt={file.name}
                  referrerPolicy="no-referrer"
                  className="h-11 w-11 shrink-0 rounded-lg border border-slate-200 object-cover bg-slate-100"
                />
              ) : (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50">
                  {renderCategoryIcon(file.category)}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div
                  dir="auto"
                  title={file.relativePath || file.name}
                  className="truncate text-sm font-semibold text-slate-900 text-right"
                >
                  {file.name}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span
                    className="inline-block font-mono tabular-nums [unicode-bidi:isolate]"
                    dir="ltr"
                  >
                    {formatBytes(file.size)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{ext}</span>
                  <span aria-hidden="true">·</span>
                  <span>مرسل من {file.senderDeviceName}</span>
                  {file.isDirectP2P && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-blue-700">نقل مباشر P2P</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatTimeLabel(file.uploadedAt)}</span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
              <a
                href={downloadHref}
                download={file.name}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>تنزيل</span>
              </a>
              <button
                type="button"
                disabled={isDeleting}
                aria-label={`حذف ${file.name}`}
                onClick={() => onDeleteFile(file)}
                className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 transition-colors"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
