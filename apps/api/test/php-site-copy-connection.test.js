import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { siteFileManagerInternals } from '../src/files/site-file-manager.js';

const WORKER = fileURLToPath(new URL('../src/php/php-site-copy-connection-worker.js', import.meta.url));
const uid = process.getuid?.();

function credential(databaseName) {
  return { version: 1, bindingId: randomUUID(), credentialId: randomUUID(), databaseName, host: 'localhost',
    username: `ydb_${randomBytes(12).toString('hex')}`, password: randomBytes(24).toString('hex') };
}

async function homes(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'yunpanel-php-copy-connection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const publicRoot = path.join(root, 'web');
  await Promise.all([mkdir(home, { mode: 0o750 }), mkdir(publicRoot, { mode: 0o750 })]);
  return { home, publicRoot, configPath: path.join(home, '.yunpanel', 'database.json') };
}

async function invoke(home, action, config) {
  const { stdout } = await siteFileManagerInternals.execFileWithInput(process.execPath, [WORKER], {
    encoding: 'utf8', timeout: 8_000, cwd: '/',
  }, JSON.stringify({ home, action, config }));
  assert.equal(stdout.includes(config.password), false);
  return JSON.parse(stdout);
}

test('PHP copy creates a private connection only once and returns only IDs', { skip: !uid }, async (t) => {
  const { home, publicRoot, configPath } = await homes(t);
  const config = credential('test_php_copy_target');
  const data = { version: 1, bindingId: config.bindingId, credentialId: config.credentialId };
  assert.deepEqual(await invoke(home, 'inspect', config), { ok: true, data: null });
  assert.deepEqual(await invoke(home, 'create', config), { ok: true, data });
  assert.deepEqual(await invoke(home, 'inspect', config), { ok: true, data });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(configPath)).uid, uid);
  await assert.rejects(stat(path.join(publicRoot, '.yunpanel', 'database.json')), { code: 'ENOENT' });
  const bytes = await readFile(configPath);
  assert.equal(JSON.parse(bytes).databaseName, config.databaseName);
  assert.equal(JSON.parse(bytes).password === config.password, true);
  const other = credential('test_php_copy_source');
  assert.deepEqual(await invoke(home, 'create', other), { ok: false, error: 'php_copy_connection_exists' });
  assert.deepEqual(await invoke(home, 'inspect', other), { ok: false, error: 'php_copy_connection_invalid' });
  assert.equal((await readFile(configPath)).equals(bytes), true);
});

test('PHP copy rejects weak modes and linked connection files', { skip: !uid }, async (t) => {
  const { home, publicRoot, configPath } = await homes(t);
  const config = credential('test_php_copy_source');
  const invalid = { ok: false, error: 'php_copy_connection_invalid' };
  await invoke(home, 'create', config);
  const ownedFile = path.join(publicRoot, 'separate');
  await chmod(configPath, 0o640);
  assert.deepEqual(await invoke(home, 'inspect', config), invalid);
  await chmod(configPath, 0o600);
  await link(configPath, ownedFile);
  assert.deepEqual(await invoke(home, 'inspect', config), invalid);
  await unlink(configPath);
  await symlink(ownedFile, configPath);
  assert.deepEqual(await invoke(home, 'inspect', config), invalid);
  assert.deepEqual(await invoke(home, 'create', config), { ok: false, error: 'php_copy_connection_exists' });
  await unlink(configPath);
  await rm(path.dirname(configPath), { recursive: true });
  await symlink(publicRoot, path.dirname(configPath));
  assert.deepEqual(await invoke(home, 'create', config), invalid);
  await assert.rejects(stat(path.join(publicRoot, 'database.json')), { code: 'ENOENT' });
});
