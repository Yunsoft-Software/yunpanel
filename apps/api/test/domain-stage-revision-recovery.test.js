import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';

async function fixture(t, pinned = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-stage-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const domains = createDomainRegistry({ filePath: path.join(directory, 'domains.json'), serverExists: async () => true });
  const domain = await domains.createDomain({ serverId: 'server-1', primaryDomain: 'owned.example.com',
    targetType: 'static', target: { root: '/var/lib/yunpanel/apps/owned/current', spaFallback: true } });
  const payload = { primaryDomain: domain.primaryDomain, aliases: domain.aliases, targetType: domain.targetType,
    target: domain.target, nginxSettings: domain.nginxSettings, httpsRedirect: domain.httpsRedirect,
    canonicalRedirect: domain.canonicalRedirect, ...(pinned ? { domainRevision: domain.desiredRevision } : {}) };
  const preview = createNginxManager().previewDomain(payload);
  const options = { filePath: path.join(directory, 'jobs.json'), registryFactory: createJobRegistry, registryOptions: { serverExists: async () => true } };
  const jobs = createDurableJobRegistry(options); await jobs.init();
  const queued = await jobs.enqueue({ serverId: domain.serverId, type: 'domain.stage', operation: OPERATIONS.DOMAIN_STAGE,
    resourceType: 'domain', resourceId: domain.id, payload });
  await jobs.claimNext(domain.serverId); await jobs.beginReconciliation({ serverId: domain.serverId, jobId: queued.id });
  const job = await jobs.complete({ serverId: domain.serverId, jobId: queued.id, status: 'succeeded',
    result: { checksum: preview.checksum, configName: domain.primaryDomain + '.conf', bytes: Buffer.byteLength(preview.config) } });
  async function edit() {
    const changes = { nginxSettings: { clientMaxBodySizeMb: 16 } };
    const p = await domains.previewDomainUpdate({ domainId: domain.id, changes });
    return domains.updateDomain({ domainId: domain.id, changes, previewDigest: p.previewDigest });
  }
  return { domains, domain, job, edit, options };
}

for (const pinned of [true, false]) {
  test(`${pinned ? 'pinned' : 'legacy'} completed stage survives a cold restart without promoting an older config to the new draft`, async t => {
    const f = await fixture(t, pinned); await f.edit();
    const before = await f.domains.getDomain(f.domain.id);
    const cold = createDurableJobRegistry(f.options); await cold.init();
    const old = await cold.getJob(f.job.id); assert.equal(old.status, 'succeeded'); assert.equal(cold.recovery().jobs.length, 1);
    await reconcileCompletedJob({ domainRegistry: f.domains, job: old });
    assert.deepEqual(await f.domains.getDomain(f.domain.id), before);
    const ack = await cold.acknowledgeReconciliation({ serverId: old.serverId, jobId: old.id });
    assert.equal(ack.acknowledged, true); assert.equal(cold.recovery(), null);
    const next = await cold.enqueue({ serverId: old.serverId, type: 'system.packages.inspect',
      operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT, payload: {}, resourceType: 'system', resourceId: old.serverId });
    assert.equal(next.status, 'queued');
  });
}

test('a matching pinned stage marks only the exact current revision', async t => {
  const f = await fixture(t);
  await reconcileCompletedJob({ domainRegistry: f.domains, job: f.job });
  const current = await f.domains.getDomain(f.domain.id);
  assert.equal(current.desiredRevision, 1); assert.equal(current.stagedRevision, 1);
  assert.equal(current.stagedChecksum, f.job.result.checksum); assert.equal(current.state, 'staged');
});

test('an operator edit between inspection and persistence rejects the stage instead of labeling new settings with old bytes', async t => {
  const f = await fixture(t), original = f.domains.markStaged;
  const domains = { ...f.domains, markStaged: async (...args) => { await f.edit(); return original(...args); } };
  await assert.rejects(reconcileCompletedJob({ domainRegistry: domains, job: f.job }), { code: 'reconcile_domain_stage_revision_drift' });
  const current = await f.domains.getDomain(f.domain.id);
  assert.equal(current.desiredRevision, 2); assert.equal(current.stagedRevision, 0);
  assert.equal(current.nginxSettings.clientMaxBodySizeMb, 16);
});

test('a future stage revision and an incomplete legacy snapshot remain unreconciled', async t => {
  const f = await fixture(t);
  for (const payload of [{ ...f.job.payload, domainRevision: 2 }, { primaryDomain: f.domain.primaryDomain }]) {
    await assert.rejects(reconcileCompletedJob({ domainRegistry: f.domains, job: { ...f.job, payload } }));
    assert.equal((await f.domains.getDomain(f.domain.id)).stagedRevision, 0);
  }
});
test('the current revision number cannot disguise different prepared web server settings', async t => {
  const f = await fixture(t);
  const job = { ...f.job, payload: { ...f.job.payload,
    nginxSettings: { ...f.job.payload.nginxSettings, clientMaxBodySizeMb: 25 } } };
  await assert.rejects(reconcileCompletedJob({ domainRegistry: f.domains, job }), { code: 'reconcile_domain_stage_snapshot_drift' });
  const current = await f.domains.getDomain(f.domain.id);
  assert.equal(current.stagedRevision, 0); assert.equal(current.nginxSettings.clientMaxBodySizeMb, null);
});
