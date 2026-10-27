import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderSmarthost } from '@yunpanel/config-templates';
import { createMailSmarthostManager } from '../src/mail-smarthost-manager.js';

const POSTCONF = '/usr/sbin/postconf';
// `postfix check` inspects queue ownership and needs root, like the panel on the host.
const realPostfix = existsSync(POSTCONF) && existsSync('/etc/postfix/main.cf') && process.getuid?.() === 0;

test('a plan that did not come from renderSmarthost is refused before any command runs', async () => {
  const manager = createMailSmarthostManager({ execFileFn: async () => { throw new Error('must not run'); } });
  for (const plan of [{}, { postfixParameters: [{ name: 'mydestination', value: 'x' }], saslPasswd: '' },
    { postfixParameters: [{ name: 'relayhost', value: '[a.example.com]:587 extra' }], saslPasswd: 'x' }]) {
    await assert.rejects(manager.apply(plan), { code: 'invalid_smarthost_plan' });
  }
});

// Runs against the real Postfix of the host (the .28 test server); skipped where Postfix is absent.
test('real Postfix: enable, edit and disable a relay on a copy of main.cf, restoring the operator baseline',
  { skip: realPostfix ? false : 'needs Postfix and root (run on the .28 test host)' }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yp-smarthost-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const configDirectory = path.join(root, 'postfix');
    await mkdir(configDirectory);
    for (const file of ['main.cf', 'master.cf']) await cp(`/etc/postfix/${file}`, path.join(configDirectory, file));
    const real = await readFile('/etc/postfix/main.cf', 'utf8');
    const value = (name) => execFileSync(POSTCONF, ['-c', configDirectory, '-h', name]).toString().trim();
    const baseline = Object.fromEntries(['relayhost', 'smtp_sasl_auth_enable', 'smtp_tls_security_level'].map(name => [name, value(name)]));
    const manager = createMailSmarthostManager({ directory: path.join(root, 'smarthost'), configDirectory, reload: false });

    await manager.apply(renderSmarthost({ host: 'smtp.relay-test.invalid', port: 587, username: 'relay-user', password: 'Test:Pass!123' }));
    assert.equal(value('relayhost'), '[smtp.relay-test.invalid]:587');
    assert.equal(value('smtp_tls_security_level'), 'encrypt');
    assert.equal((await stat(path.join(root, 'smarthost', 'sasl_passwd.db'))).mode & 0o777, 0o600);

    await manager.apply(renderSmarthost({ host: 'smtps.relay-test.invalid', port: 465, username: 'relay-user', password: 'Other!456' }));
    assert.equal(value('smtp_tls_wrappermode'), 'yes');

    await manager.disable();
    for (const [name, original] of Object.entries(baseline)) assert.equal(value(name), original);
    assert.equal(existsSync(path.join(root, 'smarthost', 'sasl_passwd')), false);
    assert.equal(await readFile('/etc/postfix/main.cf', 'utf8'), real, 'the live main.cf is never touched');
  });
