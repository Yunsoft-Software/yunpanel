import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteMailProvisioningHandler,
  WebsiteMailProvisioningError,
} from '../src/website-mail-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function intent(overrides = {}) {
  return {
    adapter: 'managed-mail-config',
    serverId,
    websiteId,
    webDomainId,
    mailDomainId,
    expectedRevision: 1,
    initialStatus: 'disabled',
    desiredStatus: 'enabled',
    ...overrides,
  };
}

function fixture({ failFirstApply = false } = {}) {
  let mailDomain = {
    id: mailDomainId,
    resourceType: 'mail_domain',
    domainName: 'example.com',
    webDomainId,
    managementMode: 'local',
    status: 'disabled',
    revision: 1,
  };
  const webDomain = {
    id: webDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
  };
  const jobs = [];
  let counter = 0;
  let applyAttempts = 0;

  const jobRegistry = {
    async listJobs({ serverId: filterServerId } = {}) {
      return filterServerId ? jobs.filter((job) => job.serverId === filterServerId) : [...jobs];
    },
    async getJob(jobId) {
      return jobs.find((job) => job.id === jobId) ?? null;
    },
    async enqueue(input) {
      const jobId = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
      const createdAt = `2026-09-19T03:00:${String(counter).padStart(2, '0')}.000Z`;
      if (input.operation === OPERATIONS.MAIL_CONFIG_APPLY) {
        applyAttempts += 1;
        const failed = failFirstApply && applyAttempts === 1;
        const job = {
          id: jobId,
          serverId: input.serverId,
          type: input.type,
          operation: input.operation,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          status: failed ? 'failed' : 'succeeded',
          result: failed ? null : {
            version: 3,
            mailDomainId,
            previousRevision: 1,
            previousStatus: 'disabled',
            desiredStatus: 'enabled',
            previewDigest: input.payload.previewDigest,
            configurationSha256: input.payload.configurationSha256,
            planSha256: sha(`plan-${applyAttempts}`),
            backupSha256: sha(`backup-${applyAttempts}`),
            readinessSha256: sha(`ready-${applyAttempts}`),
            applied: true,
            sideEffects: true,
          },
          error: failed ? { code: 'simulated_mail_apply_failure' } : null,
          createdAt,
        };
        jobs.push(job);
        if (!failed) mailDomain = { ...mailDomain, status: 'enabled', revision: 2 };
        return job;
      }
      if (input.operation === OPERATIONS.MAIL_CONFIG_ROLLBACK) {
        const job = {
          id: jobId,
          serverId: input.serverId,
          type: input.type,
          operation: input.operation,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          status: 'succeeded',
          result: {
            version: 1,
            mailDomainId,
            sourceApplyJobId: input.payload.sourceApplyJobId,
            previousRevision: input.payload.previousRevision,
            expectedCurrentRevision: input.payload.expectedCurrentRevision,
            currentStatus: input.payload.currentStatus,
            targetStatus: input.payload.targetStatus,
            previewDigest: input.payload.previewDigest,
            currentConfigurationSha256: input.payload.currentConfigurationSha256,
            sourcePlanSha256: input.payload.sourcePlanSha256,
            backupSha256: input.payload.backupSha256,
            compensationBackupSha256: sha('compensation-backup'),
            restored: true,
            sideEffects: true,
          },
          error: null,
          createdAt,
        };
        jobs.push(job);
        mailDomain = { ...mailDomain, status: 'disabled', revision: 3 };
        return job;
      }
      throw new Error('unexpected operation');
    },
  };

  const mailConfigurationService = {
    async previewTransition(input) {
      assert.deepEqual(input, {
        mailDomainId,
        expectedRevision: 1,
        status: 'enabled',
      });
      return {
        readyToApply: true,
        previewDigest: sha(`preview-${applyAttempts + 1}`),
        configuration: { sha256: sha(`configuration-${applyAttempts + 1}`) },
      };
    },
  };

  const handler = createWebsiteMailProvisioningHandler({
    jobRegistry,
    mailDomainRegistry: { getMailDomain: async () => ({ ...mailDomain }) },
    domainRegistry: { getDomain: async () => ({ ...webDomain }) },
    mailConfigurationService,
    waitForTerminalJob: async (job) => job,
    waitForMailDomain: async () => ({ ...mailDomain }),
  });

  return {
    handler,
    context: {
      operationId,
      websiteId,
      intent: intent(),
      evidence: null,
    },
    state: () => ({ mailDomain: { ...mailDomain }, jobs: jobs.map((job) => ({ ...job })) }),
  };
}

test('Website mail handler enables the operation-owned Mail Domain through a durable child job', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.adapter, 'managed-mail-config');
  assert.equal(evidence.mailDomainId, mailDomainId);
  assert.equal(evidence.previousRevision, 1);
  assert.equal(evidence.resultingRevision, 2);
  assert.equal(evidence.previousStatus, 'disabled');
  assert.equal(evidence.desiredStatus, 'enabled');
  assert.match(evidence.readinessSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.state().mailDomain, {
    id: mailDomainId,
    resourceType: 'mail_domain',
    domainName: 'example.com',
    webDomainId,
    managementMode: 'local',
    status: 'enabled',
    revision: 2,
  });
  assert.deepEqual(f.state().jobs.map((job) => job.operation), [OPERATIONS.MAIL_CONFIG_APPLY]);
  assert.equal((await f.handler.inspect({ ...f.context, evidence: null })).satisfied, true);
});

test('Website mail compensation uses managed rollback and returns the Mail Domain to disabled', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(f.context);
  const compensated = await f.handler.compensate({ ...f.context, evidence });

  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.noop, false);
  assert.equal(compensated.sourceApplyJobId, evidence.applyJobId);
  assert.equal(compensated.targetStatus, 'disabled');
  assert.equal(compensated.resultingRevision, 3);
  assert.equal(f.state().mailDomain.status, 'disabled');
  assert.equal(f.state().mailDomain.revision, 3);
  assert.deepEqual(f.state().jobs.map((job) => job.operation), [
    OPERATIONS.MAIL_CONFIG_APPLY,
    OPERATIONS.MAIL_CONFIG_ROLLBACK,
  ]);
  assert.equal((await f.handler.inspectCompensation({ ...f.context, evidence })).satisfied, true);
});

test('Website mail retry creates a new operation-owned attempt after a failed child job', async () => {
  const f = fixture({ failFirstApply: true });
  await assert.rejects(
    f.handler.apply(f.context),
    (error) => error instanceof WebsiteMailProvisioningError
      && error.code === 'website_mail_apply_child_failed',
  );

  const evidence = await f.handler.apply(f.context);
  assert.equal(evidence.satisfied, true);
  assert.equal(f.state().jobs.length, 2);
  assert.deepEqual(f.state().jobs.map((job) => job.status), ['failed', 'succeeded']);
  assert.equal(new Set(f.state().jobs.map((job) => job.type)).size, 1);
});

test('Website mail handler refuses to adopt an enabled Mail Domain without operation-owned evidence', async () => {
  const f = fixture();
  await f.handler.apply(f.context);
  const state = f.state();
  state.jobs.length = 0;

  const orphanHandler = createWebsiteMailProvisioningHandler({
    jobRegistry: {
      enqueue: async () => { throw new Error('must not enqueue'); },
      getJob: async () => null,
      listJobs: async () => [],
    },
    mailDomainRegistry: { getMailDomain: async () => state.mailDomain },
    domainRegistry: {
      getDomain: async () => ({ id: webDomainId, serverId, websiteId, primaryDomain: 'example.com' }),
    },
    mailConfigurationService: { previewTransition: async () => { throw new Error('must not preview'); } },
    waitForTerminalJob: async (job) => job,
    waitForMailDomain: async () => state.mailDomain,
  });

  await assert.rejects(
    orphanHandler.inspect(f.context),
    (error) => error instanceof WebsiteMailProvisioningError
      && error.code === 'website_mail_ownership_evidence_missing',
  );
});

test('Website mail intent fails closed on Website or Web Domain ownership drift', async () => {
  const f = fixture();
  await assert.rejects(
    f.handler.apply({ ...f.context, intent: intent({ websiteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) }),
    (error) => error instanceof WebsiteMailProvisioningError
      && error.code === 'website_mail_intent_invalid',
  );
  await assert.rejects(
    f.handler.apply({ ...f.context, intent: intent({ webDomainId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) }),
    (error) => error instanceof WebsiteMailProvisioningError
      && error.code === 'website_mail_web_domain_conflict',
  );
});
