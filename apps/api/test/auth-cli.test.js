import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthStore } from '../src/auth-store.js';

const script = fileURLToPath(new URL('../../../scripts/auth.mjs', import.meta.url));
function run(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('local CLI issues setup tokens and recovers an account without passwords in argv/output', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-auth-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth', 'auth.sqlite');
  const env = { ...process.env, YUNPANEL_AUTH_DB: filePath };
  const issued = await run(['setup-token'], env);
  assert.equal(issued.code, 0);
  const setupToken = issued.stdout.trim().split('\n').at(-1);
  assert.match(setupToken, /^[A-Za-z0-9_-]{43}$/);
  const store = createAuthStore({ filePath });
  t.after(() => store.close());
  const password = randomBytes(32).toString('base64url');
  await store.completeSetup({ setupToken, username: 'owner', password });
  const oldSession = await store.login({ username: 'owner', password });
  assert.equal((await run(['setup-token'], env)).code, 1);
  const newPassword = randomBytes(32).toString('base64url');
  const reset = await run(['reset-password', 'owner'], env, `${newPassword}\n`);
  assert.equal(reset.code, 0);
  assert.equal(`${reset.stdout}${reset.stderr}`.includes(newPassword), false);
  assert.equal(store.getSession(oldSession.token), null);
  assert.ok(await store.login({ username: 'owner', password: newPassword }));
});

test('CLI rejects password command-line arguments', async () => {
  const result = await run(['reset-password', 'owner', 'not-allowed-as-an-argument'], process.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /never argv/);
});
