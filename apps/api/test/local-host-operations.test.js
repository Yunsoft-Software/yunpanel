import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations, LOCAL_HOST_OPERATIONS } from '../src/local-host-operations.js';

function fixture() {
  const calls = [];
  return {
    calls,
    operations: createLocalHostOperations({
      packageManager: {
        inspect: async () => { calls.push(['packages.inspect']); return { packageName: 'yunpanel' }; },
        upgrade: async () => { calls.push(['packages.upgrade']); return { upgraded: true }; },
      },
      nginxManager: {
        stageDomain: async (payload) => { calls.push(['domain.stage', payload]); return { checksum: 'a'.repeat(64), configName: 'site.conf' }; },
        activateDomain: async (payload) => { calls.push(['domain.activate', payload]); return { ...payload, active: true }; },
      },
      acmeManager: {
        issueCertificate: async (payload) => { calls.push(['ssl.issue', payload]); return { certName: payload.domains[0], domains: payload.domains, staging: payload.staging === true, status: payload.staging ? 'validated' : 'issued' }; },
        renewCertificate: async (payload) => { calls.push(['ssl.renew', payload]); return { certName: payload.certName, dryRun: payload.dryRun === true, status: payload.dryRun ? 'validated' : 'renewed' }; },
      },
      nodeStatusInspector: {
        inspectNodeStatus: async (payload) => { calls.push(['node.status', payload]); return { releaseId: payload.releaseId, healthy: true }; },
      },
    }),
  };
}

test('local host operation map exposes package, Nginx, ACME and Node status only', () => {
  const { operations } = fixture();
  assert.deepEqual(operations.operations, [
    OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    OPERATIONS.SYSTEM_UPGRADE,
    OPERATIONS.DOMAIN_STAGE,
    OPERATIONS.DOMAIN_ACTIVATE,
    OPERATIONS.SSL_ISSUE,
    OPERATIONS.SSL_RENEW,
    OPERATIONS.APP_NODE_STATUS,
  ]);
  assert.deepEqual(LOCAL_HOST_OPERATIONS, operations.operations);
  for (const operation of operations.operations) assert.equal(operations.supports(operation), true);
  assert.equal(operations.supports(OPERATIONS.APP_STATIC_DEPLOY), false);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_DEPLOY), false);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_RESTART), false);
});

test('migrated operations execute directly through in-process host managers', async () => {
  const { operations, calls } = fixture();
  const stagePayload = { primaryDomain: 'example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } };
  const activatePayload = { primaryDomain: 'example.com', checksum: 'b'.repeat(64) };
  const issuePayload = { domains: ['example.com'], email: 'admin@example.com', staging: true };
  const renewPayload = { certName: 'example.com', dryRun: true };

  assert.deepEqual(await operations.executeOperation(OPERATIONS.SYSTEM_PACKAGES_INSPECT, {}), { packageName: 'yunpanel' });
  assert.deepEqual(await operations.executeOperation(OPERATIONS.SYSTEM_UPGRADE, {}), { upgraded: true });
  assert.equal((await operations.executeOperation(OPERATIONS.DOMAIN_STAGE, stagePayload)).configName, 'site.conf');
  assert.equal((await operations.executeOperation(OPERATIONS.DOMAIN_ACTIVATE, activatePayload)).active, true);
  assert.equal((await operations.executeOperation(OPERATIONS.SSL_ISSUE, issuePayload)).status, 'validated');
  assert.equal((await operations.executeOperation(OPERATIONS.SSL_RENEW, renewPayload)).status, 'validated');

  assert.deepEqual(calls, [
    ['packages.inspect'],
    ['packages.upgrade'],
    ['domain.stage', stagePayload],
    ['domain.activate', activatePayload],
    ['ssl.issue', issuePayload],
    ['ssl.renew', renewPayload],
  ]);
});

test('Node status forwards the exact queued release and runtime without agent transport', async () => {
  const { operations, calls } = fixture();
  const payload = { applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9', releaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123', runtime: { port: 3100, healthPath: '/health' } };
  assert.deepEqual(await operations.executeOperation(OPERATIONS.APP_NODE_STATUS, payload), { releaseId: payload.releaseId, healthy: true });
  assert.deepEqual(calls, [['node.status', payload]]);
  assert.equal(calls[0][1], payload);
});

test('unmigrated deploy/restart operations and malformed payloads fail closed', async () => {
  const { operations, calls } = fixture();
  for (const operation of [OPERATIONS.APP_NODE_DEPLOY, OPERATIONS.APP_STATIC_DEPLOY, OPERATIONS.APP_NODE_RESTART]) {
    await assert.rejects(() => operations.executeOperation(operation, {}), { code: 'local_operation_not_migrated' });
  }
  for (const payload of [null, [], 'invalid']) {
    await assert.rejects(() => operations.executeOperation(OPERATIONS.APP_NODE_STATUS, payload), { code: 'invalid_local_operation_payload' });
  }
  await assert.rejects(() => operations.executeOperation(OPERATIONS.DOMAIN_STAGE, null), { code: 'invalid_local_operation_payload' });
  assert.equal(calls.length, 0);
});
