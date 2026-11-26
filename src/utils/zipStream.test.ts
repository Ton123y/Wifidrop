import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deduplicateZipPaths, streamZipArchive } from './zipStream.ts';

test('deduplicateZipPaths resolves colliding paths deterministically', () => {
  const result = deduplicateZipPaths([
    { archivePath: '/folder/a.txt', filePath: '/tmp/1', size: 1 },
    { archivePath: 'folder/a.txt', filePath: '/tmp/2', size: 1 },
    { archivePath: 'folder/a.txt', filePath: '/tmp/3', size: 1 },
  ]);
  assert.deepEqual(
    result.map((e) => e.archivePath),
    ['folder/a.txt', 'folder/a (2).txt', 'folder/a (3).txt']
  );
});

test('streamZipArchive produces valid PKZIP archive with nested Unicode and binary files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wifidrop-zip-test-'));
  try {
    const file1Path = path.join(tmpDir, 'f1.txt');
    const file2Path = path.join(tmpDir, 'f2.bin');
    const emptyPath = path.join(tmpDir, 'empty.dat');
    const zipPath = path.join(tmpDir, 'archive.zip');

    const textPayload = Buffer.from('مرحبا بكم في اختبار المجلد الثقيل!', 'utf8');
    const binaryPayload = crypto.randomBytes(1500 * 1024); // 1.5 MB random binary

    fs.writeFileSync(file1Path, textPayload);
    fs.writeFileSync(file2Path, binaryPayload);
    fs.writeFileSync(emptyPath, Buffer.alloc(0));

    const writeStream = fs.createWriteStream(zipPath);
    await streamZipArchive(
      [
        { archivePath: 'MyFolder/وثيقة عربية.txt', filePath: file1Path, size: textPayload.length },
        { archivePath: 'MyFolder/deep/sub/data.bin', filePath: file2Path, size: binaryPayload.length },
        { archivePath: 'MyFolder/empty.dat', filePath: emptyPath, size: 0 },
      ],
      writeStream
    );

    const zipBytes = fs.readFileSync(zipPath);
    // Verify PK header and EOCD magic signatures
    assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
    assert.equal(zipBytes.readUInt32LE(zipBytes.length - 22), 0x06054b50);

    // Cross-verify full archive integrity & contents with Python's standard zipfile module
    const verifyOut = execFileSync(
      'python3',
      [
        '-c',
        `import zipfile, hashlib, sys
with zipfile.ZipFile(sys.argv[1], 'r') as z:
    bad = z.testzip()
    assert bad is None, f"CRC mismatch: {bad}"
    names = z.namelist()
    assert names == ['MyFolder/وثيقة عربية.txt', 'MyFolder/deep/sub/data.bin', 'MyFolder/empty.dat'], names
    assert z.read('MyFolder/وثيقة عربية.txt').decode('utf-8') == 'مرحبا بكم في اختبار المجلد الثقيل!'
    assert z.read('MyFolder/empty.dat') == b''
    print(hashlib.sha256(z.read('MyFolder/deep/sub/data.bin')).hexdigest())
`,
        zipPath,
      ],
      { encoding: 'utf8' }
    ).trim();

    const expectedSha = crypto.createHash('sha256').update(binaryPayload).digest('hex');
    assert.equal(verifyOut, expectedSha);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
