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
  homeEntries = [],
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
    homeEntries: [...homeEntries],
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
  const readdirFn = async (targetPath) => {
    assert.equal(targetPath, intent.homeDirectory);
    if (!state.homeExists) throw missingError('ENOENT');
    return [...state.homeEntries];
  };
  const rmdirFn = async (targetPath) => {
    assert.equal(targetPath, intent.homeDirectory);
    if (state.homeEntries.length > 0) {
      const error = new Error('not empty');
      error.code = 'ENOTEMPTY';
      throw error;
    }
    state.homeExists = false;
  };
  return { state, calls, run, lstatFn, readdirFn, rmdirFn };
}

async function managerFixture(t, host, { run = host.run } = {}) {
  const receiptRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-identity-receipts-'));
  t.after(() => rm(receiptRoot, { recursive: true, force: true }));
  return createWebsiteIdentityManager({
    receiptRoot,
    run,
    lstatFn: host.lstatFn,
    readdirFn: host.readdirFn,
    rmdirFn: host.rmdirFn,
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

test('identity compensation preserves nonempty operation-owned home data instead of recursively deleting it', async (t) => {
  const host = createFakeHost({ homeEntries: ['customer-data.db'] });
  const manager = await managerFixture(t, host);
  const evidence = await manager.apply(intent, { operationId });

  const result = await manager.compensate(intent, { operationId, evidence });

  assert.equal(result.satisfied, true);
  assert.equal(result.removedUser, true);
  assert.equal(result.removedGroup, true);
  assert.equal(result.removedHome, false);
  assert.equal(result.preservedHomeData, true);
  assert.equal(host.state.userExists, false);
  assert.equal(host.state.groupExists, false);
  assert.equal(host.state.homeExists, true);
  assert.deepEqual(host.state.homeEntries, ['customer-data.db']);

  const restartedInspection = await manager.inspectCompensation(intent, { operationId, evidence });
  assert.equal(restartedInspection.satisfied, true);
  assert.equal(restartedInspection.preservedHomeData, true);
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

test('identity compensation uses durable ownership checkpoint when apply fails after useradd', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host, {
    run: async (file, args) => {
      if (file === '/usr/bin/install') throw new Error('simulated install failure');
      return host.run(file, args);
    },
  });

  await assert.rejects(
    manager.apply(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_home_prepare_failed',
  );
  assert.equal(host.state.userExists, true);

  const result = await manager.compensate(intent, { operationId, evidence: null });
  assert.equal(result.satisfied, true);
  assert.equal(result.removedUser, true);
  assert.equal(result.removedGroup, true);
  assert.equal(result.removedHome, true);
  assert.equal(host.state.userExists, false);
  assert.equal(host.state.groupExists, false);
  assert.equal(host.state.homeExists, false);
});

test('identity compensation refuses destructive cleanup when useradd outcome is uncertain', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host, {
    run: async (file, args) => {
      if (file === '/usr/sbin/useradd') {
        await host.run(file, args);
        throw new Error('simulated lost useradd result');
      }
      return host.run(file, args);
    },
  });

  await assert.rejects(
    manager.apply(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_create_failed',
  );
  assert.equal(host.state.userExists, true);

  await assert.rejects(
    manager.compensate(intent, { operationId, evidence: null }),
    (error) => error instanceof WebsiteIdentityManagerError
      && error.code === 'website_identity_compensation_ownership_unknown',
  );
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


test('identity migration preview reports an exact safe-create candidate without mutating host state', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);

  const preview = await manager.previewMigration(intent);

  assert.equal(preview.version, 1);
  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeCreateCandidate, true);
  assert.deepEqual(preview.current, { account: null, group: null, home: null });
  assert.deepEqual(preview.desired, {
    user: intent.user,
    homeDirectory: intent.homeDirectory,
    shellPolicy: 'nologin',
    privateGroup: true,
    groupMemberCount: 0,
    homeMode: '0750',
  });
  assert.deepEqual(preview.differences, [
    'website_identity_user_missing',
    'website_identity_group_missing',
    'website_identity_home_missing',
  ]);
  assert.equal(host.calls.some(([file]) => ['/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/groupdel', '/usr/bin/install'].includes(file)), false);
});

test('identity migration preview exposes bounded drift details without leaking group member names', async (t) => {
  const host = createFakeHost({
    userExists: true,
    homeDirectory: '/var/lib/yunpanel/data/11111111-1111-4111-8111-111111111111',
    shell: '/bin/bash',
    homeMode: 0o755,
    groupMembers: ['another-user'],
  });
  const manager = await managerFixture(t, host);

  const preview = await manager.previewMigration(intent);

  assert.equal(preview.satisfied, false);
  assert.equal(preview.safeCreateCandidate, false);
  assert.deepEqual(preview.current.account, {
    uid: 1201,
    gid: 1201,
    homeDirectory: '/var/lib/yunpanel/data/11111111-1111-4111-8111-111111111111',
    shell: '/bin/bash',
  });
  assert.deepEqual(preview.current.group, { gid: 1201, memberCount: 1 });
  assert.deepEqual(preview.current.home, { uid: 1201, gid: 1201, mode: '0755' });
  assert.deepEqual(preview.differences, [
    'website_identity_account_home_drift',
    'website_identity_account_shell_drift',
    'website_identity_group_members_drift',
    'website_identity_home_mode_drift',
  ]);
  assert.equal(JSON.stringify(preview).includes('another-user'), false);
  assert.equal(host.calls.some(([file]) => ['/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/groupdel', '/usr/bin/install'].includes(file)), false);
});

test('identity migration preview recognizes an already canonical identity', async (t) => {
  const host = createFakeHost({ userExists: true });
  const manager = await managerFixture(t, host);

  const preview = await manager.previewMigration(intent);

  assert.equal(preview.satisfied, true);
  assert.equal(preview.safeCreateCandidate, false);
  assert.deepEqual(preview.differences, []);
  assert.deepEqual(preview.current.group, { gid: 1201, memberCount: 0 });
  assert.deepEqual(preview.current.home, { uid: 1201, gid: 1201, mode: '0750' });
});


test('identity operation inspection proves only receipt-owned completed creation without replaying mutation', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host);
  await manager.apply(intent, { operationId });
  const mutationCallsBefore = host.calls.filter(([file]) => ['/usr/sbin/useradd', '/usr/bin/install'].includes(file)).length;

  const inspected = await manager.inspectOperation(intent, { operationId });

  assert.deepEqual(inspected, {
    satisfied: true,
    identityReceiptVersion: 1,
    createdUnixIdentity: true,
  });
  const mutationCallsAfter = host.calls.filter(([file]) => ['/usr/sbin/useradd', '/usr/bin/install'].includes(file)).length;
  assert.equal(mutationCallsAfter, mutationCallsBefore);
});

test('identity operation inspection does not adopt a matching pre-existing identity without a receipt', async (t) => {
  const host = createFakeHost({ userExists: true });
  const manager = await managerFixture(t, host);

  const inspected = await manager.inspectOperation(intent, { operationId });

  assert.deepEqual(inspected, {
    satisfied: false,
    reason: 'website_identity_operation_receipt_missing',
  });
  assert.equal(host.calls.some(([file]) => ['/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/groupdel', '/usr/bin/install'].includes(file)), false);
});

test('identity operation inspection fails closed when host state exists before an ownership checkpoint', async (t) => {
  const host = createFakeHost();
  const manager = await managerFixture(t, host, {
    run: async (file, args) => {
      if (file === '/usr/sbin/useradd') {
        await host.run(file, args);
        throw new Error('simulated lost useradd result');
      }
      return host.run(file, args);
    },
  });
  await assert.rejects(
    manager.apply(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError && error.code === 'website_identity_create_failed',
  );

  await assert.rejects(
    manager.inspectOperation(intent, { operationId }),
    (error) => error instanceof WebsiteIdentityManagerError
      && error.code === 'website_identity_operation_ownership_unknown',
  );
  assert.equal(host.calls.some(([file]) => ['/usr/sbin/userdel', '/usr/sbin/groupdel'].includes(file)), false);
});
