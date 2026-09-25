import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteMailDkimConfigProvisioningHandler,
  WebsiteMailDkimConfigProvisioningError,
} from '../src/website-mail-dkim-config-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const selector = 'yp-9ae512c0a7174611943c6ce2';
const applyPreviewDigest = 'a'.repeat(64);
const applyConfigSha = 'b'.repeat(64);
const cleanupPreviewDigest = 'c'.repeat(64);
const cleanupConfigSha = 'd'.repeat(64);

function intent(overrides = {}) {
  return {
    adapter: 'managed-mail-dkim-config',
    serverId,
    websiteId,
    webDomainId,
    mailDomainId,
    domainName: 'example.com',
    expectedMailDomainRevision: 2,
    expectedMailDomainStatus: 'enabled',
    expectedKeyRevision: 1,
    selector,
    ...overrides,
  };
}

function mailConfigStep() {
  return {
    id: 'mail_config',
    kind: 'mail_config',
    required: true,
    state: 'succeeded',
    intent: {
      adapter: 'managed-mail-config',
      serverId,
      websiteId,
      webDomainId,
      mailDomainId,
      expectedRevision: 1,
      initialStatus: 'disabled',
      desiredStatus: 'enabled',
    },
    evidence: {
      satisfied: true,
      applyJobId: '11111111-1111-4111-8111-111111111111',
    },
    compensation: { state: 'pending', evidence: null },
  };
}

function context() {
  return {
    operationId,
    websiteId,
    stepId: 'mail_dkim_config',
    intent: intent(),
    evidence: null,
    compensation: { state: 'pending' },
    operation: {
      operationId,
      websiteId,
      steps: [mailConfigStep()],
    },
  };
}

function fixture({
  dnsReady = true,
  failFirstApply = false,
  initialApplyJob = false,
  initialCleanupJob = false,
  initiallyDisabled = false,
} = {}) {
  let mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: initiallyDisabled ? 'disabled' : 'enabled',
    revision: initiallyDisabled ? 3 : 2,
  };
  const jobs = [];
  const events = [];
  let sequence = 0;
  let applyAttempts = 0;

  function jobId() {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  }

  function completedJob(phase, status = 'succeeded') {
    const enabled = phase === 'apply';
    return {
      id: jobId(),
      serverId,
      type: `website_dkim_${phase}:${operationId}`,
      operation: OPERATIONS.MAIL_DKIM_APPLY,
      resourceType: 'mail_domain',
      resourceId: mailDomainId,
      status,
      result: status === 'succeeded' ? {
        version: 1,
        mailDomainId,
        expectedKeyRevision: 1,
        previewDigest: enabled ? applyPreviewDigest : cleanupPreviewDigest,
        configurationSha256: enabled ? applyConfigSha : cleanupConfigSha,
        applied: true,
        sideEffects: true,
      } : null,
      error: status === 'failed' ? { code: 'simulated_failure' } : null,
      createdAt: `2026-09-19T04:00:${String(sequence).padStart(2, '0')}.000Z`,
    };
  }

  if (initialApplyJob) jobs.push(completedJob('apply'));
  if (initialCleanupJob) jobs.push(completedJob('cleanup'));

  const jobRegistry = {
    async listJobs({ serverId: filterServerId } = {}) {
      return filterServerId ? jobs.filter((job) => job.serverId === filterServerId) : [...jobs];
    },
    async getJob(id) {
      return jobs.find((job) => job.id === id) ?? null;
    },
    async enqueue(input) {
      assert.equal(input.operation, OPERATIONS.MAIL_DKIM_APPLY);
      assert.equal(input.resourceType, 'mail_domain');
      assert.equal(input.resourceId, mailDomainId);
      assert.deepEqual(input.authorization, {
        kind: 'website_provisioning', version: 1, operationId, websiteId, stepId: 'mail_dkim_config',
      });
      const phase = input.type.startsWith('website_dkim_cleanup:') ? 'cleanup' : 'apply';
      if (phase === 'apply') applyAttempts += 1;
      const failed = phase === 'apply' && failFirstApply && applyAttempts === 1;
      const job = completedJob(phase, failed ? 'failed' : 'succeeded');
      assert.equal(job.type, input.type);
      assert.equal(job.result?.previewDigest ?? input.payload.previewDigest, input.payload.previewDigest);
      assert.equal(job.result?.configurationSha256 ?? input.payload.configurationSha256, input.payload.configurationSha256);
      jobs.push(job);
      events.push(`dkim-${phase}`);
      return job;
    },
  };

  const mailConfigProvisioningHandler = {
    async inspectCompensation() {
      if (mailDomain.status === 'disabled' && mailDomain.revision === 3) {
        return {
          satisfied: true,
          adapter: 'managed-mail-config',
          rollbackJobId: '22222222-2222-4222-8222-222222222222',
          targetStatus: 'disabled',
          resultingRevision: 3,
        };
      }
      return { satisfied: false, reason: 'website_mail_rollback_required' };
    },
    async compensate(siblingContext) {
      assert.equal(siblingContext.stepId, 'mail_config');
      assert.equal(siblingContext.intent.mailDomainId, mailDomainId);
      events.push('mail-config-compensate');
      mailDomain = { ...mailDomain, status: 'disabled', revision: 3 };
      return {
        satisfied: true,
        adapter: 'managed-mail-config',
        rollbackJobId: '22222222-2222-4222-8222-222222222222',
        targetStatus: 'disabled',
        resultingRevision: 3,
      };
    },
  };

  const handler = createWebsiteMailDkimConfigProvisioningHandler({
    jobRegistry,
    mailDomainRegistry: { async getMailDomain() { return { ...mailDomain }; } },
    domainRegistry: {
      async getDomain() {
        return { id: webDomainId, serverId, websiteId, primaryDomain: 'example.com' };
      },
    },
    mailDkimRegistry: {
      async getKey() {
        return {
          mailDomainId,
          domainName: 'example.com',
          selector,
          revision: 1,
        };
      },
    },
    mailDkimConfigurationService: {
      async previewApply(input) {
        assert.deepEqual(input, { mailDomainId, expectedKeyRevision: 1 });
        const cleanup = mailDomain.status === 'disabled';
        return {
          readyToApply: cleanup || dnsReady,
          blockers: cleanup || dnsReady ? [] : ['mail_dkim_dns_not_ready'],
          previewDigest: cleanup ? cleanupPreviewDigest : applyPreviewDigest,
          configuration: {
            sha256: cleanup ? cleanupConfigSha : applyConfigSha,
            domains: cleanup ? 0 : 1,
          },
        };
      },
    },
    mailConfigProvisioningHandler,
    waitForTerminalJob: async (job) => job,
  });

  return {
    handler,
    context: context(),
    jobs: () => jobs.map((job) => structuredClone(job)),
    events: () => [...events],
    mailDomain: () => ({ ...mailDomain }),
  };
}

test('Website DKIM signing apply uses one operation-owned durable child job', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.adapter, 'managed-mail-dkim-config');
  assert.equal(evidence.mailDomainId, mailDomainId);
  assert.equal(evidence.expectedKeyRevision, 1);
  assert.equal(evidence.previewDigest, applyPreviewDigest);
  assert.equal(evidence.configurationSha256, applyConfigSha);
  assert.deepEqual(f.events(), ['dkim-apply']);
  assert.equal(f.jobs().length, 1);
  assert.equal(f.jobs()[0].type, `website_dkim_apply:${operationId}`);
});

test('Website DKIM signing blocks without enqueue until public DNS diagnostics are ready', async () => {
  const f = fixture({ dnsReady: false });
  const result = await f.handler.apply(f.context);

  assert.deepEqual(result, {
    satisfied: false,
    reason: 'website_mail_dkim_dns_not_ready',
  });
  assert.deepEqual(f.events(), []);
  assert.deepEqual(f.jobs(), []);
});

test('Website DKIM signing inspect recovers an operation-owned succeeded child after lost acknowledgement', async () => {
  const f = fixture({ initialApplyJob: true });
  const evidence = await f.handler.inspect(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.previewDigest, applyPreviewDigest);
  assert.deepEqual(f.events(), []);
  assert.equal(f.jobs().length, 1);
});

test('Website DKIM signing retry creates a new attempt after a failed child job', async () => {
  const f = fixture({ failFirstApply: true });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteMailDkimConfigProvisioningError
      && error.code === 'website_mail_dkim_config_child_failed',
  );
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(f.jobs().length, 2);
  assert.deepEqual(f.jobs().map((job) => job.status), ['failed', 'succeeded']);
});

test('Website DKIM compensation disables the Mail Domain before pruning signing config', async () => {
  const f = fixture();
  const applied = await f.handler.apply(f.context);
  const compensation = await f.handler.compensate({ ...f.context, evidence: applied });

  assert.equal(compensation.satisfied, true);
  assert.equal(compensation.cleanedUp, true);
  assert.equal(compensation.configurationSha256, cleanupConfigSha);
  assert.equal(compensation.mailConfigRollbackJobId, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(f.events(), ['dkim-apply', 'mail-config-compensate', 'dkim-cleanup']);
  assert.deepEqual(f.mailDomain(), {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: 3,
  });
  assert.equal(
    (await f.handler.inspectCompensation({ ...f.context, evidence: applied })).satisfied,
    true,
  );
});

test('Website DKIM compensation recovers existing Mail Domain rollback and cleanup without replay', async () => {
  const f = fixture({ initiallyDisabled: true, initialCleanupJob: true });
  const inspected = await f.handler.inspectCompensation(f.context);

  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.cleanedUp, true);
  assert.deepEqual(f.events(), []);
});

test('Website DKIM signing refuses Mail Domain or key drift', async () => {
  const f = fixture({ initiallyDisabled: true });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteMailDkimConfigProvisioningError
      && error.code === 'website_mail_dkim_config_mail_state_drift',
  );
});
