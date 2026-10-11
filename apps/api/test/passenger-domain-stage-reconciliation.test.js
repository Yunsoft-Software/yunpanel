import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { jobReconciliationInternals, reconcileCompletedJob } from '../src/job-reconciliation.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createNginxManager } from '@yunpanel/host-runtime';
import { resolveWebsiteDomainTarget } from '../src/website-domain-target.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRecoveryContextReader } from '../src/job-recovery-context.js';
import { recoverRunningDomainStage } from '../src/job-running-domain-recovery.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const otherDomainId = '0ec761cd-766b-43ba-8b35-066b6c832d32';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const jobId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const oldChecksum = 'a'.repeat(64);
const newChecksum = 'b'.repeat(64);
const otherChecksum = 'c'.repeat(64);
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
});

function stagedDomain(overrides = {}) {
  return {
    id: domainId,
    serverId,
    websiteId,
    desiredRevision: 5,
    stagedRevision: 5,
    stagedChecksum: newChecksum,
    state: 'staged',
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    applicationId,
    serverId,
    adapter: 'passenger',
    state: 'cleanup_required',
    revision: 7,
    sourceOperationId: '8d249087-73db-4ca8-8039-8e1d9aa33a42',
    releaseId,
    websiteId,
    websiteRevision: 3,
    domains: [
      { domainId, desiredRevision: 4, nginxChecksum: oldChecksum },
      { domainId: otherDomainId, desiredRevision: 2, nginxChecksum: otherChecksum },
    ],
    passengerTarget,
    ...overrides,
  };
}

function passengerStageJob(overrides = {}) {
  return {
    id: jobId,
    serverId,
    operation: OPERATIONS.DOMAIN_STAGE,
    resourceType: 'domain',
    resourceId: domainId,
    status: 'succeeded',
    payload: {
      targetType: 'passenger',
      target: { ...passengerTarget },
    },
    result: { checksum: newChecksum, configName: 'example.com.conf', bytes: 512 },
    ...overrides,
  };
}

function dependencies({ currentBinding = binding(), applicationOverrides = {} } = {}) {
  const activations = [];
  return {
    activations,
    applicationRegistry: {
      async getApplication(id) {
        return id === applicationId ? { id: applicationId, serverId, type: 'node', currentReleaseId: releaseId, ...applicationOverrides } : null;
      },
    },
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? { id: websiteId, serverId, revision: 3, runtimeType: 'node', applicationId, unixUser: passengerTarget.user } : null;
      },
    },
    runtimeBindingRegistry: {
      async getBinding(id) { return id === applicationId ? currentBinding : null; },
      async activate(input, options) {
        activations.push({ input, options });
        return { ...input, revision: (options.expectedRevision ?? 0) + 1 };
      },
    },
  };
}

test('Passenger Domain stage advances only the staged Domain binding evidence', async () => {
  const deps = dependencies();
  const result = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job: passengerStageJob(),
    domain: stagedDomain(),
    ...deps,
  });

  assert.equal(result.revision, 8);
  assert.equal(deps.activations.length, 1);
  const [{ input, options }] = deps.activations;
  assert.equal(options.expectedRevision, 7);
  assert.equal(input.state, 'cleanup_required');
  assert.equal(input.sourceOperationId, binding().sourceOperationId);
  assert.deepEqual(input.passengerTarget, passengerTarget);
  assert.deepEqual(input.domains, [
    { domainId, desiredRevision: 5, nginxChecksum: newChecksum },
    { domainId: otherDomainId, desiredRevision: 2, nginxChecksum: otherChecksum },
  ]);
});

function attachmentDependencies(bindingOverrides = {}) {
  return dependencies({ currentBinding: binding({ state: 'active', domains: [binding().domains[1]], ...bindingOverrides }),
    applicationOverrides: { runtimeAdapter: 'passenger', state: 'active', activeDeploymentId: null } });
}
function attachmentJob() {
  return passengerStageJob({ payload: { targetType: 'passenger', target: { ...passengerTarget }, domainRevision: 5,
    passengerAttachment: { serverId, domainId, applicationId, websiteId, releaseId, websiteRevision: 3, bindingRevision: 7, domainRevision: 5 } } });
}

test('new Domain stage appends only its pinned evidence and repeated reconciliation is idempotent', async () => {
  const deps = attachmentDependencies(), job = attachmentJob(), domain = stagedDomain({ appliedRevision: 0 });
  const result = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job, domain, ...deps });
  assert.deepEqual(result.domains, [binding().domains[1], { domainId, desiredRevision: 5, nginxChecksum: newChecksum }]);
  const replay = attachmentDependencies(result);
  const repeated = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job, domain, ...replay });
  assert.equal(repeated.revision, 8);
  assert.equal(replay.activations.length, 0);
});

for (const [field, value] of [
  ['serverId', otherDomainId], ['domainId', otherDomainId], ['applicationId', otherDomainId],
  ['websiteId', otherDomainId], ['releaseId', otherDomainId], ['websiteRevision', 4],
  ['bindingRevision', 6], ['domainRevision', 4], ['extra', true],
]) {
  test(`new Domain attachment rejects drifted ${field}`, async () => {
    const deps = attachmentDependencies(), job = attachmentJob(); job.payload.passengerAttachment[field] = value;
    await assert.rejects(jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job,
      domain: stagedDomain({ appliedRevision: 0 }), ...deps }), { code: 'passenger_domain_attachment_drift' });
    assert.equal(deps.activations.length, 0);
  });
}

test('missing evidence without an attachment pin remains rejected', async () => {
  const deps = attachmentDependencies();
  await assert.rejects(jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job: passengerStageJob(),
    domain: stagedDomain({ appliedRevision: 0 }), ...deps }), { code: 'passenger_domain_stage_revision_drift' });
  assert.equal(deps.activations.length, 0);
});

test('changed runtime binding revision rejects attachment even when release and target are unchanged', async () => {
  const deps = attachmentDependencies({ revision: 8 });
  await assert.rejects(jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job: attachmentJob(),
    domain: stagedDomain({ appliedRevision: 0 }), ...deps }), { code: 'passenger_domain_attachment_drift' });
  assert.equal(deps.activations.length, 0);
});

for (const interrupted of [false, true]) test(`${interrupted ? 'cold interrupted' : 'normal'} second Domain queue, protocol, stage reconciliation and activation preserve existing runtime evidence`, async t => {
  const lockRoot = path.join(os.tmpdir(), 'yp-domain-attach-' + randomUUID()); t.after(() => rm(lockRoot, { recursive: true, force: true }));
  const deps = attachmentDependencies(), website = await deps.websiteRegistry.getWebsite(websiteId);
  const domains = createDomainRegistry({ serverExists: async id => id === serverId,
    getWebsite: deps.websiteRegistry.getWebsite });
  const domain = await domains.createDomain({ domainId, serverId, websiteId, primaryDomain: 'second.example.com',
    targetType: 'passenger', target: { applicationId } });
  const third = await domains.createDomain({ serverId, websiteId, primaryDomain: 'third.example.com',
    targetType: 'passenger', target: { applicationId } });
  const bindings = createApplicationRuntimeBindingRegistry();
  const original = await bindings.activate({ ...binding({ state: 'active', domains: [binding().domains[1]] }), revision: undefined }, { expectedRevision: 0 });
  const jobPath = path.join(lockRoot, 'jobs.json');
  const makeJobs = () => createDurableJobRegistry({ filePath: jobPath,
    registryFactory: options => createJobRegistry({ ...options, serverExists: async id => id === serverId }) });
  const jobs = makeJobs(); await jobs.init();
  const queue = createDomainStageTargetJobRegistry({ registry: jobs, domainRegistry: domains,
    websiteRegistry: deps.websiteRegistry, applicationRegistry: deps.applicationRegistry,
    runtimeBindingRegistry: bindings, dockerComposeProjectRegistry: { getProject: async () => null }, siteMutationLock: createSiteMutationLock({ root: lockRoot }) });
  const input = value => ({ serverId, type: 'domain.stage', operation: OPERATIONS.DOMAIN_STAGE,
    resourceType: 'domain', resourceId: value.id, payload: { primaryDomain: value.primaryDomain,
      aliases: value.aliases, targetType: value.targetType, target: value.target,
      nginxSettings: value.nginxSettings, httpsRedirect: value.httpsRedirect, canonicalRedirect: value.canonicalRedirect } });
  const queued = await queue.enqueue(input(domain));
  await assert.rejects(queue.enqueue(input(third)), { code: 'passenger_domain_routing_busy' });
  assert.equal((await jobs.listJobs()).length, 1);
  const claimed = await jobs.claimNext(serverId), preview = createNginxManager().previewDomain(claimed.envelope.payload);
  assert.equal(claimed.job.id, queued.id);
  const result = { checksum: preview.checksum, configName: 'second.example.com.conf', bytes: Buffer.byteLength(preview.config) };
  if (interrupted) {
    const cold = makeJobs(), reader = createJobRecoveryContextReader({ filePath: jobPath });
    const recovered = await recoverRunningDomainStage({ serverId, jobId: queued.id, jobRegistry: cold,
      domainRegistry: domains, certificateRegistry: {}, applicationRegistry: deps.applicationRegistry,
      websiteRegistry: deps.websiteRegistry, runtimeBindingRegistry: bindings,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      loadJobContext: id => reader.read(id), inspectStageEvidence: async () => ({ satisfied: true, result }) });
    assert.equal(recovered.reconciled, true); assert.equal(cold.recovery(), null);
  } else {
    await jobs.beginReconciliation({ serverId, jobId: queued.id });
    const completed = await jobs.complete({ serverId, jobId: queued.id, status: 'succeeded', result });
    await reconcileCompletedJob({ domainRegistry: domains, applicationRegistry: deps.applicationRegistry,
      websiteRegistry: deps.websiteRegistry, runtimeBindingRegistry: bindings, job: completed });
    await jobs.acknowledgeReconciliation({ serverId, jobId: queued.id });
  }
  await reconcileCompletedJob({ domainRegistry: domains, job: { id: jobId, serverId, operation: OPERATIONS.DOMAIN_ACTIVATE,
    resourceType: 'domain', resourceId: domainId, status: 'succeeded', result: { checksum: preview.checksum } } });
  const active = await domains.getDomain(domainId), current = await bindings.getBinding(applicationId);
  assert.equal(active.state, 'active'); assert.equal(active.appliedRevision, active.desiredRevision);
  assert.equal(current.revision, original.revision + 1); assert.deepEqual(current.domains.find(d => d.domainId === otherDomainId), original.domains[0]);
  const target = await resolveWebsiteDomainTarget({ domain: active, websiteRegistry: deps.websiteRegistry,
    applicationRegistry: deps.applicationRegistry, runtimeBindingRegistry: bindings });
  assert.equal(target.target.user, website.unixUser); assert.deepEqual(target.target, passengerTarget);
  const next = await queue.enqueue(input(third));
  assert.equal(next.payload.passengerAttachment.bindingRevision, current.revision);
  assert.equal(next.payload.passengerAttachment.domainId, third.id);
});

test('non-Passenger Domain stage leaves runtime binding untouched', async () => {
  const deps = dependencies();
  const result = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job: passengerStageJob({ payload: { targetType: 'proxy', target: { upstreamHost: '127.0.0.1', upstreamPort: 3100 } } }),
    domain: stagedDomain(),
    ...deps,
  });
  assert.equal(result, null);
  assert.equal(deps.activations.length, 0);
});

test('Passenger Domain stage fails closed when queued target no longer matches runtime authority', async () => {
  const deps = dependencies();
  await assert.rejects(
    jobReconciliationInternals.reconcilePassengerDomainStageBinding({
      job: passengerStageJob({
        payload: {
          targetType: 'passenger',
          target: { root: '/var/lib/yunpanel/apps/wrong/current', startupFile: 'server.js', nodeBinary: passengerTarget.nodeBinary },
        },
      }),
      domain: stagedDomain(),
      ...deps,
    }),
    (error) => error?.code === 'passenger_domain_stage_target_drift',
  );
  assert.equal(deps.activations.length, 0);
});

for (const [field, value] of [
  ['appRoot', '/var/lib/yunpanel/apps/foreign/current'],
  ['documentRoot', '/var/lib/yunpanel/apps/foreign/current/public'],
  ['startupFile', 'foreign.js'], ['nodeBinary', '/foreign/bin/node'],
  ['user', 'root'], ['group', 'root'], ['appEnv', 'foreign'],
  ['environmentInclude', '/etc/yunpanel/passenger-env/foreign.conf'],
]) {
  test(`Passenger Domain stage rejects changed ${field} before advancing traffic authority`, async () => {
    const deps = dependencies();
    const job = passengerStageJob(); job.payload.target[field] = value;
    await assert.rejects(jobReconciliationInternals.reconcilePassengerDomainStageBinding({
      job, domain: stagedDomain(), ...deps }), { code: 'passenger_domain_stage_target_drift' });
    assert.equal(deps.activations.length, 0);
  });
}
test('Passenger Domain stage rejects a Website Unix identity change even when the whole queued target matches the binding', async () => {
  const deps = dependencies();
  const original = deps.websiteRegistry.getWebsite;
  deps.websiteRegistry.getWebsite = async id => ({ ...await original(id), unixUser: 'yunapp-abcdef123456' });
  await assert.rejects(jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job: passengerStageJob(), domain: stagedDomain(), ...deps }), { code: 'passenger_domain_stage_target_drift' });
  assert.equal(deps.activations.length, 0);
});
test('complete Passenger routing fields compare by value across serialization ordering', async () => {
  const deps = dependencies(), job = passengerStageJob();
  job.payload.target = Object.fromEntries(Object.entries(job.payload.target).reverse());
  await jobReconciliationInternals.reconcilePassengerDomainStageBinding({ job, domain: stagedDomain(), ...deps });
  assert.equal(deps.activations.length, 1);
});

test('completed Passenger Domain stage updates Domain state then runtime binding evidence', async () => {
  const deps = dependencies();
  const events = [];
  const domainRegistry = {
    async markStaged(id, evidence) {
      events.push({ type: 'domain', id, evidence });
      return stagedDomain();
    },
    async markFailed() { throw new Error('markFailed should not run'); },
  };
  const runtimeBindingRegistry = {
    ...deps.runtimeBindingRegistry,
    async activate(input, options) {
      events.push({ type: 'binding', input, options });
      return { ...input, revision: options.expectedRevision + 1 };
    },
  };

  const result = await reconcileCompletedJob({
    domainRegistry,
    certificateRegistry: {},
    applicationRegistry: deps.applicationRegistry,
    websiteRegistry: deps.websiteRegistry,
    runtimeBindingRegistry,
    job: passengerStageJob(),
  });

  assert.deepEqual(result, { reconciled: true, error: null });
  assert.equal(events[0].type, 'domain');
  assert.equal(events[1].type, 'binding');
  assert.equal(events[1].input.domains[0].desiredRevision, 5);
  assert.equal(events[1].input.domains[0].nginxChecksum, newChecksum);
});
