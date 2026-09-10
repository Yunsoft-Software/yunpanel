import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordRecoveryAuditOutcome, recoveryAuditInternals } from '../src/recovery-audit.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-recovery-audit-'));
  const authPath = path.join(root, 'auth.sqlite');
  writeFileSync(authPath, '', { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, authPath };
}

test('terminal recovery outcome is handed to the private audit job link store', (t) => {
  const { authPath } = fixture(t);
  const calls = [];
  let closed = false;
  const result = recordRecoveryAuditOutcome({
    result: { jobId: 'job-1', status: 'failed', error: { code: 'node_health_failed', message: 'must-not-copy' } },
    env: { YUNPANEL_AUTH_DB: authPath, YUNPANEL_SECRET_MASTER_KEY: 'test-only-secret' },
    authStoreFactory: ({ filePath, masterKey }) => {
      calls.push(['open', filePath, masterKey]);
      return {
        audit: {
          recordJobOutcome(input) {
            calls.push(['record', input]);
            return { id: 1 };
          },
        },
        close() { closed = true; },
      };
    },
  });

  assert.deepEqual(result, { recorded: true });
  assert.deepEqual(calls, [
    ['open', authPath, 'test-only-secret'],
    ['record', { jobId: 'job-1', outcome: 'failed', code: 'node_health_failed' }],
  ]);
  assert.equal(closed, true);
  assert.equal(JSON.stringify(calls).includes('must-not-copy'), false);
});

test('successful and cancelled recovery outcomes carry no arbitrary error metadata', (t) => {
  const { authPath } = fixture(t);
  const outcomes = [];
  const authStoreFactory = () => ({
    audit: {
      recordJobOutcome(input) {
        outcomes.push(input);
        return { id: outcomes.length };
      },
    },
    close() {},
  });

  assert.deepEqual(recordRecoveryAuditOutcome({
    result: { jobId: 'job-success', status: 'succeeded', error: { code: 'ignored' } },
    env: { YUNPANEL_AUTH_DB: authPath }, authStoreFactory,
  }), { recorded: true });
  assert.deepEqual(recordRecoveryAuditOutcome({
    result: { jobId: 'job-cancelled', status: 'cancelled', error: { code: 'ignored' } },
    env: { YUNPANEL_AUTH_DB: authPath }, authStoreFactory,
  }), { recorded: true });
  assert.deepEqual(outcomes, [
    { jobId: 'job-success', outcome: 'succeeded', code: null },
    { jobId: 'job-cancelled', outcome: 'cancelled', code: null },
  ]);
});

test('non-terminal or unsafe auth state never opens the auth store', (t) => {
  const { authPath } = fixture(t);
  let opens = 0;
  const factory = () => { opens += 1; return { audit: { recordJobOutcome() {} }, close() {} }; };

  assert.deepEqual(recordRecoveryAuditOutcome({
    result: { jobId: 'job-running', status: 'running' }, env: { YUNPANEL_AUTH_DB: authPath }, authStoreFactory: factory,
  }), { recorded: false });
  chmodSync(authPath, 0o644);
  assert.deepEqual(recordRecoveryAuditOutcome({
    result: { jobId: 'job-unsafe', status: 'succeeded' }, env: { YUNPANEL_AUTH_DB: authPath }, authStoreFactory: factory,
  }), { recorded: false });
  assert.equal(opens, 0);
});

test('audit handoff failures never turn an already recovered job back into failure', (t) => {
  const { authPath } = fixture(t);
  const result = recordRecoveryAuditOutcome({
    result: { jobId: 'job-1', status: 'succeeded' },
    env: { YUNPANEL_AUTH_DB: authPath },
    authStoreFactory: () => { throw new Error('SECRET=/root/private'); },
  });
  assert.deepEqual(result, { recorded: false });
});

test('packaged recovery audit path stays under the control-plane state root', () => {
  assert.equal(
    recoveryAuditInternals.resolveAuthPath({
      env: { YUNPANEL_AUTH_DB: '/var/lib/yunpanel/control-plane/auth/auth.sqlite' },
      packaged: true,
      cwd: '/root',
    }),
    '/var/lib/yunpanel/control-plane/auth/auth.sqlite',
  );
  assert.equal(recoveryAuditInternals.resolveAuthPath({
    env: { YUNPANEL_AUTH_DB: '/tmp/auth.sqlite' }, packaged: true, cwd: '/root',
  }), null);
  assert.equal(recoveryAuditInternals.resolveAuthPath({
    env: { YUNPANEL_AUTH_DB: 'relative.sqlite' }, packaged: true, cwd: '/root',
  }), null);
});
