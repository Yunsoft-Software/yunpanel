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
      staticDeploymentManager: {
        deployStatic: async (payload) => { calls.push(['static.deploy', payload]); return { deploymentId: payload.deploymentId, releaseId: payload.deploymentId }; },
      },
      staticRollbackManager: {
        rollbackStatic: async (payload) => { calls.push(['static.rollback', payload]); return { releaseId: payload.releaseId, previousReleaseId: payload.currentReleaseId, active: true }; },
      },
      nodeStatusInspector: {
        inspectNodeStatus: async (payload) => { calls.push(['node.status', payload]); return { releaseId: payload.releaseId, healthy: true }; },
      },
    }),
  };
}

test('local host operation map exposes migrated static lifecycle with existing host operations', () => {
  const { operations } = fixture();
  assert.deepEqual(operations.operations, [
    OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    OPERATIONS.SYSTEM_UPGRADE,
    OPERATIONS.DOMAIN_STAGE,
    OPERATIONS.DOMAIN_ACTIVATE,
    OPERATIONS.SSL_ISSUE,
    OPERATIONS.SSL_RENEW,
    OPERATIONS.APP_STATIC_DEPLOY,
    OPERATIONS.APP_STATIC_ROLLBACK,
    OPERATIONS.APP_NODE_STATUS,
  ]);
  assert.deepEqual(LOCAL_HOST_OPERATIONS, operations.operations);
  for (const operation of operations.operations) assert.equal(operations.supports(operation), true);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_DEPLOY), false);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_RESTART), false);
  assert.equal(operations.supports(OPERATIONS.APP_NODE_ROLLBACK), false);
});

test('static deploy and rollback execute locally with the exact queued payload', async () => {
  const { operations, calls } = fixture();
  const deployPayload = {
    applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
    deploymentId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
    repositoryUrl: 'https://github.com/example/site.git',
    branch: 'main',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    retention: 5,
  };
  const rollbackPayload = {
    applicationId: deployPayload.applicationId,
    releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
    currentReleaseId: deployPayload.deploymentId,
  };
  assert.equal((await operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, deployPayload)).releaseId, deployPayload.deploymentId);
  assert.equal((await operations.executeOperation(OPERATIONS.APP_STATIC_ROLLBACK, rollbackPayload)).releaseId, rollbackPayload.releaseId);
  assert.deepEqual(calls, [['static.deploy', deployPayload], ['static.rollback', rollbackPayload]]);
});

test('existing migrated host operations still dispatch through their dedicated managers', async () => {
  const { operations, calls } = fixture();
  const stagePayload = { primaryDomain: 'example.com', aliases: [], targetType: 'proxy', target: { upstreamPort: 3000 } };
  const activatePayload = { primaryDomain: 'example.com', checksum: 'b'.repeat(64) };
  const issuePayload = { domains: ['example.com'], email: 'admin@example.com', staging: true };
  const renewPayload = { certName: 'example.com', dryRun: true };
  const statusPayload = { applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9', releaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123', runtime: { port: 3100, healthPath: '/health' } };

  await operations.executeOperation(OPERATIONS.SYSTEM_PACKAGES_INSPECT, {});
  await operations.executeOperation(OPERATIONS.SYSTEM_UPGRADE, {});
  await operations.executeOperation(OPERATIONS.DOMAIN_STAGE, stagePayload);
  await operations.executeOperation(OPERATIONS.DOMAIN_ACTIVATE, activatePayload);
  await operations.executeOperation(OPERATIONS.SSL_ISSUE, issuePayload);
  await operations.executeOperation(OPERATIONS.SSL_RENEW, renewPayload);
  await operations.executeOperation(OPERATIONS.APP_NODE_STATUS, statusPayload);
  assert.deepEqual(calls.map(([name]) => name), ['packages.inspect', 'packages.upgrade', 'domain.stage', 'domain.activate', 'ssl.issue', 'ssl.renew', 'node.status']);
});

test('unmigrated Node mutations and malformed payloads fail closed', async () => {
  const { operations, calls } = fixture();
  for (const operation of [OPERATIONS.APP_NODE_DEPLOY, OPERATIONS.APP_NODE_RESTART, OPERATIONS.APP_NODE_ROLLBACK]) {
    await assert.rejects(() => operations.executeOperation(operation, {}), { code: 'local_operation_not_migrated' });
  }
  for (const payload of [null, [], 'invalid']) {
    await assert.rejects(() => operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, payload), { code: 'invalid_local_operation_payload' });
  }
  assert.equal(calls.length, 0);
});
