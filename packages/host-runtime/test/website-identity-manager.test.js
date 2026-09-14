import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteIdentityManager,
  WebsiteIdentityManagerError,
} from '../src/website-identity-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const intent = Object.freeze({
  user: 'yunapp-0123456789ab',
  homeDirectory: `/var/lib/yunpanel/data/${applicationId}`,
});

function missingError(code = 2) {
  const error = new Error('not found');
  error.code = code;
  return error;
}

function createFakeHost({
  userExists = false,
  groupExists = userExists,
  homeExists = userExists,
  homeDirectory = intent.homeDirectory,
  shell = '/usr/sbin/nologin',
  uid = 1201,
  gid = 1201,
  homeMode = 0o750,
  groupMembers = [],
} = {}) {
  const state = {
    userExists,
    groupExists,
    homeExists,
    homeDirectory,
    shell,
    uid,
    gid,
    homeMode,
    groupMembers: [...groupMembers],
  };
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    if (file === '/usr/bin/getent' && args[0] === 'passwd') {
      if (!state.userExists) throw missingError();
      return { stdout: `${intent.user}:x:${state.uid}:${state.gid}::${state.homeDirectory}:${state.shell}\n` };
    }
    if (file === '/usr/bin/getent' && args[0] === 'group') {
      if (!state.groupExists) throw missingError();
      return { stdout: `${intent.user}:x:${state.gid}:${state.groupMembers.join(',')}\n` };
    }
    if (file === '/usr/sbin/useradd') {
      state.userExists = true;
      state.groupExists = true;
      state.homeExists = true;
      state.homeDirectory = intent.homeDirectory;
      state.shell = '/usr/sbin/nologin';
      state.homeMode = 0o755;
      return { stdout: '' };
    }
    if (file === '/usr/bin/install') {
      state.homeExists = true;
      state.homeMode = 0o750;
      return { stdout: '' };
    }
    if (file === '/usr/sbin/userdel') {
      state.userExists = false;
      return { stdout: '' };
    }
    if (file === '/usr/sbin/groupdel') {
      state.groupExists = false;
      return { stdout: '' };
    }
    throw new Error(`unexpected command: ${file}`);
  };
  const lstatFn = async (targetPath) => {
    assert.equal(targetPath, intent.homeDirectory);
    if (!state.homeExists) throw missingError('ENOENT');
    return {
      uid: state.uid,
      gid: state.gid,
      mode: state.homeMode,
      isDirectory: () => true,
    };
  };
  const rmFn = async (targetPath) => {
    assert.equal(targetPath, intent.homeDirectory);
    state.homeExists = false;
  };
  return { state, calls, run, lstatFn, rmFn };
}

async function managerFixture(t, host) {
  const receiptRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-identity-receipts-'));
  t.after(() => rm(receiptRoot, { recursive: true, force: true }));
  return createWebsiteIdentityManager({
    receiptRoot,
    run: host.run,
    lstatFn: host.lstatFn,
    rmFn: host.rmFn,
  });
}

test('identity manager creates a missing locked service user under a durable operation receipt', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);

  const result = await manager.apply(intent, { operationId });
  assert.equal(result.satisfied, true);
  assert.equal(result.uid, 1201);
  assert.equal(result.gid, 1201);
  assert.equal(result.created, true);
  assert.equal(result.receiptVersion, 1);
  assert.deepEqual(host.calls.find(([file]) => file === '/usr/sbin/useradd')?.[1], [
    '--system',
    '--user-group',
    '--home-dir', intent.homeDirectory,
    '--create-home',
    '--shell', '/usr/sbin/nologin',
    intent.user,
  ]);
  assert.deepEqual(host.calls.find(([file]) => file === '/usr/bin/install')?.[1], [
    '-d', '-o', intent.user, '-g', intent.user, '-m', '0750', intent.homeDirectory,
  ]);
});

test('identity manager reuses an existing matching identity without mutating its home', async (t) => {
  const host = createFakeHost({ userExists: true });
  const manager = await managerFixture(t, host);

  const result = await manager.apply(intent);
  assert.equal(result.satisfied, true);
  assert.equal(result.created, false);
  assert.equal(result.receiptVersion, null);
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/useradd'), false);
  assert.equal(host.calls.some(([file]) => file === '/usr/bin/install'), false);
});

test('identity manager fails closed on user home or shell drift', async (t) => {
  const host = createFakeHost({
    userExists: true,
    homeDirectory: '/home/wrong',
    shell: '/bin/bash',
  });
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.inspect(intent),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_drift',
  );
});

test('identity manager rejects managed group membership drift', async (t) => {
  const host = createFakeHost({ userExists: true, groupMembers: ['another-user'] });
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.inspect(intent),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_group_drift',
  );
});

test('identity manager rejects managed home ownership or mode drift', async (t) => {
  const host = createFakeHost({ userExists: true, homeMode: 0o755 });
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.inspect(intent),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_home_drift',
  );
});

test('identity creation refuses a pre-existing orphan group before useradd', async (t) => {
  const host = createFakeHost({ userExists: false, groupExists: true, homeExists: false });
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.apply(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_group_conflict',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/useradd'), false);
});

test('identity creation refuses a pre-existing orphan home before useradd', async (t) => {
  const host = createFakeHost({ userExists: false, groupExists: false, homeExists: true });
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.apply(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_home_conflict',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/useradd'), false);
});

test('identity manager requires a durable operation id before creating host state', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);

  await assert.rejects(
    manager.apply(intent),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_operation_required',
  );
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/useradd'), false);
});

test('identity compensation removes only operation-owned user group and home', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);
  const evidence = await manager.apply(intent, { operationId });

  const result = await manager.compensate(intent, { operationId, evidence });

  assert.equal(result.satisfied, true);
  assert.equal(result.removedUser, true);
  assert.equal(result.removedGroup, true);
  assert.equal(result.removedHome, true);
  assert.equal(host.state.userExists, false);
  assert.equal(host.state.groupExists, false);
  assert.equal(host.state.homeExists, false);
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/userdel'), true);
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/groupdel'), true);
});

test('identity compensation preserves a matching identity that predated the operation', async (t) => {
  const host = createFakeHost({ userExists: true });
  const manager = await managerFixture(t, host);
  const evidence = await manager.apply(intent);

  const result = await manager.compensate(intent, { operationId, evidence });

  assert.deepEqual(result, { satisfied: true, removedUser: false, preservedExisting: true });
  assert.equal(host.state.userExists, true);
  assert.equal(host.state.groupExists, true);
  assert.equal(host.state.homeExists, true);
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/userdel'), false);
  assert.equal(host.calls.some(([file]) => file === '/usr/sbin/groupdel'), false);
});

test('identity compensation refuses ownership drift before destructive mutation', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);
  const evidence = await manager.apply(intent, { operationId });
  host.state.groupMembers.push('unexpected-user');
  const destructiveCallsBefore = host.calls.filter(([file]) => ['/usr/sbin/userdel', '/usr/sbin/groupdel'].includes(file)).length;

  await assert.rejects(
    manager.compensate(intent, { operationId, evidence }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_compensation_drift',
  );

  const destructiveCallsAfter = host.calls.filter(([file]) => ['/usr/sbin/userdel', '/usr/sbin/groupdel'].includes(file)).length;
  assert.equal(destructiveCallsAfter, destructiveCallsBefore);
  assert.equal(host.state.userExists, true);
  assert.equal(host.state.groupExists, true);
  assert.equal(host.state.homeExists, true);
});

test('identity manager rejects paths outside the managed application data root', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);
  await assert.rejects(
    manager.inspect({ user: intent.user, homeDirectory: '/home/example' }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_home_invalid',
  );
});
