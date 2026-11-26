import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoomCode,
  extractRoomCodeFromInput,
  isValidRoomCode,
  generateRoomCode,
  formatBytes,
  getFileExtension,
  classifyFileCategory,
  sanitizeDisplayFilename,
  sanitizeRelativePath,
  getFolderNameFromPath,
  getDisplaySubpath,
  upsertRoomFile,
  upsertRoomFiles,
  removeRoomFile,
  removeRoomFiles,
  filterRoomFiles,
  groupRoomEntries,
  detectDefaultDeviceName,
  isPreviewableImageMime,
  selectWsChunkSize,
  WS_LARGE_UPLOAD_CHUNK_SIZE,
  WS_UPLOAD_CHUNK_SIZE,
  calculateChunkCount,
  getChunkByteRange,
  encodeWsChunkFrame,
  encodeWsFastUploadFrame,
  decodeWsChunkFrame,
  decodeWsBinaryFrame,
} from './roomLogic.ts';
import type { RoomFile } from '../types.ts';

test('normalizeRoomCode cleans spaces, hyphens, and lowercases', () => {
  assert.equal(normalizeRoomCode(' ab-12 cd '), 'AB12CD');
  assert.equal(normalizeRoomCode('k9m4p2extra'), 'K9M4P2');
});

test('extractRoomCodeFromInput handles both raw codes and pasted room URLs', () => {
  assert.equal(extractRoomCodeFromInput('http://192.168.1.5:3000/?room=a7k9m2'), 'A7K9M2');
  assert.equal(extractRoomCodeFromInput('https://example.com/?foo=1&room=B4N8Q3&bar=2'), 'B4N8Q3');
  assert.equal(extractRoomCodeFromInput(' x9-p2 k4 '), 'X9P2K4');
});

test('isValidRoomCode validates 6 alphanumeric uppercase chars', () => {
  assert.equal(isValidRoomCode('A7K9M2'), true);
  assert.equal(isValidRoomCode('A7K9M'), false);
  assert.equal(isValidRoomCode('a7k9m2'), false);
  assert.equal(isValidRoomCode('A7K-M2'), false);
});

test('generateRoomCode uses alphabet and produces 6 valid characters', () => {
  const deterministic = generateRoomCode((max) => 0);
  assert.equal(deterministic, 'AAAAAA');
  assert.equal(isValidRoomCode(deterministic), true);

  const random = generateRoomCode();
  assert.equal(isValidRoomCode(random), true);
});

test('formatBytes formats sizes accurately', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

test('classifyFileCategory categorizes images, documents, media, archives, and other', () => {
  assert.equal(classifyFileCategory('image/png', 'photo.png'), 'images');
  assert.equal(classifyFileCategory('application/pdf', 'report.pdf'), 'documents');
  assert.equal(classifyFileCategory('video/mp4', 'clip.mp4'), 'media');
  assert.equal(classifyFileCategory('application/zip', 'bundle.zip'), 'archives');
  assert.equal(classifyFileCategory('application/octet-stream', 'firmware.bin'), 'other');
  assert.equal(getFileExtension('archive.tar.gz'), 'GZ');
  assert.equal(getFileExtension('README'), 'FILE');
});

test('sanitizeDisplayFilename removes traversal and unsafe characters', () => {
  assert.equal(sanitizeDisplayFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(sanitizeDisplayFilename('صورة الرحلة.jpg'), 'صورة الرحلة.jpg');
  assert.equal(sanitizeDisplayFilename('..'), 'unnamed-file');
});

test('sanitizeRelativePath preserves safe folder structure, deep paths >500 chars, and blocks traversal', () => {
  assert.equal(
    sanitizeRelativePath('/MyBackup/../sub\\nested/صورة 1.png'),
    'MyBackup/sub/nested/صورة 1.png'
  );
  assert.equal(sanitizeRelativePath('../../..'), 'unnamed-file');
  assert.equal(getFolderNameFromPath('Project/src/app.ts'), 'Project');
  assert.equal(getFolderNameFromPath('single.txt'), null);
  const deepJavaPath = `MyAndroidApp/app/src/main/java/com/company/project/${'subpackage/'.repeat(45)}MainActivity.kt`;
  assert.ok(deepJavaPath.length > 500 && deepJavaPath.length < 1024);
  assert.equal(sanitizeRelativePath(deepJavaPath), deepJavaPath);
});

test('upsertRoomFile is idempotent and prepends new files', () => {
  const f1: RoomFile = {
    id: 'f1',
    name: 'one.png',
    size: 100,
    mimeType: 'image/png',
    category: 'images',
    senderDeviceId: 'd1',
    senderDeviceName: 'iPhone',
    uploadedAt: 1000,
  };
  const f2: RoomFile = {
    ...f1,
    id: 'f2',
    name: 'two.pdf',
    mimeType: 'application/pdf',
    category: 'documents',
    uploadedAt: 2000,
  };

  let list = upsertRoomFile([], f1);
  list = upsertRoomFile(list, f2);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'f2');

  // Re-applying f1 should not duplicate
  list = upsertRoomFile(list, { ...f1, name: 'one-updated.png' });
  assert.equal(list.length, 2);
  assert.equal(list[1].name, 'one-updated.png');

  list = removeRoomFile(list, 'f1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'f2');
});

test('groupRoomEntries groups folder batches cleanly and preserves standalone files', () => {
  const files: RoomFile[] = [
    {
      id: 'f-standalone',
      name: 'notes.txt',
      size: 50,
      mimeType: 'text/plain',
      category: 'documents',
      senderDeviceId: 'd1',
      senderDeviceName: 'Laptop',
      uploadedAt: 3000,
    },
    {
      id: 'f-b1',
      name: 'b.png',
      relativePath: 'HeavyAssets/images/b.png',
      folderBatchId: 'batch-1',
      size: 1500,
      mimeType: 'image/png',
      category: 'images',
      senderDeviceId: 'd1',
      senderDeviceName: 'Laptop',
      uploadedAt: 2000,
    },
    {
      id: 'f-a1',
      name: 'a.txt',
      relativePath: 'HeavyAssets/a.txt',
      folderBatchId: 'batch-1',
      size: 500,
      mimeType: 'text/plain',
      category: 'documents',
      senderDeviceId: 'd1',
      senderDeviceName: 'Laptop',
      uploadedAt: 2500,
    },
  ];

  const entries = groupRoomEntries(files);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'file');
  assert.equal(entries[1].kind, 'folder');
  if (entries[1].kind === 'folder') {
    assert.equal(entries[1].folderName, 'HeavyAssets');
    assert.equal(entries[1].totalSize, 2000);
    assert.equal(entries[1].files.length, 2);
    assert.equal(getDisplaySubpath(entries[1].files[0]), 'a.txt');
    assert.equal(getDisplaySubpath(entries[1].files[1]), 'images/b.png');
  }

  assert.equal(filterRoomFiles(files, 'HeavyAssets', 'all').length, 2);
  assert.equal(removeRoomFiles(files, ['f-b1', 'f-a1']).length, 1);
});

test('filterRoomFiles filters by category and search query', () => {
  const files: RoomFile[] = [
    {
      id: '1',
      name: 'vacation-photo.jpg',
      size: 2048,
      mimeType: 'image/jpeg',
      category: 'images',
      senderDeviceId: 'd1',
      senderDeviceName: 'iPhone',
      uploadedAt: 100,
    },
    {
      id: '2',
      name: 'invoice.pdf',
      size: 4096,
      mimeType: 'application/pdf',
      category: 'documents',
      senderDeviceId: 'd2',
      senderDeviceName: 'MacBook',
      uploadedAt: 200,
    },
  ];

  assert.equal(filterRoomFiles(files, '', 'all').length, 2);
  assert.equal(filterRoomFiles(files, '', 'images').length, 1);
  assert.equal(filterRoomFiles(files, 'macbook', 'all').length, 1);
  assert.equal(filterRoomFiles(files, 'invoice', 'documents').length, 1);
  assert.equal(filterRoomFiles(files, 'invoice', 'images').length, 0);
});

test('detectDefaultDeviceName and isPreviewableImageMime behave safely', () => {
  assert.equal(detectDefaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'iPhone');
  assert.equal(detectDefaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'كمبيوتر Windows');
  assert.equal(isPreviewableImageMime('image/png'), true);
  assert.equal(isPreviewableImageMime('image/svg+xml'), false);
});

test('handles arbitrary file types including programming languages, project configs, binaries, archives, dotfiles, and extensionless files', () => {
  assert.equal(classifyFileCategory('application/vnd.android.package-archive', 'app-release.apk'), 'other');
  assert.equal(classifyFileCategory('application/x-msdownload', 'setup.exe'), 'other');
  assert.equal(classifyFileCategory('', 'backup.iso'), 'archives');
  assert.equal(classifyFileCategory('', 'release.tar.gz'), 'archives');
  assert.equal(classifyFileCategory('', 'movie.mkv'), 'media');
  assert.equal(classifyFileCategory('', 'vector.svg'), 'images');
  assert.equal(classifyFileCategory('', 'config.yaml'), 'code');
  assert.equal(classifyFileCategory('', 'blueprint.dwg'), 'other');
  assert.equal(classifyFileCategory('', '.env'), 'code');
  assert.equal(classifyFileCategory('', 'Makefile'), 'code');
  assert.equal(classifyFileCategory('', 'Dockerfile'), 'code');
  assert.equal(classifyFileCategory('', 'CMakeLists.txt'), 'code');
  assert.equal(classifyFileCategory('', 'Cargo.toml'), 'code');
  assert.equal(classifyFileCategory('', 'go.mod'), 'code');
  assert.equal(classifyFileCategory('', 'requirements.txt'), 'code');
  assert.equal(classifyFileCategory('', '.gitignore'), 'code');
  assert.equal(classifyFileCategory('', 'app.tsx'), 'code');
  assert.equal(classifyFileCategory('', 'main.py'), 'code');
  assert.equal(classifyFileCategory('', 'notebook.ipynb'), 'code');
  assert.equal(classifyFileCategory('', 'engine.cpp'), 'code');
  assert.equal(classifyFileCategory('', 'Program.cs'), 'code');
  assert.equal(classifyFileCategory('', 'MainActivity.kt'), 'code');
  assert.equal(classifyFileCategory('', 'main.go'), 'code');
  assert.equal(classifyFileCategory('', 'lib.rs'), 'code');
  assert.equal(classifyFileCategory('', 'main.dart'), 'code');
  assert.equal(classifyFileCategory('application/sql', 'schema.sql'), 'code');
  assert.equal(getFileExtension('app-release.apk'), 'APK');
  assert.equal(getFileExtension('setup.exe'), 'EXE');
  assert.equal(getFileExtension('Makefile'), 'FILE');
  assert.equal(getFileExtension('.env'), 'FILE');
  assert.equal(getFileExtension('.env.local'), 'LOCAL');
  assert.equal(getFileExtension('app.webmanifest'), 'WEBMANIFEST');
});

test('upsertRoomFiles batches updates cleanly and selectWsChunkSize scales for large files', () => {
  const base: RoomFile = {
    id: 'a',
    name: 'a.py',
    size: 10,
    mimeType: 'text/x-python',
    category: 'code',
    senderDeviceId: 'd1',
    senderDeviceName: 'Dev',
    uploadedAt: 100,
  };
  const b: RoomFile = { ...base, id: 'b', name: 'b.cpp', uploadedAt: 200 };
  const c: RoomFile = { ...base, id: 'c', name: 'c.dart', uploadedAt: 300 };

  let merged = upsertRoomFiles([base], [b, c, { ...base, size: 99 }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, 'c');
  assert.equal(merged[2].size, 99);

  assert.equal(selectWsChunkSize(5 * 1024 * 1024), WS_UPLOAD_CHUNK_SIZE);
  assert.equal(selectWsChunkSize(150 * 1024 * 1024), WS_LARGE_UPLOAD_CHUNK_SIZE);
});

test('calculateChunkCount and getChunkByteRange split files accurately including 0-byte files', () => {
  assert.equal(calculateChunkCount(0, 100), 1);
  assert.deepEqual(getChunkByteRange(0, 0, 100), { start: 0, end: 0 });
  assert.equal(calculateChunkCount(100, 100), 1);
  assert.equal(calculateChunkCount(250, 100), 3);
  assert.deepEqual(getChunkByteRange(250, 0, 100), { start: 0, end: 100 });
  assert.deepEqual(getChunkByteRange(250, 1, 100), { start: 100, end: 200 });
  assert.deepEqual(getChunkByteRange(250, 2, 100), { start: 200, end: 250 });
});

test('encodeWsChunkFrame and decodeWsChunkFrame round-trip binary payloads and reject corrupted frames', () => {
  const payload = new Uint8Array([10, 20, 30, 40, 255]);
  const frame = encodeWsChunkFrame({ uploadId: 'up-123', chunkIndex: 4 }, payload);
  const decoded = decodeWsChunkFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.header.uploadId, 'up-123');
  assert.equal(decoded.header.chunkIndex, 4);
  assert.deepEqual(Array.from(decoded.payload), [10, 20, 30, 40, 255]);

  // Empty 0-byte chunk payload is valid
  const emptyFrame = encodeWsChunkFrame({ uploadId: 'up-empty', chunkIndex: 0 }, new Uint8Array(0));
  const emptyDecoded = decodeWsChunkFrame(emptyFrame);
  assert.ok(emptyDecoded);
  assert.equal(emptyDecoded.payload.byteLength, 0);

  // Corrupted/truncated frames return null safely
  assert.equal(decodeWsChunkFrame(new Uint8Array([0, 1])), null);
  assert.equal(decodeWsChunkFrame(new Uint8Array([0, 0, 5, 0, 1, 2])), null);
});

test('encodeWsFastUploadFrame and decodeWsBinaryFrame round-trip 1-RTT small files', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const frame = encodeWsFastUploadFrame(
    {
      clientUploadId: 'fast-1',
      fileName: 'main.py',
      relativePath: 'MyProject/src/main.py',
      folderBatchId: 'batch-42',
      fileSize: payload.byteLength,
      mimeType: 'text/x-python',
      deviceId: 'dev-1',
      deviceName: 'Mac',
    },
    payload
  );
  // Existing decodeWsChunkFrame safely ignores non-chunk fast frames
  assert.equal(decodeWsChunkFrame(frame), null);

  const decoded = decodeWsBinaryFrame(frame);
  assert.ok(decoded && decoded.kind === 'fast');
  assert.equal(decoded.header.clientUploadId, 'fast-1');
  assert.equal(decoded.header.fileName, 'main.py');
  assert.equal(decoded.header.relativePath, 'MyProject/src/main.py');
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 4, 5, 6]);
});
