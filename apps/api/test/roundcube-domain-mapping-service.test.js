import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createRoundcubeDomainMappingRegistry } from '../src/roundcube-domain-mapping-registry.js';
import { createRoundcubeDomainMappingService } from '../src/roundcube-domain-mapping-service.js';

const mailDomainId = '11111111-1111-4111-8111-111111111111';
const webDomainId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const certificateId = '44444444-4444-4444-8444-444444444444';
const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fixture() {
  let clock = Date.parse('2026-09-19T16:00:00.000Z');
  const registry = createRoundcubeDomainMappingRegistry({
    now: () => clock++,
    getMailDomain: async () => ({
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'enabled',
      revision: 4,
    }),
    getDomain: async () => ({
      id: webDomainId,
      serverId,
      primaryDomain: 'example.com',
      desiredRevision: 8,
    }),
    getCertificate: async () => ({
      id: certificateId,
      domainId: webDomainId,
      serverId,
      state: 'active',
      staging: false,
      fingerprint256: fingerprint,
      updatedAt: '2026-09-19T15:00:00.000Z',
    }),
    inspectCertificate: async () => ({ fingerprint256: fingerprint }),
  });

  const jobs = new Map();
  let jobSequence = 0;
  const jobRegistry = {
    async enqueue(input) {
      jobSequence += 1;
      const now = new Date(clock++).toISOString();
      const job = {
        id: 'roundcube-job-' + jobSequence,
        ...input,
        status: 'queued',
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      jobs.set(job.id, job);
      return { ...job };
    },
    async listJobs({ serverId: requestedServerId }) {
      return [...jobs.values()].filter((job) => job.serverId === requestedServerId).map((job) => ({ ...job }));
    },
    async getJob(id) {
      const job = jobs.get(id);
      return job ? { ...job } : null;
    },
  };

  const roundcubeConfigurationService = {
    async previewForServer(requestedServerId) {
      assert.equal(requestedServerId, serverId);
      const desired = await registry.listMappings({ serverId });
      const mappings = desired.map((mapping) => ({
        id: mapping.id,
        mailDomainId: mapping.mailDomainId,
        webDomainId: mapping.webDomainId,
        hostname: mapping.hostname,
        certificateId: mapping.certificateId,
        certificateFingerprint256: mapping.certificateFingerprint256,
        revision: mapping.revision,
        updatedAt: mapping.updatedAt,
      }));
      const identity = { serverId, mappings };
      const previewSha256 = sha(identity);
      return {
        readyToApply: true,
        sha256: previewSha256,
        configSha256: 'c'.repeat(64),
        fpmSha256: 'd'.repeat(64),
        nginxSha256: sha({ nginx: identity }),
        configuration: { sha256: 'c'.repeat(64) },
        fpm: { sha256: 'd'.repeat(64) },
        mappings,
      };
    },
  };

  const service = createRoundcubeDomainMappingService({
    registry,
    roundcubeConfigurationService,
    jobRegistry,
  });

  function finishJob(id, status = 'succeeded') {
    const job = jobs.get(id);
    assert.ok(job);
    const result = status === 'succeeded'
      ? {
        previewSha256: job.payload.previewSha256,
        configSha256: job.payload.configSha256,
        fpmSha256: job.payload.fpmSha256,
        nginxSha256: null,
        databaseCreated: false,
        httpHealthy: true,
        applied: true,
        sideEffects: true,
      }
      : null;
    jobs.set(id, {
      ...job,
      status,
      result,
      updatedAt: new Date(clock++).toISOString(),
    });
  }

  async function finishExact(id, status = 'succeeded') {
    const record = await registry.getRecordForMailDomain(mailDomainId);
    const job = jobs.get(id);
    jobs.set(id, {
      ...job,
      status,
      result: status === 'succeeded' ? {
        previewSha256: record.expectedRoundcubePreviewSha256,
        configSha256: job.payload.configSha256,
        fpmSha256: job.payload.fpmSha256,
        nginxSha256: record.expectedRoundcubeNginxSha256,
        databaseCreated: false,
        httpHealthy: true,
        applied: true,
        sideEffects: true,
      } : null,
      updatedAt: new Date(clock++).toISOString(),
    });
  }

  return { registry, service, jobs, finishJob, finishExact };
}

async function beginBinding(service) {
  const preview = await service.previewBind({ mailDomainId, certificateId });
  return service.beginBind({
    mailDomainId,
    certificateId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
}

test('bind requires explicit continuation to queue and later finalize exact Roundcube apply evidence', async () => {
  const state = fixture();
  const begun = await beginBinding(state.service);

  assert.equal(begun.mapping.state, 'pending');
  assert.match(begun.actions.continuation, /^continue-roundcube-domain:/);
  assert.equal(await state.registry.getForMailDomain(mailDomainId), null);

  const queued = await state.service.continueOperation({
    mailDomainId,
    operationId: begun.mapping.operationId,
    expectedUpdatedAt: begun.mapping.updatedAt,
    confirmation: begun.actions.continuation,
  });
  assert.equal(queued.job.status, 'queued');
  assert.equal(queued.actions.continuation, null);

  const attached = await state.registry.getRecordForMailDomain(mailDomainId);
  assert.equal(attached.updatedAt, begun.mapping.updatedAt);
  assert.equal(attached.applyJobId, queued.job.id);

  await state.finishExact(queued.job.id);
  const inspected = await state.service.inspect(mailDomainId);
  assert.equal(inspected.job.status, 'succeeded');
  assert.match(inspected.actions.continuation, /^continue-roundcube-domain:/);

  const active = await state.service.continueOperation({
    mailDomainId,
    operationId: inspected.mapping.operationId,
    expectedUpdatedAt: inspected.mapping.updatedAt,
    confirmation: inspected.actions.continuation,
  });
  assert.equal(active.activated, true);
  assert.equal(active.mapping.state, 'active');
  assert.equal(active.mapping.updatedAt, begun.mapping.updatedAt);
  assert.equal((await state.registry.getForMailDomain(mailDomainId)).state, 'active');
});

test('delete makes DNS mapping inactive before host cleanup and finalizes only after exact apply', async () => {
  const state = fixture();
  const begun = await beginBinding(state.service);
  let queued = await state.service.continueOperation({
    mailDomainId,
    operationId: begun.mapping.operationId,
    expectedUpdatedAt: begun.mapping.updatedAt,
    confirmation: begun.actions.continuation,
  });
  await state.finishExact(queued.job.id);
  let inspected = await state.service.inspect(mailDomainId);
  await state.service.continueOperation({
    mailDomainId,
    operationId: inspected.mapping.operationId,
    expectedUpdatedAt: inspected.mapping.updatedAt,
    confirmation: inspected.actions.continuation,
  });

  const preview = await state.service.previewDelete(mailDomainId);
  const removing = await state.service.beginDelete(mailDomainId, {
    expectedRevision: preview.revision,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(removing.mapping.state, 'removing');
  assert.equal(await state.registry.getForMailDomain(mailDomainId), null);
  assert.deepEqual(await state.registry.listMappings({ serverId }), []);

  queued = await state.service.continueOperation({
    mailDomainId,
    operationId: removing.mapping.operationId,
    expectedUpdatedAt: removing.mapping.updatedAt,
    confirmation: removing.actions.continuation,
  });
  await state.finishExact(queued.job.id);
  inspected = await state.service.inspect(mailDomainId);
  const deleted = await state.service.continueOperation({
    mailDomainId,
    operationId: inspected.mapping.operationId,
    expectedUpdatedAt: inspected.mapping.updatedAt,
    confirmation: inspected.actions.continuation,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.mapping.state, 'removed');
  assert.equal(deleted.actions.continuation, null);
  assert.deepEqual(
    await state.registry.getRecordForMailDomain(mailDomainId),
    deleted.mapping,
  );
  assert.equal(await state.registry.getForMailDomain(mailDomainId), null);
});

test('failed apply remains durable and explicit continuation queues a new job only if desired state is unchanged', async () => {
  const state = fixture();
  const begun = await beginBinding(state.service);
  const queued = await state.service.continueOperation({
    mailDomainId,
    operationId: begun.mapping.operationId,
    expectedUpdatedAt: begun.mapping.updatedAt,
    confirmation: begun.actions.continuation,
  });
  await state.finishExact(queued.job.id, 'failed');

  const inspected = await state.service.inspect(mailDomainId);
  assert.equal(inspected.job.status, 'failed');
  const retried = await state.service.continueOperation({
    mailDomainId,
    operationId: inspected.mapping.operationId,
    expectedUpdatedAt: inspected.mapping.updatedAt,
    confirmation: inspected.actions.continuation,
  });
  assert.notEqual(retried.job.id, queued.job.id);
  assert.equal(retried.job.status, 'queued');
});

test('queued or running apply is inspection-only and cannot be duplicated by continuation', async () => {
  const state = fixture();
  const begun = await beginBinding(state.service);
  const queued = await state.service.continueOperation({
    mailDomainId,
    operationId: begun.mapping.operationId,
    expectedUpdatedAt: begun.mapping.updatedAt,
    confirmation: begun.actions.continuation,
  });
  const stored = state.jobs.get(queued.job.id);
  state.jobs.set(queued.job.id, { ...stored, status: 'running' });

  const inspected = await state.service.inspect(mailDomainId);
  assert.equal(inspected.job.status, 'running');
  assert.equal(inspected.actions.continuation, null);
  assert.equal(state.jobs.size, 1);
});
