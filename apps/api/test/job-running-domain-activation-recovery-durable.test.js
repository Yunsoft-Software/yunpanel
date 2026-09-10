import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDomainActivationReceiptStore } from '../src/domain-activation-receipt.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { createJobRegistry } from '../src/job-registry.js';
import { recoverRunningDomainActivation } from '../src/job-running-domain-activation-recovery.js';
import { createServerRegistry } from '../src/server-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-activation-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverRegistry = createServerRegistry({ filePath: path.join(root, 'servers.json') });
  await serverRegistry.init();
  const server = await serverRegistry.createLocalServer({ hostname: 'domain-activation-recovery-host' });
  const domainRegistry = createDomainRegistry({
    filePath: path.join(root, 'domains.json'),
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
  const spec = {
    primaryDomain: domain.primaryDomain,
    aliases: domain.aliases,
    targetType: domain.targetType,
    target: domain.target,
  };
  const nginxManager = createNginxManager({
    stagingDir: path.join(root, 'nginx-staging'),
    sitesDir: path.join(root, 'nginx-sites'),
    execFn: async () => ({ stdout: '', stderr: '' }),
  });
  const staged = await nginxManager.stageDomain(spec);
  await domainRegistry.markStaged(domain.id, staged);

  const jobStore = path.join(root, 'jobs.json');
  const first = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await first.init();
  const queued = await first.enqueue({
    serverId: server.id,
    type: OPERATIONS.DOMAIN_ACTIVATE,
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: domain.primaryDomain, checksum: staged.checksum },
    resourceType: 'domain',
    resourceId: domain.id,
  });
  await first.claimNext(server.id);

  const hostResult = await nginxManager.activateDomain({ primaryDomain: domain.primaryDomain, checksum: staged.checksum });
  const receiptStore = createDomainActivationReceiptStore({ root: path.join(root, 'receipts') });
  await receiptStore.write({
    serverId: server.id,
    jobId: queued.id,
    primaryDomain: domain.primaryDomain,
    checksum: hostResult.checksum,
  });

  const restarted = createDurableJobRegistry({ filePath: jobStore, registryFactory: createJobRegistry });
  await restarted.init();
  assert.equal(restarted.recovery().jobs[0].jobId, queued.id);

  return {
    server,
    domain,
    staged,
    domainRegistry,
    jobId: queued.id,
    jobRegistry: restarted,
    contextReader: createJobRecoveryContextReader({ filePath: jobStore }),
    receiptStore,
    nginxManager,
  };
}

test('activation receipt plus exact active config closes durable job and applies staged domain revision', async (t) => {
  const fx = await fixture(t);
  const recovered = await recoverRunningDomainActivation({
    serverId: fx.server.id,
    jobId: fx.jobId,
    jobRegistry: fx.jobRegistry,
    domainRegistry: fx.domainRegistry,
    certificateRegistry: {},
    applicationRegistry: {},
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    loadJobContext: (id) => fx.contextReader.read(id),
    readActivationReceipt: (serverId, jobId) => fx.receiptStore.read(serverId, jobId),
    inspectActiveEvidence: (intent) => fx.nginxManager.inspectActiveDomain(intent),
  });

  assert.equal(recovered.status, 'succeeded');
  assert.equal(fx.jobRegistry.recovery(), null);
  const terminal = await fx.jobRegistry.getJob(fx.jobId);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(terminal.result.checksum, fx.staged.checksum);
  assert.equal(terminal.result.active, true);

  const domain = await fx.domainRegistry.getDomain(fx.domain.id);
  assert.equal(domain.state, 'active');
  assert.equal(domain.appliedRevision, domain.desiredRevision);
  assert.equal(domain.stagedChecksum, fx.staged.checksum);
});
