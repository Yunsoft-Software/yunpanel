import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeServiceName } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningNodeProcess } from '../src/job-running-node-process-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

test('verified stopped state closes the same persisted process job after API restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-process-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'node-process-recovery-host' });
  const applicationRegistry = createApplicationRegistry({
    filePath: path.join(root, 'applications.json'),
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await applicationRegistry.init();
  const created = await applicationRegistry.createNodeApplication({
    serverId: server.id,
    name: 'Node Process Recovery',
    repositoryUrl: 'https://github.com/Yunsoft-Software/node-process-recovery',
    runtime: { port: 34124, healthPath: '/health' },
  });
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  await applicationRegistry.markDeploying(created.id, releaseId);
  await applicationRegistry.markDeployed(created.id, {
    deploymentId: releaseId,
    releaseId,
    commitSha: '3'.repeat(40),
    serviceName: nodeServiceName(created.id),
    port: created.runtime.port,
    healthPath: created.runtime.healthPath,
    healthy: true,
  });
  const application = await applicationRegistry.getApplication(created.id);

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: 'app.node.process',
    operation: OPERATIONS.APP_NODE_PROCESS,
    payload: { applicationId: application.id, releaseId, runtime: application.activeRuntime, action: 'stop' },
    resourceType: 'application',
    resourceId: application.id,
  });
  await first.claimNext(server.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);
  const contextReader = createJobRecoveryContextReader({ filePath: jobStore });
  const recovered = await recoverRunningNodeProcess({
    serverId: server.id,
    jobId: queued.id,
    jobRegistry: restarted,
    applicationRegistry,
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    loadJobContext: (id) => contextReader.read(id),
    inspectNodeProcess: async (intent) => ({
      releaseId: intent.releaseId,
      serviceName: nodeServiceName(application.id),
      action: intent.action,
      port: intent.runtime.port,
      healthPath: intent.runtime.healthPath,
      loadState: 'loaded',
      activeState: 'inactive',
      subState: 'dead',
      unitFileState: 'enabled',
      mainPid: 0,
      enabled: true,
      active: false,
      healthy: false,
    }),
  });

  assert.equal(recovered.recoveryMethod, 'verified_node_process_state');
  assert.equal(restarted.recovery(), null);
  const terminal = await restarted.getJob(queued.id);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.action, 'stop');
  assert.equal(terminal.result.active, false);
  assert.equal((await applicationRegistry.getApplication(application.id)).currentReleaseId, releaseId);
});
