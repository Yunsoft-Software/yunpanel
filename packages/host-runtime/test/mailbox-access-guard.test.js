import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxAccessGuard, mailboxAccessInternals } from '../src/mailbox-access-guard.js';

const address = 'chosen@example.test';
const missing = (code, stderr = '') => Object.assign(new Error('private command failure'), { code, stdout: '', stderr });
function harness(intercept) {
  const calls = [];
  const baseline = (file, args) => {
    if (file.endsWith('/postconf')) return { stdout: mailboxAccessInternals.lookups.find(([key]) => key === args[1])[1], stderr: '' };
    if (file.endsWith('/postmap')) throw missing(1);
    if (args[0] === 'auth' && args[1] === 'lookup') throw missing(67, `passdb lookup: user ${address} doesn't exist`);
    if (args[0] === 'user') throw missing(67, `userdb lookup: user ${address} doesn't exist`);
    if (args[0] === 'auth') return { stdout: '0 cache entries flushed\n', stderr: '' };
    if (args.includes('who')) return { stdout: 'username\tproto\tpid\tip\n', stderr: '' };
    if (args[0] === 'kick') return { stdout: address, stderr: '' };
    throw new Error('unexpected command');
  };
  const guard = createMailboxAccessGuard({ run: async (file, args, options) => {
    calls.push({ file, args, options }); return intercept ? intercept(file, args, baseline, calls) : baseline(file, args);
  } });
  return { guard, calls };
}

test('quiesces only the chosen identity and verifies delivery/auth again after kicking', async () => {
  const run = harness();
  assert.deepEqual(await run.guard.quiesce(address), { identity: address, accessDisabled: true, sessionsCleared: true });
  const mutating = run.calls.filter(({ args }) => args[0] === 'kick' || args[1] === 'cache');
  assert.deepEqual(mutating.map(({ args }) => args), [['auth', 'cache', 'flush', address], ['kick', address]]);
  for (const { file, args, options } of run.calls) {
    assert.equal(options.shell, false); assert.equal(options.timeout, 10000);
    assert.ok(['/usr/bin/doveadm', '/usr/sbin/postconf', '/usr/sbin/postmap'].includes(file));
    assert.equal(args.some((arg) => arg.includes('*') || arg.includes('?')), false);
    assert.equal(args.includes('-u') && args.includes('-f'), false);
    assert.equal(args.includes('-A'), false);
  }
  assert.equal(run.calls.filter(({ args }) => args[0] === 'auth' && args[1] === 'lookup').length, 8);
  assert.equal(run.calls.filter(({ file }) => file.endsWith('/postmap')).length, 4);
});

test('read verification never flushes or kicks any session', async () => {
  const run = harness(); await run.guard.verify(address);
  assert.equal(run.calls.some(({ args }) => args[0] === 'kick' || args[1] === 'cache'), false);
});
for (const value of ['*@example.test', '?@example.test', '-A', 'A@example.test', 'user@example..test', 'user@-example.test', 'user@example.test\n', 'user/name@example.test', null]) {
  test(`invalid or wildcard identity is rejected before commands: ${JSON.stringify(value)}`, async () => {
    const run = harness(); await assert.rejects(run.guard.quiesce(value), { code: 'mailbox_access_identity_invalid' }); assert.equal(run.calls.length, 0);
  });
}
for (const code of [75, 78, 77, 'ENOENT', 'EACCES']) {
  test(`command failure ${code} is not interpreted as a missing account`, async () => {
    const run = harness((file, args, next) => { if (args[1] === 'lookup') throw missing(code); return next(file, args); });
    await assert.rejects(run.guard.quiesce(address), { code: 'mailbox_access_check_failed' });
    assert.equal(run.calls.some(({ args }) => args[0] === 'kick'), false);
  });
}
for (const patch of [{ stdout: 'private hash' }, { stderr: 'database unavailable' }, { killed: true }, { signal: 'SIGTERM' }]) {
  test(`a supposed absence with contradictory evidence is rejected: ${JSON.stringify(patch)}`, async () => {
    const run = harness((file, args, next) => { if (file.endsWith('/postmap')) throw Object.assign(missing(1), patch); return next(file, args); });
    await assert.rejects(run.guard.quiesce(address), (error) => error.name === 'MailboxAccessError' && !error.message.includes('private'));
  });
}
for (const active of ['postmap', 'passdb', 'userdb']) {
  test(`${active} successful lookup is active even if stdout is empty`, async () => {
    const run = harness((file, args, next) => {
      if ((active === 'postmap' && file.endsWith('/postmap')) || (active === 'passdb' && args[1] === 'lookup') || (active === 'userdb' && args[0] === 'user')) return { stdout: '', stderr: '' };
      return next(file, args);
    });
    await assert.rejects(run.guard.quiesce(address), { code: 'mailbox_access_still_enabled' });
  });
}

test('any remaining session row blocks deletion without returning private session data', async () => {
  const run = harness((file, args, next) => args.includes('who') ? { stdout: `username\tproto\tpid\tip\n${address}\timap\t10\t127.0.0.1`, stderr: '' } : next(file, args));
  await assert.rejects(run.guard.quiesce(address), { code: 'mailbox_access_sessions_remaining' });
});

test('re-enabled delivery during session cleanup is detected by the second lookup', async () => {
  let checks = 0;
  const run = harness((file, args, next) => { if (file.endsWith('/postmap') && ++checks === 3) return { stdout: '1', stderr: '' }; return next(file, args); });
  await assert.rejects(run.guard.quiesce(address), { code: 'mailbox_access_still_enabled' });
});

test('different configured lookup and unverified cache output cannot authorize deletion', async () => {
  for (const stage of ['config', 'cache']) {
    const run = harness((file, args, next) => {
      if (stage === 'config' && file.endsWith('/postconf')) return { stdout: 'hash:/unmanaged/map', stderr: '' };
      if (stage === 'cache' && args[1] === 'cache') return { stdout: 'unknown', stderr: '' };
      return next(file, args);
    });
    await assert.rejects(run.guard.quiesce(address));
  }
});
