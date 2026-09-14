import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteIdentityManager,
  WebsiteIdentityManagerError,
} from '../src/website-identity-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const intent = Object.freeze({
  user: 'yunapp-0123456789ab',
  homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
});

function missingUserError() {
  const error = new Error('not found');
  error.code = 2;
  return error;
}

test('identity manager creates a missing locked service user and verifies it', async () => {
  let exists = false;
  const calls = [];
  const manager = createWebsiteIdentityManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/getent') {
        if (!exists) throw missingUserError();
        return { stdout: `${intent.user}:x:1201:1201::${intent.homeDirectory}:/usr/sbin/nologin\n` };
      }
      if (file === '/usr/sbin/useradd') {
        exists = true;
        return { stdout: '' };
      }
      if (file === '/usr/bin/install') return { stdout: '' };
      throw new Error('unexpected command');
    },
  });

  const result = await manager.apply(intent);
  assert.equal(result.satisfied, true);
  assert.equal(result.uid, 1201);
  assert.equal(result.gid, 1201);
  assert.deepEqual(calls.find(([file]) => file === '/usr/sbin/useradd')?.[1], [
    '--system',
    '--user-group',
    '--home-dir', intent.homeDirectory,
    '--create-home',
    '--shell', '/usr/sbin/nologin',
    intent.user,
  ]);
  assert.deepEqual(calls.find(([file]) => file === '/usr/bin/install')?.[1], [
    '-d', '-o', intent.user, '-g', intent.user, '-m', '0750', intent.homeDirectory,
  ]);
});

test('identity manager reuses an existing matching user without useradd', async () => {
  const calls = [];
  const manager = createWebsiteIdentityManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/getent') {
        return { stdout: `${intent.user}:x:1201:1201::${intent.homeDirectory}:/usr/sbin/nologin\n` };
      }
      if (file === '/usr/bin/install') return { stdout: '' };
      throw new Error('unexpected command');
    },
  });

  const result = await manager.apply(intent);
  assert.equal(result.satisfied, true);
  assert.equal(calls.some(([file]) => file === '/usr/sbin/useradd'), false);
  assert.equal(calls.some(([file]) => file === '/usr/bin/install'), true);
});

test('identity manager fails closed on user home or shell drift', async () => {
  const manager = createWebsiteIdentityManager({
    run: async (file) => {
      if (file === '/usr/bin/getent') {
        return { stdout: `${intent.user}:x:1201:1201::/home/wrong:/bin/bash\n` };
      }
      throw new Error('unexpected command');
    },
  });

  await assert.rejects(
    manager.inspect(intent),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_drift',
  );
});

test('identity manager rejects paths outside the managed application data root', async () => {
  const manager = createWebsiteIdentityManager({ run: async () => ({ stdout: '' }) });
  await assert.rejects(
    manager.inspect({ user: intent.user, homeDirectory: '/home/example' }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_home_invalid',
  );
});
