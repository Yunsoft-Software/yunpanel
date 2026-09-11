import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningNodeRuntimeInstall } from '../src/job-running-node-runtime-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

function inventory({ installed = true, panelPath = '/usr/local/bin/node' } = {}) {
  return {
    platform: 'linux',
    architecture: 'x64',
    supportedMajors: [22, 24],
    panelRuntime: { path: panelPath, source: 'panel', version: 'v24.18.1', major: 24 },
    systemRuntime: { path: '/usr/bin/node', source: 'system', version: 'v22.23.2', major: 22 },
    managedRuntimes: [
      { major: 22, installed: false, path: '/opt/yunpanel/node-runtimes/v22/bin/node', version: null, packageManagers: [] },
      { major: 24, installed, path: '/opt/yunpanel/node-runtimes/v24/bin/node', version: installed ? 'v24.21.0' : null, packageManagers: installed ? ['npm', 'pnpm', 'yarn'] : [] },
    ],
  };
}

function fixture({ evidence = inventory(), consumersActive = false } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() { events.push('get'); return { id: jobId, serverId, status, operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, resourceType: 'system', resourceId: serverId }; },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) { events.push('complete'); status = input.status; return { id: jobId, serverId, status, operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, resourceType: 'system', resourceId: serverId, result: input.result }; },
    async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status: 'succeeded', acknowledged: true }; },
  };
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: consumersActive, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, resourceType: 'system', resourceId: serverId }] }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: OPERATIONS.SYSTEM_NODE_RUNTIME_INSTALL, resourceType: 'system', resourceId: serverId, payload: { major: 24 } };
      },
      inspectNodeRuntimes: async () => { events.push('inspect'); return evidence; },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true }; },
    },
  };
}

test('Node runtime install recovery closes only exact verified managed final state', async () => {
  const fx = fixture();
  const recovered = await recoverRunningNodeRuntimeInstall(fx.options);
  assert.equal(recovered.major, 24);
  assert.equal(recovered.recoveryMethod, 'verified_managed_node_runtime');
  assert.deepEqual(fx.events, ['get', 'context', 'inspect', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing runtime or panel runtime drift leaves installation unresolved', async () => {
  for (const evidence of [inventory({ installed: false }), inventory({ panelPath: '/tmp/node' })]) {
    const fx = fixture({ evidence });
    await assert.rejects(recoverRunningNodeRuntimeInstall(fx.options), { code: 'job_node_runtime_recovery_evidence_not_satisfied' });
    assert.deepEqual(fx.events, ['get', 'context', 'inspect']);
  }
});

test('active command consumer blocks Node runtime recovery before durable state access', async () => {
  const fx = fixture({ consumersActive: true });
  await assert.rejects(recoverRunningNodeRuntimeInstall(fx.options), { code: 'job_node_runtime_recovery_consumers_must_be_stopped' });
  assert.deepEqual(fx.events, []);
});
