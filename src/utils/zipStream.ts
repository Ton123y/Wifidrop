import fs from 'node:fs';
import { Writable } from 'node:stream';
import zlib from 'node:zlib';

export interface ZipSourceEntry {
  archivePath: string;
  filePath: string;
  size: number;
  mtimeMs?: number;
}

interface CentralDirRecord {
  nameBuf: Buffer;
  crc32: number;
  size: bigint;
  offset: bigint;
  dosTime: number;
  dosDate: number;
  needsZip64: boolean;
}

const UINT32_MAX = 0xffffffffn;
const UINT16_MAX = 0xffff;

function toDosDateTime(mtimeMs: number): { dosTime: number; dosDate: number } {
  const date = new Date(mtimeMs || Date.now());
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

export function deduplicateZipPaths(entries: ZipSourceEntry[]): ZipSourceEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const clean = entry.archivePath.replace(/^\/+/, '') || 'unnamed-file';
    if (!seen.has(clean)) {
      seen.add(clean);
      return { ...entry, archivePath: clean };
    }
    const lastSlash = clean.lastIndexOf('/');
    const dir = lastSlash >= 0 ? clean.slice(0, lastSlash + 1) : '';
    const base = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';

    let counter = 2;
    let candidate = `${dir}${stem} (${counter})${ext}`;
    while (seen.has(candidate)) {
      counter += 1;
      candidate = `${dir}${stem} (${counter})${ext}`;
    }
    seen.add(candidate);
    return { ...entry, archivePath: candidate };
  });
}

async function writeWithBackpressure(dest: Writable, chunk: Buffer): Promise<void> {
  if (dest.destroyed || dest.writableEnded) {
    throw new Error('Destination stream closed');
  }
  const ok = dest.write(chunk);
  if (!ok) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        dest.off('drain', onDrain);
        dest.off('close', onClose);
        dest.off('error', onError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Destination stream closed'));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      dest.once('drain', onDrain);
      dest.once('close', onClose);
      dest.once('error', onError);
    });
  }
}

export async function streamZipArchive(
  rawEntries: ZipSourceEntry[],
  dest: Writable,
  signal?: AbortSignal
): Promise<void> {
  const entries = deduplicateZipPaths(rawEntries);
  const centralRecords: CentralDirRecord[] = [];
  let offset = 0n;

  for (const entry of entries) {
    if (signal?.aborted || dest.destroyed) {
      throw new Error('Archive stream aborted');
    }

    const stat = await fs.promises.stat(entry.filePath);
    const actualSize = BigInt(stat.size);
    const fileUsesZip64 = actualSize >= UINT32_MAX;
    const offsetUsesZip64 = offset >= UINT32_MAX;
    const nameBuf = Buffer.from(entry.archivePath, 'utf8');
    const { dosTime, dosDate } = toDosDateTime(entry.mtimeMs ?? stat.mtimeMs);
    const entryOffset = offset;

    // 30-byte Local File Header + optional 20-byte ZIP64 extra field
    const lfhExtraLen = fileUsesZip64 ? 20 : 0;
    const lfh = Buffer.allocUnsafe(30 + nameBuf.length + lfhExtraLen);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(fileUsesZip64 ? 45 : 20, 4); // version needed
    lfh.writeUInt16LE(0x0808, 6); // bit 3 (data descriptor) + bit 11 (UTF-8)
    lfh.writeUInt16LE(0, 8); // compression method: STORE
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(0, 14); // crc-32 (deferred to data descriptor)
    lfh.writeUInt32LE(fileUsesZip64 ? 0xffffffff : 0, 18);
    lfh.writeUInt32LE(fileUsesZip64 ? 0xffffffff : 0, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(lfhExtraLen, 28);
    nameBuf.copy(lfh, 30);

    if (fileUsesZip64) {
      const extPos = 30 + nameBuf.length;
      lfh.writeUInt16LE(0x0001, extPos); // ZIP64 tag
      lfh.writeUInt16LE(16, extPos + 2);
      lfh.writeBigUInt64LE(0n, extPos + 4);
      lfh.writeBigUInt64LE(0n, extPos + 12);
    }

    await writeWithBackpressure(dest, lfh);
    offset += BigInt(lfh.length);

    let crc = 0;
    let streamedBytes = 0n;

    if (actualSize > 0n) {
      const readStream = fs.createReadStream(entry.filePath, { highWaterMark: 512 * 1024 });
      const abortRead = () => {
        readStream.destroy();
      };
      signal?.addEventListener('abort', abortRead, { once: true });
      try {
        for await (const chunk of readStream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          crc = zlib.crc32(buf, crc);
          streamedBytes += BigInt(buf.length);
          await writeWithBackpressure(dest, buf);
        }
      } finally {
        signal?.removeEventListener('abort', abortRead);
      }
    }
    offset += streamedBytes;

    // Data Descriptor (16 bytes standard, 24 bytes for ZIP64 file)
    if (fileUsesZip64) {
      const dd = Buffer.allocUnsafe(24);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc >>> 0, 4);
      dd.writeBigUInt64LE(streamedBytes, 8);
      dd.writeBigUInt64LE(streamedBytes, 16);
      await writeWithBackpressure(dest, dd);
      offset += 24n;
    } else {
      const dd = Buffer.allocUnsafe(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc >>> 0, 4);
      dd.writeUInt32LE(Number(streamedBytes), 8);
      dd.writeUInt32LE(Number(streamedBytes), 12);
      await writeWithBackpressure(dest, dd);
      offset += 16n;
    }

    centralRecords.push({
      nameBuf,
      crc32: crc >>> 0,
      size: streamedBytes,
      offset: entryOffset,
      dosTime,
      dosDate,
      needsZip64: fileUsesZip64 || offsetUsesZip64,
    });
  }

  const cdStartOffset = offset;
  let cdSize = 0n;

  for (const rec of centralRecords) {
    const zip64Values: bigint[] = [];
    const sizeOverflow = rec.size >= UINT32_MAX;
    const offsetOverflow = rec.offset >= UINT32_MAX;
    if (sizeOverflow) {
      zip64Values.push(rec.size, rec.size);
    }
    if (offsetOverflow) {
      zip64Values.push(rec.offset);
    }

    const extraLen = zip64Values.length > 0 ? 4 + zip64Values.length * 8 : 0;
    const cd = Buffer.allocUnsafe(46 + rec.nameBuf.length + extraLen);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(rec.needsZip64 ? 45 : 20, 4); // version made by
    cd.writeUInt16LE(rec.needsZip64 ? 45 : 20, 6); // version needed
    cd.writeUInt16LE(0x0808, 8); // bit 3 + UTF-8
    cd.writeUInt16LE(0, 10); // STORE
    cd.writeUInt16LE(rec.dosTime, 12);
    cd.writeUInt16LE(rec.dosDate, 14);
    cd.writeUInt32LE(rec.crc32, 16);
    cd.writeUInt32LE(sizeOverflow ? 0xffffffff : Number(rec.size), 20);
    cd.writeUInt32LE(sizeOverflow ? 0xffffffff : Number(rec.size), 24);
    cd.writeUInt16LE(rec.nameBuf.length, 28);
    cd.writeUInt16LE(extraLen, 30);
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offsetOverflow ? 0xffffffff : Number(rec.offset), 42);
    rec.nameBuf.copy(cd, 46);

    if (extraLen > 0) {
      let pos = 46 + rec.nameBuf.length;
      cd.writeUInt16LE(0x0001, pos);
      cd.writeUInt16LE(zip64Values.length * 8, pos + 2);
      pos += 4;
      for (const val of zip64Values) {
        cd.writeBigUInt64LE(val, pos);
        pos += 8;
      }
    }

    await writeWithBackpressure(dest, cd);
    cdSize += BigInt(cd.length);
  }

  const totalCount = centralRecords.length;
  const archiveNeedsZip64 =
    totalCount >= UINT16_MAX || cdSize >= UINT32_MAX || cdStartOffset >= UINT32_MAX;

  if (archiveNeedsZip64) {
    const zip64EocdOffset = cdStartOffset + cdSize;
    const z64Eocd = Buffer.allocUnsafe(56);
    z64Eocd.writeUInt32LE(0x06064b50, 0);
    z64Eocd.writeBigUInt64LE(44n, 4);
    z64Eocd.writeUInt16LE(45, 12);
    z64Eocd.writeUInt16LE(45, 14);
    z64Eocd.writeUInt32LE(0, 16);
    z64Eocd.writeUInt32LE(0, 20);
    z64Eocd.writeBigUInt64LE(BigInt(totalCount), 24);
    z64Eocd.writeBigUInt64LE(BigInt(totalCount), 32);
    z64Eocd.writeBigUInt64LE(cdSize, 40);
    z64Eocd.writeBigUInt64LE(cdStartOffset, 48);
    await writeWithBackpressure(dest, z64Eocd);

    const z64Loc = Buffer.allocUnsafe(20);
    z64Loc.writeUInt32LE(0x07064b50, 0);
    z64Loc.writeUInt32LE(0, 4);
    z64Loc.writeBigUInt64LE(zip64EocdOffset, 8);
    z64Loc.writeUInt32LE(1, 16);
    await writeWithBackpressure(dest, z64Loc);
  }

  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalCount >= UINT16_MAX ? UINT16_MAX : totalCount, 8);
  eocd.writeUInt16LE(totalCount >= UINT16_MAX ? UINT16_MAX : totalCount, 10);
  eocd.writeUInt32LE(cdSize >= UINT32_MAX ? 0xffffffff : Number(cdSize), 12);
  eocd.writeUInt32LE(cdStartOffset >= UINT32_MAX ? 0xffffffff : Number(cdStartOffset), 16);
  eocd.writeUInt16LE(0, 20);
  await writeWithBackpressure(dest, eocd);

  if (!dest.destroyed && !dest.writableEnded) {
    await new Promise<void>((resolve, reject) => {
      dest.once('error', reject);
      dest.end(() => resolve());
    });
  }
}
