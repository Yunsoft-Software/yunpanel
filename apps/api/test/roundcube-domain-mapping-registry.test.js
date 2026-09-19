import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRoundcubeDomainMappingRegistry,
  RoundcubeDomainMappingRegistryError,
} from '../src/roundcube-domain-mapping-registry.js';

const mailDomainId = '11111111-1111-4111-8111-111111111111';
const webDomainId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const certificateId = '44444444-4444-4444-8444-444444444444';
const provisioningOperationId = '55555555-5555-4555-8555-555555555555';
const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');

function fixture({
  mailStatus = 'enabled',
  certificateState = 'active',
  certificatePurpose = 'webmail',
  inspectedFingerprint = fingerprint,
  now = (() => {
    let value = Date.parse('2026-09-19T14:00:00.000Z');
    return () => value++;
  })(),
} = {}) {
  return createRoundcubeDomainMappingRegistry({
    now,
    getMailDomain: async () => ({
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: mailStatus,
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
      state: certificateState,
      purpose: certificatePurpose,
      staging: false,
      fingerprint256: fingerprint,
      updatedAt: '2026-09-19T13:00:00.000Z',
    }),
    inspectCertificate: async ({ certificate, domains }) => {
      assert.equal(certificate.id, certificateId);
      assert.deepEqual(domains, ['webmail.example.com']);
      return { fingerprint256: inspectedFingerprint };
    },
  });
}

async function begin(registry) {
  const preview = await registry.previewBind({ mailDomainId, certificateId });
  return registry.beginBind({
    mailDomainId,
    certificateId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
}

function successfulJob(mapping, id = 'roundcube-job-1') {
  return {
    id,
    serverId,
    operation: 'roundcube.config.apply',
    resourceType: 'server',
    resourceId: serverId,
    status: 'succeeded',
    result: {
      previewSha256: mapping.expectedRoundcubePreviewSha256,
      nginxSha256: mapping.expectedRoundcubeNginxSha256,
      httpHealthy: true,
      applied: true,
    },
  };
}

test('bind preview pins exact local mail, Domain and certificate evidence without material paths', async () => {
  const registry = fixture();
  const preview = await registry.previewBind({ mailDomainId, certificateId });

  assert.equal(preview.hostname, 'webmail.example.com');
  assert.equal(preview.currentRevision, 0);
  assert.equal(preview.mailDomainRevision, 4);
  assert.equal(preview.domainRevision, 8);
  assert.equal(preview.certificateFingerprint256, fingerprint);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmation, /^bind-roundcube-domain:/);
  assert.equal(JSON.stringify(preview).includes('privkey'), false);
  assert.equal(JSON.stringify(preview).includes('/etc/letsencrypt'), false);
});

test('bind may be owned by an exact parent provisioning operation identity', async () => {
  const registry = fixture();
  const preview = await registry.previewBind({ mailDomainId, certificateId });
  const pending = await registry.beginBind({
    mailDomainId,
    certificateId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
    operationId: provisioningOperationId,
  });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.operationId, provisioningOperationId);
  assert.equal((await registry.getRecordForMailDomain(mailDomainId)).operationId, provisioningOperationId);
});

test('bind is pending until exact Roundcube apply evidence activates the mapping', async () => {
  const registry = fixture();
  const pending = await begin(registry);

  assert.equal(pending.state, 'pending');
  assert.match(pending.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(await registry.getForMailDomain(mailDomainId), null);
  assert.equal((await registry.listMappings({ serverId })).length, 1);
  assert.equal((await registry.listActiveMappings({ serverId })).length, 0);

  const attached = await registry.attachApplyJob(mailDomainId, {
    operationId: pending.operationId,
    jobId: 'roundcube-job-1',
    previewSha256: 'a'.repeat(64),
    nginxSha256: 'b'.repeat(64),
  });
  assert.equal(attached.applyJobId, 'roundcube-job-1');

  await assert.rejects(
    registry.completeApply(mailDomainId, {
      operationId: pending.operationId,
      job: {
        ...successfulJob(attached),
        result: { ...successfulJob(attached).result, previewSha256: 'f'.repeat(64) },
      },
    }),
    (error) => error instanceof RoundcubeDomainMappingRegistryError
      && error.code === 'roundcube_mapping_apply_evidence_invalid',
  );

  const active = await registry.completeApply(mailDomainId, {
    operationId: pending.operationId,
    job: successfulJob(attached),
  });
  assert.equal(active.state, 'active');
  assert.equal(active.operationId, null);
  assert.equal((await registry.listActiveMappings({ serverId })).length, 1);
  assert.deepEqual(await registry.getForMailDomain(mailDomainId), active);
});

test('mapping requires enabled local mail and an active hostname-covering certificate', async () => {
  await assert.rejects(
    fixture({ mailStatus: 'disabled' }).previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_mail_domain_not_ready',
  );
  await assert.rejects(
    fixture({ certificateState: 'superseded' }).previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_certificate_not_ready',
  );
  await assert.rejects(
    fixture({ certificatePurpose: 'web' }).previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_certificate_not_ready',
  );
  await assert.rejects(
    fixture({ inspectedFingerprint: Array.from({ length: 32 }, () => 'BB').join(':') })
      .previewBind({ mailDomainId, certificateId }),
    (error) => error.code === 'roundcube_mapping_certificate_drift',
  );
});

test('delete hides mapping from desired/DNS state until exact Roundcube apply proves removal', async () => {
  const registry = fixture();
  const pending = await begin(registry);
  let current = await registry.attachApplyJob(mailDomainId, {
    operationId: pending.operationId,
    jobId: 'roundcube-job-1',
    previewSha256: 'a'.repeat(64),
    nginxSha256: 'b'.repeat(64),
  });
  current = await registry.completeApply(mailDomainId, {
    operationId: pending.operationId,
    job: successfulJob(current),
  });

  const preview = await registry.previewDelete(mailDomainId);
  const removing = await registry.beginDelete(mailDomainId, {
    expectedRevision: current.revision,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(removing.state, 'removing');
  assert.equal(await registry.getForMailDomain(mailDomainId), null);
  assert.equal((await registry.listMappings({ serverId })).length, 0);
  assert.equal((await registry.listInFlight({ serverId })).length, 1);

  const attached = await registry.attachApplyJob(mailDomainId, {
    operationId: removing.operationId,
    jobId: 'roundcube-job-2',
    previewSha256: 'c'.repeat(64),
    nginxSha256: 'd'.repeat(64),
  });
  const deleted = await registry.completeApply(mailDomainId, {
    operationId: removing.operationId,
    job: successfulJob(attached, 'roundcube-job-2'),
  });
  assert.equal(deleted.state, 'removed');
  assert.equal(deleted.operationId, removing.operationId);
  assert.equal(deleted.applyJobId, 'roundcube-job-2');
  assert.deepEqual(await registry.getRecordForMailDomain(mailDomainId), deleted);
  assert.equal(await registry.getForMailDomain(mailDomainId), null);
  assert.equal((await registry.listMappings({ serverId })).length, 0);
});

test('failed apply can be replaced only by the exact in-flight operation', async () => {
  const registry = fixture();
  const pending = await begin(registry);
  const first = await registry.attachApplyJob(mailDomainId, {
    operationId: pending.operationId,
    jobId: 'roundcube-job-1',
    previewSha256: 'a'.repeat(64),
    nginxSha256: 'b'.repeat(64),
  });
  const retry = await registry.replaceFailedApplyJob(mailDomainId, {
    operationId: pending.operationId,
    previousJobId: first.applyJobId,
    jobId: 'roundcube-job-2',
    previewSha256: 'c'.repeat(64),
    nginxSha256: 'd'.repeat(64),
  });
  assert.equal(retry.applyJobId, 'roundcube-job-2');

  await assert.rejects(
    registry.replaceFailedApplyJob(mailDomainId, {
      operationId: '99999999-9999-4999-8999-999999999999',
      previousJobId: 'roundcube-job-2',
      jobId: 'roundcube-job-3',
      previewSha256: 'e'.repeat(64),
      nginxSha256: 'f'.repeat(64),
    }),
    (error) => error.code === 'roundcube_mapping_operation_stale',
  );
});
