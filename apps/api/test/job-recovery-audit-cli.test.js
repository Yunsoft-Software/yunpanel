import assert from 'node:assert/strict';
import test from 'node:test';
import { runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const jobId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const packagedScript = '/usr/lib/yunpanel/scripts/job-recovery.mjs';

function recoveredResult() {
  return {
    serverId,
    jobId,
    status: 'succeeded',
    operation: 'system.packages.inspect',
    recoveryMethod: 'read_only_reexecution',
    statePaths: {
      jobStore: '/var/lib/yunpanel/control-plane/job-registry.json',
      recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json',
    },
  };
}

test('packaged recovery hands terminal result to audit after recovery succeeds', async () => {
  const events = [];
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-readonly', serverId, jobId, '--confirm'],
    filePath: packagedScript,
    uid: 0,
    env: { YUNPANEL_AUTH_DB: '/var/lib/yunpanel/control-plane/auth/auth.sqlite' },
    cwd: '/root',
    recoverRunning: async (input) => {
      events.push(['recover', input]);
      return recoveredResult();
    },
    recoveryAudit: (input) => {
      events.push(['audit', input]);
      return { recorded: true };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(events.map(([name]) => name), ['recover', 'audit']);
  assert.equal(events[0][1].serverId, serverId);
  assert.equal(events[0][1].jobId, jobId);
  assert.equal(events[1][1].result, result);
  assert.equal(events[1][1].packaged, true);
  assert.equal(events[1][1].cwd, '/root');
  assert.match(output.join(''), new RegExp(`recovered server=${serverId} job=${jobId} status=succeeded`));
});

test('audit handoff failure never changes an already recovered outcome', async () => {
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['recover-readonly', serverId, jobId, '--confirm'],
    filePath: packagedScript,
    uid: 0,
    recoverRunning: async () => recoveredResult(),
    recoveryAudit: () => { throw new Error('SECRET=/root/private'); },
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(result.status, 'succeeded');
  assert.match(output.join(''), /status=succeeded/);
  assert.doesNotMatch(output.join(''), /SECRET|\/root\/private/);
});

test('read-only recovery inspection status never invokes audit handoff', async () => {
  let auditCalls = 0;
  const output = [];
  const result = await runJobRecoveryCli({
    argv: ['status'],
    filePath: packagedScript,
    uid: 0,
    durableRegistryFactory: () => ({ marker: true }),
    jobRegistryFactory: () => ({}),
    inspect: async () => ({ state: 'clear', version: 1, code: null, detectedAt: null, jobs: [] }),
    recoveryAudit: () => { auditCalls += 1; },
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(result.action, 'status');
  assert.equal(auditCalls, 0);
  assert.match(output.join(''), /state=clear/);
});
