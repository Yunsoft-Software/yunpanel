import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createMailDomainRemovalPlanService,
  MailDomainRemovalPlanError,
} from '../src/mail-domain-removal-plan.js';

const serverId = randomUUID();
const webDomainId = randomUUID();
const mailDomainId = randomUUID();
const parentOperationId = randomUUID();
const mailboxId = randomUUID();
const aliasId = randomUUID();
const now = '2026-09-19T10:00:00.000Z';

function mailDomain(overrides = {}) {
  return {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 7,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture({
  currentMailDomain = mailDomain(),
  domain = { id: webDomainId, serverId, primaryDomain: 'example.com' },
  mailboxes = [{
    id: mailboxId,
    mailDomainId,
    address: 'owner@example.com',
    enabled: true,
    revision: 3,
    passwordConfigured: true,
    passwordUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  }],
  aliases = [{
    id: aliasId,
    mailDomainId,
    source: 'info@example.com',
    destinations: ['owner@example.com', 'outside@example.net'],
    enabled: true,
    revision: 2,
    createdAt: now,
    updatedAt: now,
  }],
  quotas = [{ mailboxId, quotaBytes: 1024, revision: 2, createdAt: now, updatedAt: now }],
  forwardings = [{
    mailboxId,
    mode: 'forward_only',
    destinations: ['outside@example.net'],
    enabled: true,
    revision: 4,
    createdAt: now,
    updatedAt: now,
  }],
  dkim = {
    mailDomainId,
    domainName: 'example.com',
    selector: 'mail-2026',
    algorithm: 'rsa-sha256',
    publicKey: 'secret-adjacent-public-material',
    dnsRecord: { name: 'mail-2026._domainkey.example.com' },
    revision: 5,
    createdAt: now,
    updatedAt: now,
  },
  jobs = [],
  data = {
    version: 1,
    scope: 'domain',
    identity: 'example.com',
    dataPath: '/var/lib/yunpanel/mail/example.com',
    present: true,
    bytes: 4096,
    mode: 448,
    uid: 100,
    gid: 101,
    snapshotSha256: 'a'.repeat(64),
    sideEffects: false,
  },
  configurationPreview = {
    version: 1,
    operation: 'mail_configuration_apply',
    mailDomainId,
    expectedRevision: 7,
    currentStatus: 'enabled',
    desiredStatus: 'disabled',
    blockers: [],
    previewDigest: 'b'.repeat(64),
    readyToApply: true,
    configuration: { sha256: 'c'.repeat(64) },
    sideEffects: false,
  },
  roundcubeMapping = null,
} = {}) {
  const calls = { dkim: 0, data: 0, configuration: 0 };
  const service = createMailDomainRemovalPlanService({
    localServerId: serverId,
    mailDomainRegistry: { async getMailDomain(id) { return id === mailDomainId ? currentMailDomain : null; } },
    domainRegistry: { async getDomain(id) { return id === webDomainId ? domain : null; } },
    mailboxRegistry: { async listMailboxes() { return mailboxes; } },
    mailAliasRegistry: { async listAliases() { return aliases; } },
    mailboxQuotaRegistry: { async listQuotas() { return quotas; } },
    mailboxForwardingRegistry: { async listForwardings() { return forwardings; } },
    mailDkimRegistry: {
      async getKey() { calls.dkim += 1; return dkim; },
    },
    mailConfigurationService: {
      async previewTransition(input) {
        calls.configuration += 1;
        assert.deepEqual(input, { mailDomainId, expectedRevision: 7, status: 'disabled' });
        return configurationPreview;
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        assert.deepEqual(filter, { resourceType: 'mail_domain', resourceId: mailDomainId });
        return jobs;
      },
    },
    mailDataInspector: {
      async inspectDomain(domainName) {
        calls.data += 1;
        assert.equal(domainName, 'example.com');
        return data;
      },
    },
    roundcubeDomainMappingRegistry: roundcubeMapping ? {
      async getRecordForMailDomain(id) {
        return id === mailDomainId ? roundcubeMapping : null;
      },
    } : null,
  });
  return { service, calls };
}

test('local preview pins exact secret-free cleanup inventory and destructive confirmation', async () => {
  const { service } = fixture();
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, true);
  assert.equal(preview.removalMethod, 'local_verified_data_finalize');
  assert.equal(preview.mailDomain.revision, 7);
  assert.deepEqual(preview.cleanupPlan.mailboxes, [{
    id: mailboxId,
    address: 'owner@example.com',
    enabled: true,
    revision: 3,
    updatedAt: now,
  }]);
  assert.deepEqual(preview.cleanupPlan.aliases, [{
    id: aliasId,
    source: 'info@example.com',
    enabled: true,
    revision: 2,
    updatedAt: now,
  }]);
  assert.deepEqual(preview.cleanupPlan.quotas, [{ mailboxId, revision: 2, updatedAt: now }]);
  assert.deepEqual(preview.cleanupPlan.forwardings, [{ mailboxId, revision: 4, updatedAt: now }]);
  assert.deepEqual(preview.cleanupPlan.dkim, {
    mailDomainId,
    domainName: 'example.com',
    selector: 'mail-2026',
    revision: 5,
    updatedAt: now,
  });
  assert.deepEqual(preview.cleanupPlan.mailData, {
    present: true,
    bytes: 4096,
    snapshotSha256: 'a'.repeat(64),
  });
  assert.deepEqual(preview.cleanupPlan.disableConfiguration, {
    previewDigest: 'b'.repeat(64),
    configurationSha256: 'c'.repeat(64),
  });
  assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    preview.confirmation,
    `remove-mail-domain:${mailDomainId}:${parentOperationId}:${preview.previewDigest}`,
  );
  assert.equal(preview.sideEffects, false);
  assert.doesNotMatch(
    JSON.stringify(preview),
    /password|public-material|outside@example\.net|dataPath|\/var\/lib|\"uid\"|\"gid\"/,
  );
});

test('active Mail Domain jobs block start and are represented only by bounded count', async () => {
  const jobs = [
    { id: randomUUID(), status: 'queued', payload: { secret: 'hidden' } },
    { id: randomUUID(), status: 'running' },
    { id: randomUUID(), status: 'succeeded' },
  ];
  const { service } = fixture({ jobs });
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, false);
  assert.equal(preview.confirmation, null);
  assert.deepEqual(preview.blockers, [{ code: 'mail_domain_removal_job_active', count: 2 }]);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(jobs[0].id));
  assert.doesNotMatch(JSON.stringify(preview), /hidden/);
});

test('external preview never inspects local DKIM or filesystem data', async () => {
  const currentMailDomain = mailDomain({
    managementMode: 'external',
    status: 'ready',
  });
  const { service, calls } = fixture({
    currentMailDomain,
    mailboxes: [],
    aliases: [],
    quotas: [],
    forwardings: [],
  });
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, true);
  assert.equal(preview.removalMethod, 'external_metadata_unlink');
  assert.equal(preview.cleanupPlan.dkim, null);
  assert.equal(preview.cleanupPlan.mailData, null);
  assert.deepEqual(calls, { dkim: 0, data: 0, configuration: 0 });
});

test('external preview blocks corrupt local dependency ownership', async () => {
  const currentMailDomain = mailDomain({ managementMode: 'external', status: 'degraded' });
  const { service } = fixture({
    currentMailDomain,
    aliases: [],
    quotas: [],
    forwardings: [],
  });
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, false);
  assert.deepEqual(preview.blockers, [{ code: 'external_mail_domain_local_dependencies', count: 1 }]);
});

test('dependency revision changes alter plan and preview digests', async () => {
  const first = await fixture().service.preview({ mailDomainId, parentOperationId });
  const second = await fixture({
    mailboxes: [{
      id: mailboxId,
      mailDomainId,
      address: 'owner@example.com',
      enabled: false,
      revision: 4,
      updatedAt: '2026-09-19T10:01:00.000Z',
    }],
  }).service.preview({ mailDomainId, parentOperationId });

  assert.notEqual(first.planDigest, second.planDigest);
  assert.notEqual(first.previewDigest, second.previewDigest);
  assert.notEqual(first.confirmation, second.confirmation);
});

test('unready disable configuration blocks enabled local removal confirmation', async () => {
  const { service } = fixture({
    configurationPreview: {
      version: 1,
      operation: 'mail_configuration_apply',
      mailDomainId,
      expectedRevision: 7,
      currentStatus: 'enabled',
      desiredStatus: 'disabled',
      blockers: ['mail_service_identity_required'],
      previewDigest: 'b'.repeat(64),
      readyToApply: false,
      configuration: null,
      sideEffects: false,
    },
  });
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, false);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.cleanupPlan.disableConfiguration, null);
  assert.deepEqual(preview.blockers, [{
    code: 'mail_domain_disable_configuration_not_ready',
    count: 1,
  }]);
});

test('remote binding and malformed dependency evidence fail closed', async () => {
  const remote = fixture({ domain: { id: webDomainId, serverId: randomUUID(), primaryDomain: 'example.com' } });
  await assert.rejects(
    remote.service.preview({ mailDomainId, parentOperationId }),
    (error) => error instanceof MailDomainRemovalPlanError
      && error.code === 'mail_domain_not_found' && error.status === 404,
  );

  const malformed = fixture({
    mailboxes: [{
      id: mailboxId,
      mailDomainId,
      address: 'owner@foreign.example',
      enabled: true,
      revision: 1,
      updatedAt: now,
    }],
  });
  await assert.rejects(
    malformed.service.preview({ mailDomainId, parentOperationId }),
    (error) => error instanceof MailDomainRemovalPlanError
      && error.code === 'mail_domain_removal_plan_invalid' && error.status === 409,
  );
});

test('removal plan preview is blocked when Roundcube webmail mapping is active or in flight', async () => {
  for (const state of ['active', 'pending', 'removing']) {
    const { service } = fixture({
      roundcubeMapping: { id: randomUUID(), mailDomainId, state },
    });
    const preview = await service.preview({ mailDomainId, parentOperationId });

    assert.equal(preview.readyToStart, false);
    assert.equal(preview.confirmation, null);
    assert.equal(
      preview.blockers.some((b) => b.code === 'mail_domain_webmail_mapping_active'),
      true,
    );
  }
});

test('removal plan preview succeeds when Roundcube webmail mapping is removed', async () => {
  const { service } = fixture({
    roundcubeMapping: { id: randomUUID(), mailDomainId, state: 'removed' },
  });
  const preview = await service.preview({ mailDomainId, parentOperationId });

  assert.equal(preview.readyToStart, true);
  assert.equal(
    preview.blockers.some((b) => b.code === 'mail_domain_webmail_mapping_active'),
    false,
  );
});
