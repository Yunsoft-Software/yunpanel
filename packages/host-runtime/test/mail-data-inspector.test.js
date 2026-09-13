import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailDataInspector,
  MailDataInspectorError,
} from '../src/index.js';

function directory({ mode = 0o700, uid = 5000, gid = 5000, symlink = false } = {}) {
  return {
    mode,
    uid,
    gid,
    isDirectory: () => true,
    isSymbolicLink: () => symlink,
  };
}

function missing() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

test('inspects canonical mailbox mail data without listing message names or contents', async () => {
  const calls = [];
  const metadata = new Map([
    ['/var/lib/yunpanel/mail', directory({ mode: 0o750, uid: 0, gid: 0 })],
    ['/var/lib/yunpanel/mail/example.com', directory()],
    ['/var/lib/yunpanel/mail/example.com/owner', directory({ mode: 0o700, uid: 5000, gid: 5000 })],
  ]);
  const inspector = createMailDataInspector({
    lstatFn: async (target) => metadata.get(target) ?? Promise.reject(missing()),
    run: async (file, args) => {
      calls.push([file, args]);
      return { stdout: '4096\t/var/lib/yunpanel/mail/example.com/owner\n', stderr: '' };
    },
  });
  const result = await inspector.inspectMailbox('Owner@Example.COM');
  assert.deepEqual({
    scope: result.scope,
    identity: result.identity,
    dataPath: result.dataPath,
    present: result.present,
    bytes: result.bytes,
    mode: result.mode,
    uid: result.uid,
    gid: result.gid,
    sideEffects: result.sideEffects,
  }, {
    scope: 'mailbox',
    identity: 'owner@example.com',
    dataPath: '/var/lib/yunpanel/mail/example.com/owner',
    present: true,
    bytes: 4096,
    mode: 0o700,
    uid: 5000,
    gid: 5000,
    sideEffects: false,
  });
  assert.match(result.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls, [[
    '/usr/bin/du',
    ['--bytes', '--summarize', '--one-file-system', '--', '/var/lib/yunpanel/mail/example.com/owner'],
  ]]);
  assert.equal(JSON.stringify(result).includes('Maildir/cur'), false);
});

test('absent root, domain or mailbox returns explicit zero-byte absence without running du', async () => {
  for (const present of [new Set(), new Set(['/var/lib/yunpanel/mail']), new Set([
    '/var/lib/yunpanel/mail', '/var/lib/yunpanel/mail/example.com',
  ])]) {
    let runs = 0;
    const inspector = createMailDataInspector({
      lstatFn: async (target) => present.has(target) ? directory() : Promise.reject(missing()),
      run: async () => { runs += 1; return { stdout: '' }; },
    });
    const result = await inspector.inspectMailbox('owner@example.com');
    assert.equal(result.present, false);
    assert.equal(result.bytes, 0);
    assert.equal(runs, 0);
  }
});

test('domain inspection measures only the canonical managed domain directory', async () => {
  const inspector = createMailDataInspector({
    lstatFn: async (target) => {
      if (target === '/var/lib/yunpanel/mail' || target === '/var/lib/yunpanel/mail/example.com') return directory();
      throw missing();
    },
    run: async (_file, args) => ({ stdout: `12345\t${args.at(-1)}\n` }),
  });
  const result = await inspector.inspectDomain('Example.COM');
  assert.equal(result.scope, 'domain');
  assert.equal(result.identity, 'example.com');
  assert.equal(result.dataPath, '/var/lib/yunpanel/mail/example.com');
  assert.equal(result.bytes, 12345);
});

test('symlink-like mail data components and malformed du output fail closed', async () => {
  const unsafe = createMailDataInspector({
    lstatFn: async (target) => target === '/var/lib/yunpanel/mail'
      ? directory({ symlink: true })
      : directory(),
    run: async () => ({ stdout: '1\tignored\n' }),
  });
  await assert.rejects(
    unsafe.inspectMailbox('owner@example.com'),
    (error) => error instanceof MailDataInspectorError && error.code === 'mail_data_path_unsafe',
  );

  const malformed = createMailDataInspector({
    lstatFn: async () => directory(),
    run: async () => ({ stdout: '4096 /var/lib/yunpanel/mail/example.com/owner\n' }),
  });
  await assert.rejects(
    malformed.inspectMailbox('owner@example.com'),
    (error) => error instanceof MailDataInspectorError && error.code === 'mail_data_usage_invalid',
  );
});
