import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProtectedPathAuthManager } from '../src/protected-path-auth-manager.js';

// Real openssl and real files: the hash must be one nginx's crypt() accepts.
async function manager(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, auth: createProtectedPathAuthManager({ root, groupId: null, openssl: 'openssl' }) };
}
const ADMIN = '0123456789abcdef';
const REPORTS = 'fedcba9876543210';
const file = (root, domain, key) => path.join(root, domain, `${key}.htpasswd`);
const reHash = (password, hash) => execFileSync('openssl', ['passwd', '-6', '-salt', hash.split('$')[2], '-stdin'], { input: password }).toString().trim();

test('a user is stored as a SHA-512 crypt hash that openssl reproduces; the password is never written', async (t) => {
  const { root, auth } = await manager(t);
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'editor', password: 'Çok-Gizli Parola 1' });
  const content = await readFile(file(root, 'site.example.com', ADMIN), 'utf8');
  const [username, hash] = content.trim().split(':');
  assert.equal(username, 'editor');
  assert.match(hash, /^\$6\$[^$]+\$[A-Za-z0-9./]{86}$/);
  assert.equal(content.includes('Gizli'), false);
  assert.equal(reHash('Çok-Gizli Parola 1', hash), hash, 'openssl verifies the stored hash');
  assert.equal((await stat(file(root, 'site.example.com', ADMIN))).mode & 0o777, 0o640);
  assert.deepEqual(await auth.listUsers({ domain: 'site.example.com', key: ADMIN }), ['editor']);
});

test('changing a password replaces only that user; removing keeps the others', async (t) => {
  const { root, auth } = await manager(t);
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'a', password: 'first-password' });
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'b', password: 'second-password' });
  const before = (await readFile(file(root, 'site.example.com', ADMIN), 'utf8')).split('\n').find(line => line.startsWith('b:'));
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'a', password: 'changed-password' });
  const lines = (await readFile(file(root, 'site.example.com', ADMIN), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(reHash('changed-password', lines.find(l => l.startsWith('a:')).slice(2)), lines.find(l => l.startsWith('a:')).slice(2));
  assert.equal(lines.find(l => l.startsWith('b:')), before);
  await auth.removeUser({ domain: 'site.example.com', key: ADMIN, username: 'a' });
  assert.deepEqual(await auth.listUsers({ domain: 'site.example.com', key: ADMIN }), ['b']);
});

test('a path or a whole domain can be cleaned up; unknown files list as empty', async (t) => {
  const { root, auth } = await manager(t);
  assert.deepEqual(await auth.listUsers({ domain: 'new.example.com', key: ADMIN }), []);
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'a', password: 'first-password' });
  await auth.setUser({ domain: 'site.example.com', key: REPORTS, username: 'a', password: 'first-password' });
  await auth.removePath({ domain: 'site.example.com', key: ADMIN });
  assert.equal(existsSync(file(root, 'site.example.com', ADMIN)), false);
  assert.equal(existsSync(file(root, 'site.example.com', REPORTS)), true);
  await auth.removeDomain({ domain: 'site.example.com' });
  assert.equal(existsSync(path.join(root, 'site.example.com')), false);
});

test('input that could forge htpasswd lines or escape the directory is refused', async (t) => {
  const { auth } = await manager(t);
  const ok = { domain: 'site.example.com', key: ADMIN, username: 'editor', password: 'long-enough-1' };
  for (const change of [{ username: 'a:b' }, { username: 'a\nroot' }, { username: '' }, { username: 'x'.repeat(65) },
    { password: 'short' }, { password: 'line\nbreak-here' }, { password: 'p'.repeat(129) },
    { domain: '../etc' }, { domain: 'Site.example.com' }, { domain: 'example' }, { key: 'ABCDEF0123456789' }, { key: '../../etc/passwd' }]) {
    await assert.rejects(auth.setUser({ ...ok, ...change }), { code: /^invalid_protected_path_/ }, JSON.stringify(change));
  }
});

test('the number of users per directory is capped', async (t) => {
  const { auth } = await manager(t);
  const base = { domain: 'site.example.com', key: ADMIN, password: 'long-enough-1' };
  for (let index = 0; index < 50; index += 1) await auth.setUser({ ...base, username: `u${index}` });
  await assert.rejects(auth.setUser({ ...base, username: 'one-more' }), { code: 'protected_path_user_limit' });
});

test('nginx can traverse the auth root and the domain directory (found on .28: a root-only root made every login 500)', async (t) => {
  const { root, auth } = await manager(t);
  await auth.setUser({ domain: 'site.example.com', key: ADMIN, username: 'a', password: 'first-password' });
  assert.equal((await stat(root)).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(root, 'site.example.com'))).mode & 0o777, 0o750);
});
