import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailboxAccessGuard,
  MailboxAccessError,
  mailboxAccessInternals,
} from '../../../packages/host-runtime/src/mailbox-access-guard.js';
import {
  createMailDataDeleteManager,
  MailDataDeleteError,
} from '../../../packages/host-runtime/src/mail-data-delete-manager.js';

const targetAddress = 'user@example.com';

function createMockRunner(customHandlers = {}) {
  const executed = [];
  const runner = async (file, args, options) => {
    executed.push({ file, args, options });
    const key = `${file} ${args.join(' ')}`;

    if (customHandlers[key]) {
      return customHandlers[key]({ file, args, options });
    }

    // Default successful quiesce / absence runner:
    if (file === '/usr/sbin/postconf') {
      if (args[1] === 'virtual_mailbox_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
      }
      if (args[1] === 'smtpd_sender_login_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n', stderr: '' };
      }
    }

    if (file === '/usr/sbin/postmap') {
      // Exit code 1 means not found in postmap query (expected missing)
      const error = new Error('not found');
      error.code = 1;
      error.stdout = '';
      error.stderr = '';
      throw error;
    }

    if (file === '/usr/bin/doveadm') {
      if (args[0] === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
        return { stdout: '1 cache entries flushed\n', stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'lookup') {
        const error = new Error('user does not exist');
        error.code = 67;
        error.stdout = '';
        error.stderr = `passdb lookup: user ${args[args.length - 1]} doesn't exist`;
        throw error;
      }
      if (args[0] === 'user') {
        const error = new Error('user does not exist');
        error.code = 67;
        error.stdout = '';
        error.stderr = `userdb lookup: user ${args[args.length - 1]} doesn't exist`;
        throw error;
      }
      if (args[0] === 'kick') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === '-f' && args[1] === 'tab' && args[2] === 'who') {
        return { stdout: 'username\tservice\tpid\tip\n', stderr: '' };
      }
    }

    throw new Error(`Unexpected command execution: ${key}`);
  };

  return { runner, executed };
}

test('mailbox access guard quiesces only target address and double-verifies delivery and auth', async () => {
  const { runner, executed } = createMockRunner();
  const guard = createMailboxAccessGuard({ run: runner });

  const result = await guard.quiesce(targetAddress);
  assert.deepEqual(result, {
    identity: targetAddress,
    accessDisabled: true,
    sessionsCleared: true,
  });

  // Verify command sequence:
  // 1. Initial delivery check (postconf + postmap x2)
  // 2. Auth cache flush (doveadm auth cache flush)
  // 3. Auth absence check (doveadm auth lookup x4 + doveadm user x4)
  // 4. Session termination (doveadm kick)
  // 5. Session verification (doveadm who)
  // 6. Double verification: delivery and auth check again
  assert.ok(executed.some(({ file, args }) => file === '/usr/bin/doveadm' && args[1] === 'cache' && args[2] === 'flush'));
  assert.ok(executed.some(({ file, args }) => file === '/usr/bin/doveadm' && args[0] === 'kick' && args[1] === targetAddress));
  assert.ok(executed.some(({ file, args }) => file === '/usr/bin/doveadm' && args[2] === 'who'));

  // Ensure commands never use a shell
  assert.equal(executed.every(({ options }) => options.shell === false), true);
});

test('mailbox access guard verify performs read-only check without kicking sessions', async () => {
  const { runner, executed } = createMockRunner();
  const guard = createMailboxAccessGuard({ run: runner });

  const result = await guard.verify(targetAddress);
  assert.deepEqual(result, {
    identity: targetAddress,
    accessDisabled: true,
    sessionsCleared: true,
  });

  // Read-only verify should never flush or kick sessions
  assert.equal(executed.some(({ file, args }) => file === '/usr/bin/doveadm' && args[1] === 'cache'), false);
  assert.equal(executed.some(({ file, args }) => file === '/usr/bin/doveadm' && args[0] === 'kick'), false);
});

test('mailbox access guard strictly rejects wildcard, malformed or option-injected addresses', async () => {
  const { runner } = createMockRunner();
  const guard = createMailboxAccessGuard({ run: runner });

  for (const badAddress of [
    '*@example.com',
    '?@example.com',
    '-A',
    'user@example..com',
    'user@-example.com',
    'user@example.com\n',
    'user/name@example.com',
    '',
    null,
    undefined,
  ]) {
    await assert.rejects(
      async () => guard.quiesce(badAddress),
      (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_identity_invalid',
    );
  }
});

test('mailbox access guard fails closed when active sessions remain in doveadm who', async () => {
  const { runner } = createMockRunner({
    '/usr/bin/doveadm -f tab who -1 user@example.com': () => ({
      stdout: 'username\tservice\tpid\tip\nuser@example.com\timap\t12345\t192.168.1.50\n',
      stderr: '',
    }),
  });
  const guard = createMailboxAccessGuard({ run: runner });

  await assert.rejects(
    async () => guard.quiesce(targetAddress),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_sessions_remaining',
  );
});

test('mailbox access guard fails closed on unexpected exit codes like tempfail 75 or ENOENT', async () => {
  for (const failure of [
    { code: 75, stderr: 'Temporary lookup failure' },
    { code: 'ENOENT', stderr: 'command not found' },
    { code: 'EACCES', stderr: 'permission denied' },
  ]) {
    const { runner } = createMockRunner({
      '/usr/sbin/postmap -q user@example.com proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf': () => {
        const error = new Error('failure');
        Object.assign(error, failure);
        throw error;
      },
    });
    const guard = createMailboxAccessGuard({ run: runner });

    await assert.rejects(
      async () => guard.quiesce(targetAddress),
      (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_check_failed',
    );
  }
});

test('mail data delete manager enforces mailbox access guard before deleting data', async () => {
  let quiesceCalled = false;
  let verifyCalled = false;

  const mockGuard = {
    async quiesce(identity) {
      assert.equal(identity, targetAddress);
      quiesceCalled = true;
      return { identity, accessDisabled: true, sessionsCleared: true };
    },
    async verify(identity) {
      assert.equal(identity, targetAddress);
      verifyCalled = true;
      return { identity, accessDisabled: true, sessionsCleared: true };
    },
  };

  const backupManager = {
    async materializeBackup(backupId) {
      return {
        manifest: {
          backupId,
          scope: 'mailbox',
          identity: targetAddress,
          sourcePath: '/var/vmail/example.com/user',
          sourcePresent: false,
          contentSha256: 'a'.repeat(64),
          bytes: 0,
          files: 0,
          directories: 0,
        },
      };
    },
  };

  const mailDataInspector = {
    async inspectMailbox(identity) {
      return {
        scope: 'mailbox',
        identity,
        present: false,
        dataPath: '/var/vmail/example.com/user',
        snapshotSha256: 'b'.repeat(64),
      };
    },
    async inspectDomain() {},
  };

  const manager = createMailDataDeleteManager({
    backupManager,
    mailDataInspector,
    mailboxAccessGuard: mockGuard,
    run: async () => ({ stdout: 'vmail:x:5000:5000::/var/vmail:/usr/sbin/nologin\n' }),
  });

  const result = await manager.deleteData({
    transactionId: 'tx-delete-12345678',
    backupId: 'backup-12345678',
    scope: 'mailbox',
    identity: targetAddress,
    expectedTargetSnapshotSha256: 'b'.repeat(64),
  });

  assert.equal(result.deleted, true);
  assert.equal(result.identity, targetAddress);
  assert.equal(quiesceCalled, true);
  assert.equal(verifyCalled, true);
});

test('mail data delete manager blocks deletion when mailbox access guard fails', async () => {
  const failingGuard = {
    async quiesce() {
      throw new MailboxAccessError('mailbox_access_sessions_remaining');
    },
    async verify() {
      return { identity: targetAddress, accessDisabled: true, sessionsCleared: true };
    },
  };

  const backupManager = {
    async materializeBackup(backupId) {
      return {
        manifest: {
          backupId,
          scope: 'mailbox',
          identity: targetAddress,
          sourcePath: '/var/vmail/example.com/user',
          sourcePresent: false,
          contentSha256: 'a'.repeat(64),
          bytes: 0,
          files: 0,
          directories: 0,
        },
      };
    },
  };

  const mailDataInspector = {
    async inspectMailbox(identity) {
      return {
        scope: 'mailbox',
        identity,
        present: false,
        dataPath: '/var/vmail/example.com/user',
        snapshotSha256: 'b'.repeat(64),
      };
    },
    async inspectDomain() {},
  };

  const manager = createMailDataDeleteManager({
    backupManager,
    mailDataInspector,
    mailboxAccessGuard: failingGuard,
    run: async () => ({ stdout: 'vmail:x:5000:5000::/var/vmail:/usr/sbin/nologin\n' }),
  });

  await assert.rejects(
    async () => manager.deleteData({
      transactionId: 'tx-delete-12345678',
      backupId: 'backup-12345678',
      scope: 'mailbox',
      identity: targetAddress,
      expectedTargetSnapshotSha256: 'b'.repeat(64),
    }),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_sessions_remaining',
  );
});

test('mailbox access guard fails closed when postconf reveals unmanaged lookup map (unmanaged config is never absence)', async () => {
  const { runner } = createMockRunner({
    '/usr/sbin/postconf -h virtual_mailbox_maps': () => ({
      stdout: 'hash:/etc/postfix/unmanaged-virtual-mailboxes\n',
      stderr: '',
    }),
  });
  const guard = createMailboxAccessGuard({ run: runner });

  await assert.rejects(
    async () => guard.quiesce(targetAddress),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_configuration_unverified',
  );
});

test('mailbox access guard fails closed when dovecot auth lookup exits with code 75 tempfail (error is never absence)', async () => {
  const { runner } = createMockRunner({
    '/usr/bin/doveadm auth lookup -x service=imap -f user user@example.com': () => {
      const err = new Error('Fatal: Failed to read configuration: stat(/etc/dovecot/dovecot.conf) failed');
      err.code = 75;
      err.stdout = '';
      err.stderr = 'Fatal: Failed to read configuration: stat(/etc/dovecot/dovecot.conf) failed';
      throw err;
    },
  });
  const guard = createMailboxAccessGuard({ run: runner });

  await assert.rejects(
    async () => guard.quiesce(targetAddress),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_check_failed',
  );
});

test('mailbox access guard fails closed when dovecot userdb lookup exits with code 75 tempfail (error is never absence)', async () => {
  const { runner } = createMockRunner({
    '/usr/bin/doveadm user -x service=imap -f uid user@example.com': () => {
      const err = new Error('Fatal: Temporary failure');
      err.code = 75;
      err.stdout = '';
      err.stderr = 'Temporary failure in userdb';
      throw err;
    },
  });
  const guard = createMailboxAccessGuard({ run: runner });

  await assert.rejects(
    async () => guard.quiesce(targetAddress),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_check_failed',
  );
});

test('mailbox access guard fails closed when dovecot cache flush emits invalid output', async () => {
  const { runner } = createMockRunner({
    '/usr/bin/doveadm auth cache flush user@example.com': () => ({
      stdout: 'failed to flush cache\n',
      stderr: '',
    }),
  });
  const guard = createMailboxAccessGuard({ run: runner });

  await assert.rejects(
    async () => guard.quiesce(targetAddress),
    (error) => error instanceof MailboxAccessError && error.code === 'mailbox_access_cache_unverified',
  );
});

test('mailbox access guard verifies Dovecot kick and who command contracts target only chosen address', async () => {
  const { runner, executed } = createMockRunner();
  const guard = createMailboxAccessGuard({ run: runner });

  await guard.quiesce(targetAddress);

  const kickCalls = executed.filter(({ file, args }) => file === '/usr/bin/doveadm' && args[0] === 'kick');
  assert.equal(kickCalls.length, 1);
  assert.deepEqual(kickCalls[0].args, ['kick', targetAddress]);

  const whoCalls = executed.filter(({ file, args }) => file === '/usr/bin/doveadm' && args[2] === 'who');
  assert.equal(whoCalls.length, 1);
  assert.deepEqual(whoCalls[0].args, ['-f', 'tab', 'who', '-1', targetAddress]);

  // Ensure no wildcard or multi-user kicks occur
  assert.equal(executed.some(({ args }) => args.includes('-A') || args.includes('*') || args.includes('?')), false);
});
