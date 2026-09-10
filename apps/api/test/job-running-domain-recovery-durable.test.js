import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { recoverRunningDomainStage } from '../src/job-running-domain-recovery.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverStore = path.join(root, 'servers.json');
  const domainStore = path.join(root, 'domains.json');
  const jobStore = path.join(root, 'jobs.json');
  const stagingDir = path.join(root, 'nginx-staging');
  const sitesDir = path.join(root, 'nginx-sites');

  const serverRegistry = createServerRegistry({ filePath: serverStore });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'recovery-host' });
  const domainRegistry = createDomainRegistry({
    filePath: domainStore,
    serverExists: async (id) => Boolean(await serverRegistry.getServer(id)),
  });
  await domainRegistry.init();
  const domain = await domainRegistry.createDomain({
    serverId: server.id,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 3000, websocket: true },
  });
  const payload = {
    primaryDomain: domain.primaryDomain,
    aliases: domain.aliases,
    targetType: domain.targetType,
    target: domain.target,
  };

  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: OPERATIONS.DOMAIN_STAGE,
    operation: OPERATIONS.DOMAIN_STAGE,
    payload,
    resourceType: 'domain',
    resourceId: domain.id,
  });
  const claimed = await first.claimNext(server.id);
  assert.equal(claimed.job.id, queued.id);

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    server,
    domain,
    payload,
    jobId: queued.id,
    jobRegistry: restarted,
    domainRegistry,
    nginxManager: createNginxManager({ stagingDir, sitesDir }),
  };
}

function stoppedServices() {
  return { apiActive: false, agentActive: false };
}

test('exact staged Nginx evidence closes the same durable job and reconciles domain state', async (t) => {
  const fx = await fixture(t);
  const staged = await fx.nginxManager.stageDomain(fx.payload);

  const recovered = await recoverRunningDomainStage({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    domainRegistry: fx.domainRegistry,
    certificateRegistry: {},
    applicationRegistry: {},
    serviceStatus: async () => stoppedServices(),
    inspectStageEvidence: (payload) => fx.nginxManager.inspectStagedDomain(payload),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.reconciled, true);
  assert.equal(fx.jobRegistry.recovery(), null);
  assert.deepEqual(fx.jobRegistry.recoveryRecord().jobs, []);

  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.configName, staged.configName);
  assert.equal(terminal.result.checksum, staged.checksum);

  const domain = await fx.domainRegistry.getDomain(fx.domain.id);
  assert.equal(domain.state, 'staged');
  assert.equal(domain.stagedChecksum, staged.checksum);
  assert.equal(domain.stagedConfigName, staged.configName);
  assert.equal(domain.stagedRevision, domain.desiredRevision);
});

test('absent staged evidence preserves running durable recovery without resource mutation', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    recoverRunningDomainStage({
      serverId: fx.server.id,
      jobId: fx.jobId,
      jobRegistry: fx.jobRegistry,
      domainRegistry: fx.domainRegistry,
      certificateRegistry: {},
      applicationRegistry: {},
      serviceStatus: async () => stoppedServices(),
      inspectStageEvidence: (payload) => fx.nginxManager.inspectStagedDomain(payload),
    }),
    { code: 'job_domain_recovery_evidence_not_satisfied' },
  );

  assert.equal((await fx.jobRegistry.getJob(fx.jobId)).status, 'running');
  assert.equal(fx.jobRegistry.recovery().jobs[0].jobId, fx.jobId);
  const domain = await fx.domainRegistry.getDomain(fx.domain.id);
  assert.equal(domain.state, 'draft');
  assert.equal(domain.stagedChecksum, null);
});
