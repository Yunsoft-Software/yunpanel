import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeSiteFileOperation, SiteFileWorkerError } from '../src/site-file-worker.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-files-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), 'initial');
  await writeFile(path.join(root, 'assets', 'app.js'), 'console.log("safe")');
  t.after(() => rm(root, { recursive: true, force: true }));
  const execute = (operation) => executeSiteFileOperation(
    { root: '/var/lib/yunpanel/apps/2f334b35-03ce-4aa0-a8e4-b2ad4f592541/releases/216e4db8-468b-4e2f-a021-3ab31e0f4123', ...operation },
    { resolveRoot: async () => root },
  );
  return { root, execute };
}

test('site file worker lists permissions and completes bounded file lifecycle operations', async (t) => {
  const { root, execute } = await fixture(t);
  const listed = await execute({ operation: 'list', path: '' });
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.type]), [['assets', 'directory'], ['index.html', 'file']]);
  assert.match(listed.entries[0].mode, /^[0-7]{4}$/);
  assert.equal(Number.isInteger(listed.entries[0].uid), true);
  assert.equal(Number.isInteger(listed.entries[0].gid), true);

  const downloaded = await execute({ operation: 'download', path: 'index.html' });
  assert.equal(Buffer.from(downloaded.content, 'base64').toString(), 'initial');
  const opened = await execute({ operation: 'read_text', path: 'index.html' });
  assert.equal(opened.content, 'initial');
  assert.equal(opened.sha256, createHash('sha256').update('initial').digest('hex'));

  await execute({ operation: 'mkdir', path: 'uploads' });
  const uploaded = await execute({ operation: 'upload', path: 'uploads/data.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64') });
  assert.equal(uploaded.created, true);
  assert.deepEqual(await readFile(path.join(root, 'uploads', 'data.bin')), Buffer.from([0, 1, 2, 255]));
  const replaced = await execute({ operation: 'upload', path: 'index.html', content: Buffer.from('replacement').toString('base64') });
  assert.equal(replaced.created, false);

  const replacementHash = createHash('sha256').update('replacement').digest('hex');
  const edited = await execute({ operation: 'write_text', path: 'index.html', content: 'edited ✓', expectedSha256: replacementHash });
  assert.equal(edited.sha256, createHash('sha256').update('edited ✓').digest('hex'));
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), 'edited ✓');

  const renamed = await execute({ operation: 'rename', path: 'uploads/data.bin', destination: 'assets/data.bin' });
  assert.equal(renamed.entry.path, 'assets/data.bin');
  assert.deepEqual(await readFile(path.join(root, 'assets', 'data.bin')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(await execute({ operation: 'delete', path: 'uploads' }), { deleted: true, path: 'uploads', type: 'directory' });
});

test('site file worker rejects traversal, followed symlinks and stale text writes', async (t) => {
  const { root, execute } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret'), 'outside');
  await symlink(outside, path.join(root, 'escape'));

  for (const itemPath of ['../secret', '/etc/passwd', 'assets/../../secret', 'assets\\..\\secret']) {
    await assert.rejects(
      execute({ operation: 'download', path: itemPath }),
      (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_path_invalid',
    );
  }
  await assert.rejects(
    execute({ operation: 'download', path: 'escape/secret' }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_symlink_rejected',
  );
  await assert.rejects(
    execute({ operation: 'upload', path: 'escape/new', content: Buffer.from('bad').toString('base64') }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_symlink_rejected',
  );
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'outside');

  await assert.rejects(
    execute({ operation: 'write_text', path: 'index.html', content: 'lost update', expectedSha256: '0'.repeat(64) }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_changed',
  );
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), 'initial');

  const deleted = await execute({ operation: 'delete', path: 'escape' });
  assert.equal(deleted.type, 'symlink');
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'outside');
});

test('site file worker rejects invalid UTF-8 and oversized metadata before reading', async (t) => {
  const { root, execute } = await fixture(t);
  await writeFile(path.join(root, 'binary'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    execute({ operation: 'read_text', path: 'binary' }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_not_text',
  );
  await assert.rejects(
    executeSiteFileOperation({
      root: '/managed/release', operation: 'download', path: 'large',
    }, {
      resolveRoot: async () => '/managed/release',
      lstat: async (target) => target === '/managed/release'
        ? { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
        : { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 16 * 1024 * 1024 + 1 },
    }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_too_large',
  );
});

test('site file worker independently validates the canonical managed release root', async () => {
  await assert.rejects(
    executeSiteFileOperation({ operation: 'list', root: '/tmp/release', path: '' }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_root_invalid',
  );
  const managed = '/var/lib/yunpanel/apps/2f334b35-03ce-4aa0-a8e4-b2ad4f592541/releases/216e4db8-468b-4e2f-a021-3ab31e0f4123';
  await assert.rejects(
    executeSiteFileOperation({ operation: 'list', root: managed, path: '' }, {
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      realpath: async () => '/etc',
    }),
    (error) => error instanceof SiteFileWorkerError && error.code === 'site_file_root_invalid',
  );
});

test('site file worker creates Nginx-readable static entries and private Node entries despite umask', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-site-modes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const application = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
  async function create(prefix, name) {
    const requestRoot = `${prefix}/${application}/releases/${release}`;
    const execute = (operation) => executeSiteFileOperation({ root: requestRoot, ...operation }, { resolveRoot: async () => root });
    await execute({ operation: 'mkdir', path: `${name}-dir` });
    await execute({ operation: 'upload', path: `${name}-file`, content: Buffer.from('content').toString('base64') });
    return {
      directory: (await lstat(path.join(root, `${name}-dir`))).mode & 0o777,
      file: (await lstat(path.join(root, `${name}-file`))).mode & 0o777,
    };
  }
  assert.deepEqual(await create('/var/www/yunpanel/apps', 'static'), { directory: 0o755, file: 0o644 });
  assert.deepEqual(await create('/var/lib/yunpanel/apps', 'node'), { directory: 0o750, file: 0o640 });
});
