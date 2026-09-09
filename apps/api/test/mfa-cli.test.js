import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOTP } from 'otpauth';
import { createAuthStore } from '../src/auth-store.js';

const script = fileURLToPath(new URL('../../../scripts/auth.mjs', import.meta.url));
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('local MFA reset requires explicit confirmation and preserves the account password', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-mfa-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth', 'auth.sqlite');
  const masterKey = randomBytes(32);
  const store = createAuthStore({ filePath, masterKey }); t.after(() => store.close());
  const password = randomBytes(32).toString('base64url');
  await store.completeSetup({ setupToken: store.issueSetupToken().token, username: 'owner', password });
  const initial = await store.login({ username: 'owner', password });
  const enrollment = await store.mfa.beginEnrollment(initial.token, password);
  const enabled = store.mfa.confirmEnrollment(initial.token, new TOTP({ secret: enrollment.secret }).generate());
  const pending = await store.login({ username: 'owner', password });
  // Recovery must work even when the process environment contains an unusable key.
  const env = { ...process.env, YUNPANEL_AUTH_DB: filePath, YUNPANEL_SECRET_MASTER_KEY: 'lost-or-invalid' };
  assert.equal((await run(['reset-mfa', 'owner'], env)).code, 1);
  assert.equal(store.mfa.enabled(enabled.session.user.id), true);
  const reset = await run(['reset-mfa', 'owner', '--confirm'], env);
  assert.equal(reset.code, 0);
  assert.match(reset.stdout, /Password unchanged/);
  for (const secret of [password, enrollment.secret, enabled.token, ...enabled.recoveryCodes]) assert.equal(`${reset.stdout}${reset.stderr}`.includes(secret), false);
  assert.equal(store.getSession(enabled.token), null);
  assert.throws(() => store.mfa.completeLogin(pending.challengeToken, { method: 'recovery', code: enabled.recoveryCodes[0] }), { code: 'mfa_challenge_expired' });
  assert.ok((await store.login({ username: 'owner', password })).session);
  assert.equal((await run(['reset-mfa', 'missing', '--confirm'], env)).code, 1);
});

test('MFA reset refuses extra flags and does not silently select an account', async () => {
  for (const args of [['reset-mfa'], ['reset-mfa', 'owner', '--yes'], ['reset-mfa', 'owner', '--confirm', 'extra']]) {
    const result = await run(args, process.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--confirm/);
  }
});
