import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executeSiteFileOperation,
  SiteFileWorkerError,
  siteFileWorkerInternals,
} from '../src/site-file-worker.js';

const FAKE_ROOT = '/var/www/yunpanel/apps/11111111-1111-4111-8111-111111111111/current';

async function createFixture(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-worker-test-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function toReal(targetPath) {
    if (targetPath === FAKE_ROOT) return tempDir;
    if (targetPath.startsWith(`${FAKE_ROOT}/`)) {
      return path.join(tempDir, targetPath.slice(FAKE_ROOT.length + 1));
    }
    return targetPath;
  }

  const deps = {
    chmod: (p, mode) => fs.chmod(toReal(p), mode),
    lstat: (p) => fs.lstat(toReal(p)),
    mkdir: (p, options) => fs.mkdir(toReal(p), options),
    open: (p, flags, mode) => fs.open(toReal(p), flags, mode),
    readdir: (p, options) => fs.readdir(toReal(p), options),
    readFile: (p) => fs.readFile(toReal(p)),
    realpath: async (p) => (toReal(p) === tempDir ? FAKE_ROOT : p),
    rename: (oldP, newP) => fs.rename(toReal(oldP), toReal(newP)),
    rm: (p, options) => fs.rm(toReal(p), options),
    stat: (p) => fs.stat(toReal(p)),
  };

  return { tempDir, deps };
}

test('site-file-worker: create_file, list, read_text, write_text', async (t) => {
  const { deps } = await createFixture(t);

  // 1. Create file
  const created = await executeSiteFileOperation({
    operation: 'create_file',
    root: FAKE_ROOT,
    path: 'hello.txt',
  }, deps);
  assert.equal(created.created, true);
  assert.equal(created.file.path, 'hello.txt');

  // 2. List root
  const listing = await executeSiteFileOperation({
    operation: 'list',
    root: FAKE_ROOT,
    path: '',
  }, deps);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].name, 'hello.txt');
  assert.equal(listing.entries[0].type, 'file');

  // 3. Read empty text
  const read1 = await executeSiteFileOperation({
    operation: 'read_text',
    root: FAKE_ROOT,
    path: 'hello.txt',
  }, deps);
  assert.equal(read1.content, '');
  assert.equal(read1.sha256, createHash('sha256').update('').digest('hex'));

  // 4. Write text with matching expectedSha256
  const write1 = await executeSiteFileOperation({
    operation: 'write_text',
    root: FAKE_ROOT,
    path: 'hello.txt',
    content: 'Hello, YunPanel!',
    expectedSha256: read1.sha256,
  }, deps);
  assert.equal(write1.file.size, Buffer.byteLength('Hello, YunPanel!'));

  // 5. Read updated text
  const read2 = await executeSiteFileOperation({
    operation: 'read_text',
    root: FAKE_ROOT,
    path: 'hello.txt',
  }, deps);
  assert.equal(read2.content, 'Hello, YunPanel!');
  assert.equal(read2.sha256, write1.sha256);

  // 6. Write with stale expectedSha256 should throw
  await assert.rejects(
    () => executeSiteFileOperation({
      operation: 'write_text',
      root: FAKE_ROOT,
      path: 'hello.txt',
      content: 'Stale update',
      expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
    }, deps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_changed',
  );
});

test('site-file-worker: mkdir, upload, download, and delete', async (t) => {
  const { deps } = await createFixture(t);

  // 1. mkdir
  const dir = await executeSiteFileOperation({
    operation: 'mkdir',
    root: FAKE_ROOT,
    path: 'subfolder',
  }, deps);
  assert.equal(dir.directory.path, 'subfolder');

  // 2. upload binary file into subfolder
  const rawBytes = Buffer.from('Binary content \x00\x01\x02');
  const uploadResult = await executeSiteFileOperation({
    operation: 'upload',
    root: FAKE_ROOT,
    path: 'subfolder/data.bin',
    content: rawBytes.toString('base64'),
  }, deps);
  assert.equal(uploadResult.created, true);
  assert.equal(uploadResult.file.size, rawBytes.length);

  // 3. download
  const downloadResult = await executeSiteFileOperation({
    operation: 'download',
    root: FAKE_ROOT,
    path: 'subfolder/data.bin',
  }, deps);
  assert.equal(downloadResult.content, rawBytes.toString('base64'));

  // 4. delete file
  const deletedFile = await executeSiteFileOperation({
    operation: 'delete',
    root: FAKE_ROOT,
    path: 'subfolder/data.bin',
  }, deps);
  assert.equal(deletedFile.deleted, true);

  // 5. delete directory
  const deletedDir = await executeSiteFileOperation({
    operation: 'delete',
    root: FAKE_ROOT,
    path: 'subfolder',
  }, deps);
  assert.equal(deletedDir.deleted, true);
});

test('site-file-worker: batch_delete multiple files and directories', async (t) => {
  const { deps } = await createFixture(t);

  await executeSiteFileOperation({ operation: 'create_file', root: FAKE_ROOT, path: 'a.txt' }, deps);
  await executeSiteFileOperation({ operation: 'create_file', root: FAKE_ROOT, path: 'b.txt' }, deps);
  await executeSiteFileOperation({ operation: 'mkdir', root: FAKE_ROOT, path: 'dir1' }, deps);
  await executeSiteFileOperation({ operation: 'create_file', root: FAKE_ROOT, path: 'dir1/c.txt' }, deps);

  const batchResult = await executeSiteFileOperation({
    operation: 'batch_delete',
    root: FAKE_ROOT,
    paths: ['a.txt', 'b.txt', 'dir1'],
  }, deps);

  assert.equal(batchResult.deleted.length, 3);
  assert.ok(batchResult.deleted.every((item) => item.deleted === true));

  const listAfter = await executeSiteFileOperation({ operation: 'list', root: FAKE_ROOT, path: '' }, deps);
  assert.equal(listAfter.entries.length, 0);
});

test('site-file-worker: path traversal protection', async (t) => {
  const { deps } = await createFixture(t);

  await assert.rejects(
    () => executeSiteFileOperation({ operation: 'read_text', root: FAKE_ROOT, path: '../etc/passwd' }, deps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_path_invalid',
  );

  await assert.rejects(
    () => executeSiteFileOperation({ operation: 'create_file', root: FAKE_ROOT, path: 'foo/../../bar' }, deps),
    (err) => err instanceof SiteFileWorkerError && err.code === 'site_file_path_invalid',
  );
});
