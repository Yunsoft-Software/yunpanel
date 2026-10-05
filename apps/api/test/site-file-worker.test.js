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
    realpath: async (p) => {
      if (p.startsWith('/proc/self/fd/')) {
        const resolved = await fs.realpath(p);
        return resolved === tempDir ? FAKE_ROOT : resolved.startsWith(`${tempDir}/`) ? `${FAKE_ROOT}/${resolved.slice(tempDir.length + 1)}` : resolved;
      }
      return toReal(p) === tempDir ? FAKE_ROOT : p;
    },
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

test('site-file-worker: handles root slash and leading slashes safely', async (t) => {
  const { deps } = await createFixture(t);

  // List with '/'
  const rootList = await executeSiteFileOperation({ operation: 'list', root: FAKE_ROOT, path: '/' }, deps);
  assert.equal(rootList.directory.path, '');

  // Create file with leading slash '/hello.txt'
  const created = await executeSiteFileOperation({
    operation: 'create_file',
    root: FAKE_ROOT,
    path: '/hello.txt',
  }, deps);
  assert.equal(created.created, true);

  const readRes = await executeSiteFileOperation({
    operation: 'read_text',
    root: FAKE_ROOT,
    path: '/hello.txt',
  }, deps);
  assert.equal(readRes.content, '');
});




test('permissions change the actual file and directory modes through opened descriptors', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  await fs.writeFile(path.join(tempDir, 'index.html'), 'actual content');
  await fs.mkdir(path.join(tempDir, 'assets'));
  assert.deepEqual(await executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'index.html', mode: '640' }, deps),
    { path: 'index.html', mode: '0640', updated: true });
  assert.equal((await fs.stat(path.join(tempDir, 'index.html'))).mode & 0o7777, 0o640);
  await executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'assets', mode: '0750' }, deps);
  assert.equal((await fs.stat(path.join(tempDir, 'assets'))).mode & 0o7777, 0o750);
});

test('permissions reject traversal, symlinks, hardlinks and unsafe modes without changing the target', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  const target = path.join(tempDir, 'target');
  await fs.writeFile(target, 'preserve'); await fs.chmod(target, 0o640);
  await fs.symlink(target, path.join(tempDir, 'symlink'));
  await fs.link(target, path.join(tempDir, 'hardlink'));
  for (const [file, code] of [['../target', 'site_file_path_invalid'], ['symlink', 'site_file_symlink_rejected'], ['hardlink', 'site_file_hardlink_rejected']]) {
    await assert.rejects(executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: file, mode: '0755' }, deps), error => error.code === code);
  }
  await fs.unlink(path.join(tempDir, 'hardlink'));
  for (const mode of ['0777', '0646', '0000', '4640', 'abc', '0640x']) {
    await assert.rejects(executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'target', mode }, deps), error => ['site_file_mode_invalid', 'site_file_mode_unsafe'].includes(error.code));
  }
  await fs.mkdir(path.join(tempDir, 'dir'));
  await assert.rejects(executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'dir', mode: '0640' }, deps), error => error.code === 'site_file_mode_unsafe');
  assert.equal((await fs.stat(target)).mode & 0o7777, 0o640);
});

test('permissions expose filesystem failures and close descriptors without false success', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  await fs.writeFile(path.join(tempDir, 'target'), 'preserve'); await fs.chmod(path.join(tempDir, 'target'), 0o640);
  let closed = 0;
  const failing = { ...deps, open: async (...args) => {
    const handle = await deps.open(...args);
    return { fd: handle.fd, stat: () => handle.stat(), chmod: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }, close: async () => { closed++; await handle.close(); } };
  } };
  await assert.rejects(executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'target', mode: '0755' }, failing), error => error.code === 'site_file_permission_denied' && error.status === 403);
  assert.equal(closed, 1); assert.equal((await fs.stat(path.join(tempDir, 'target'))).mode & 0o7777, 0o640);
});

test('permissions reject a descriptor redirected outside the Website before mutation', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  await fs.writeFile(path.join(tempDir, 'target'), 'preserve'); await fs.chmod(path.join(tempDir, 'target'), 0o640);
  const redirected = { ...deps, realpath: p => p.startsWith('/proc/self/fd/') ? '/another-website/target' : deps.realpath(p) };
  await assert.rejects(executeSiteFileOperation({ operation: 'permissions', root: FAKE_ROOT, path: 'target', mode: '0755' }, redirected), error => error.code === 'site_file_changed');
  assert.equal((await fs.stat(path.join(tempDir, 'target'))).mode & 0o7777, 0o640);
});

test('site-file-worker: deep path operations up to 15 levels', async (t) => {
  const { deps } = await createFixture(t);
  const segments = Array.from({ length: 15 }, (_, i) => `level${i + 1}`);
  let currentPath = '';
  for (const seg of segments) {
    currentPath = currentPath ? `${currentPath}/${seg}` : seg;
    await executeSiteFileOperation({ operation: 'mkdir', root: FAKE_ROOT, path: currentPath }, deps);
  }
  const deepFilePath = `${currentPath}/deep-file.txt`;
  const created = await executeSiteFileOperation({ operation: 'create_file', root: FAKE_ROOT, path: deepFilePath }, deps);
  assert.equal(created.created, true);
  assert.equal(created.file.path, deepFilePath);

  const listRes = await executeSiteFileOperation({ operation: 'list', root: FAKE_ROOT, path: currentPath }, deps);
  assert.equal(listRes.entries.length, 1);
  assert.equal(listRes.entries[0].name, 'deep-file.txt');

  const delRes = await executeSiteFileOperation({ operation: 'delete', root: FAKE_ROOT, path: deepFilePath }, deps);
  assert.equal(delRes.deleted, true);
});

test('site-file-worker: symlink listing, renaming, and deleting without target disruption', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  const targetFile = path.join(tempDir, 'actual-data.txt');
  await fs.writeFile(targetFile, 'target content 123');
  const symlinkFile = path.join(tempDir, 'link-data.txt');
  await fs.symlink('actual-data.txt', symlinkFile);

  // List directory - verifies symlink detection
  const listRes = await executeSiteFileOperation({ operation: 'list', root: FAKE_ROOT, path: '' }, deps);
  const linkEntry = listRes.entries.find((e) => e.name === 'link-data.txt');
  assert.ok(linkEntry);
  assert.equal(linkEntry.type, 'symlink');

  // Rename symlink - must succeed without following
  const renameRes = await executeSiteFileOperation({
    operation: 'rename',
    root: FAKE_ROOT,
    path: 'link-data.txt',
    destination: 'renamed-link.txt',
  }, deps);
  assert.equal(renameRes.previousPath, 'link-data.txt');
  assert.equal(renameRes.entry.path, 'renamed-link.txt');
  assert.equal(renameRes.entry.type, 'symlink');

  // Delete symlink - must delete symlink but retain target file
  const delRes = await executeSiteFileOperation({
    operation: 'delete',
    root: FAKE_ROOT,
    path: 'renamed-link.txt',
  }, deps);
  assert.equal(delRes.deleted, true);
  assert.equal(delRes.type, 'symlink');

  // Verify target file still exists and has original content
  assert.equal(await fs.readFile(targetFile, 'utf8'), 'target content 123');
});

test('site-file-worker: Unicode and long filenames', async (t) => {
  const { deps } = await createFixture(t);
  const unicodeName = 'türkçe_şçöğü_İı_日本語_🚀.txt';
  const longName = 'a'.repeat(200) + '.txt';

  // Create Unicode file
  const createdUnicode = await executeSiteFileOperation({
    operation: 'create_file',
    root: FAKE_ROOT,
    path: unicodeName,
  }, deps);
  assert.equal(createdUnicode.created, true);
  assert.equal(createdUnicode.file.name, unicodeName);

  // Write and read Unicode content
  const writeRes = await executeSiteFileOperation({
    operation: 'write_text',
    root: FAKE_ROOT,
    path: unicodeName,
    content: 'İçerik: Başarılı Türkçe karakter testi. Şğöçü.',
    expectedSha256: createHash('sha256').update('').digest('hex'),
  }, deps);
  assert.ok(writeRes.sha256);

  const readRes = await executeSiteFileOperation({
    operation: 'read_text',
    root: FAKE_ROOT,
    path: unicodeName,
  }, deps);
  assert.equal(readRes.content, 'İçerik: Başarılı Türkçe karakter testi. Şğöçü.');

  // Create long filename
  const createdLong = await executeSiteFileOperation({
    operation: 'create_file',
    root: FAKE_ROOT,
    path: longName,
  }, deps);
  assert.equal(createdLong.created, true);
  assert.equal(createdLong.file.name, longName);

  // Rename long filename to another unicode name
  const renamed = await executeSiteFileOperation({
    operation: 'rename',
    root: FAKE_ROOT,
    path: longName,
    destination: 'yeni_ad_şöğ.txt',
  }, deps);
  assert.equal(renamed.entry.name, 'yeni_ad_şöğ.txt');
});

test('site-file-worker: 1000+ entries listing in a single directory', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  const fileCount = 1050;
  for (let i = 0; i < fileCount; i++) {
    await fs.writeFile(path.join(tempDir, `item_${String(i).padStart(4, '0')}.txt`), '');
  }

  const listing = await executeSiteFileOperation({
    operation: 'list',
    root: FAKE_ROOT,
    path: '',
  }, deps);
  assert.equal(listing.entries.length, fileCount);
  assert.equal(listing.entries[0].name, 'item_0000.txt');
  assert.equal(listing.entries[fileCount - 1].name, `item_${String(fileCount - 1).padStart(4, '0')}.txt`);
});

test('site-file-worker: large text file operations in editor (>1MB)', async (t) => {
  const { tempDir, deps } = await createFixture(t);
  const largeContent = 'A'.repeat(1024 * 1024 + 100); // ~1.0001 MB
  await fs.writeFile(path.join(tempDir, 'large.txt'), largeContent, 'utf8');
  const initialSha = createHash('sha256').update(largeContent).digest('hex');

  const readRes = await executeSiteFileOperation({
    operation: 'read_text',
    root: FAKE_ROOT,
    path: 'large.txt',
  }, deps);
  assert.equal(readRes.content.length, largeContent.length);
  assert.equal(readRes.sha256, initialSha);

  const updatedContent = 'B'.repeat(1024 * 1024 + 200);
  const writeRes = await executeSiteFileOperation({
    operation: 'write_text',
    root: FAKE_ROOT,
    path: 'large.txt',
    content: updatedContent,
    expectedSha256: initialSha,
  }, deps);
  assert.equal(writeRes.sha256, createHash('sha256').update(updatedContent).digest('hex'));
});
