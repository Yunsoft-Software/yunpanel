import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, packZip, unpackZip } from '../src/workspace/ui/zip-util.js';

test('crc32 produces standard IEEE 802.3 checksums', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  const testBytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(testBytes), 0xcbf43926);
});

test('packZip and unpackZip round-trip preserves file names and contents', async () => {
  const file1 = { path: 'index.html', data: new TextEncoder().encode('<!DOCTYPE html><html><body>Hello</body></html>') };
  const file2 = { path: 'css/style.css', data: new TextEncoder().encode('body { margin: 0; }') };
  const dir = { path: 'empty-dir', isDir: true };

  const zipBytes = packZip([file1, file2, dir]);
  assert.ok(zipBytes.length > 0);

  const unpacked = await unpackZip(zipBytes);
  assert.equal(unpacked.length, 3);

  const unpackedFile1 = unpacked.find((e) => e.path === 'index.html');
  assert.ok(unpackedFile1);
  assert.equal(unpackedFile1.isDir, false);
  assert.deepEqual(unpackedFile1.data, file1.data);

  const unpackedFile2 = unpacked.find((e) => e.path === 'css/style.css');
  assert.ok(unpackedFile2);
  assert.equal(unpackedFile2.isDir, false);
  assert.deepEqual(unpackedFile2.data, file2.data);

  const unpackedDir = unpacked.find((e) => e.path === 'empty-dir');
  assert.ok(unpackedDir);
  assert.equal(unpackedDir.isDir, true);
});

test('packZip and unpackZip round-trip preserves arbitrary binary data', async () => {
  const binaryData = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x12, 0x34, 0x56, 0xaa, 0x55]);
  const entry = { path: 'binary.dat', data: binaryData };

  const zipBytes = packZip([entry]);
  const unpacked = await unpackZip(zipBytes);

  assert.equal(unpacked.length, 1);
  assert.deepEqual(unpacked[0].data, binaryData);
});

test('unpackZip rejects path traversal attacks', async () => {
  // Construct a ZIP with a path traversal entry: '../secret.txt'
  const maliciousEntry = { path: '../secret.txt', data: new TextEncoder().encode('secret') };
  const zipBytes = packZip([maliciousEntry]);

  await assert.rejects(
    async () => unpackZip(zipBytes),
    /Güvenlik ihlali: Arşiv dosya yolu geçersiz veya tehlikeli/
  );
});

test('unpackZip rejects corrupt or truncated buffers', async () => {
  await assert.rejects(
    async () => unpackZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
    /Geçersiz ZIP arşivi/
  );
});
