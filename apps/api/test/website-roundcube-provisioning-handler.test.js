import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteRoundcubeProvisioningHandler,
  WebsiteRoundcubeProvisioningError,
} from '../src/website-roundcube-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '829b10dd-78d9-4fd7-9942-d83dc28a9b75';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const certificateId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const mappingId = '5f24f68a-2d10-44d0-a53a-6c0debd05fd5';
const applyJobId = '69b7ea31-9522-4930-9e36-6cc0559c140d';

const intent = Object.freeze({
  adapter: 'shared-roundcube-mapping',
  serverId,
  websiteId,
  webDomainId,
  mailDomainId,
  domainName: 'example.com',
});

function operation() {
  return {
    operationId,
    websiteId,
    steps: [{
      id: 'webmail_certificate',
      kind: 'webmail_certificate',
      state: 'succeeded',
      evidence: {
        satisfied: true,
        adapter: 'acme-webmail-certificate',
        certificateId,
        provisioningOperationId: operationId,
        hostname: 'webmail.example.com',
      },
    }],
  };
}

function scope() {
  return {
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'enabled',
    },
    domain: {
      id: webDomainId,
      serverId,
      websiteId,
      primaryDomain: 'example.com',
    },
  };
}

function activeMapping() {
  return {
    id: mappingId,
    mailDomainId,
    webDomainId,
    serverId,
    domainName: 'example.com',
    hostname: 'webmail.example.com',
    certificateId,
    certificateFingerprint256: Array.from({ length: 32 }, () => 'AA').join(':'),
    revision: 1,
    state: 'active',
  };
}

function endpoint() {
  return {
    version: 1,
    mailDomainId,
    serverId,
    mappingId,
    mappingRevision: 1,
    hostname: 'webmail.example.com',
    protocol: 'https',
    path: '/',
    roundcubePreviewSha256: 'a'.repeat(64),
    roundcubeApplyJobId: applyJobId,
    ready: true,
  };
}

function dependencies(overrides = {}) {
  const scoped = scope();
  return {
    mailDomainRegistry: {
      getMailDomain: async () => scoped.mailDomain,
    },
    domainRegistry: {
      getDomain: async () => scoped.domain,
    },
    roundcubeDomainMappingRegistry: {
      getForMailDomain: async () => null,
      getRecordForMailDomain: async () => null,
      completeApply: async () => activeMapping(),
    },
    roundcubeDomainMappingService: {
      previewBind: async () => ({
        previewDigest: 'b'.repeat(64),
        confirmation: 'bind-roundcube-domain:test',
      }),
      beginBind: async (input) => ({
        mapping: {
          ...activeMapping(),
          state: 'pending',
          operationId: input.operationId,
          updatedAt: '2026-09-19T18:00:00.000Z',
        },
        actions: { continuation: 'continue-roundcube-domain:test' },
      }),
      inspect: async () => null,
      continueOperation: async () => null,
    },
    roundcubeWebmailEndpointResolver: {
      resolve: async () => endpoint(),
    },
    jobRegistry: {
      getJob: async () => null,
    },
    waitForTerminalJob: async (job) => job,
    ...overrides,
  };
}

test('Website Roundcube apply owns bind with the Website operation and completes only after exact shared apply readiness', async () => {
  let mapping = null;
  let job = null;
  const calls = [];
  const deps = dependencies({
    roundcubeDomainMappingRegistry: {
      getForMailDomain: async () => mapping?.state === 'active' ? mapping : null,
      getRecordForMailDomain: async () => mapping,
      completeApply: async () => {
        mapping = activeMapping();
        return mapping;
      },
    },
    roundcubeDomainMappingService: {
      previewBind: async (input) => {
        calls.push(['preview', input]);
        return { previewDigest: 'b'.repeat(64), confirmation: 'bind-roundcube-domain:test' };
      },
      beginBind: async (input) => {
        calls.push(['begin', input]);
        mapping = {
          ...activeMapping(),
          state: 'pending',
          operationId: input.operationId,
          updatedAt: '2026-09-19T18:00:00.000Z',
        };
        return {
          mapping,
          actions: { continuation: 'continue-roundcube-domain:test' },
        };
      },
      inspect: async () => ({
        mapping,
        job: job ? { id: job.id, status: job.status } : null,
        actions: { continuation: 'continue-roundcube-domain:test' },
      }),
      continueOperation: async (input, options) => {
        calls.push(['continue', input, options]);
        if (!job) {
          job = { id: applyJobId, status: 'queued' };
          return { mapping, job: { ...job }, actions: { continuation: null } };
        }
        if (job.status === 'succeeded') {
          mapping = activeMapping();
          return { mapping, job: { ...job }, actions: { continuation: null }, activated: true };
        }
        return { mapping, job: { ...job }, actions: { continuation: null } };
      },
    },
    jobRegistry: {
      getJob: async () => job ? { ...job } : null,
    },
    waitForTerminalJob: async (current) => {
      assert.equal(current.id, applyJobId);
      job = { ...current, status: 'succeeded' };
      return { ...job };
    },
  });
  const handler = createWebsiteRoundcubeProvisioningHandler(deps);

  const result = await handler.apply({
    operation: operation(),
    operationId,
    websiteId,
    stepId: 'roundcube',
    intent,
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'shared-roundcube-mapping');
  assert.equal(result.mappingId, mappingId);
  assert.equal(result.roundcubeApplyJobId, applyJobId);
  assert.equal(calls[1][1].operationId, operationId);
  assert.equal(calls.filter(([kind]) => kind === 'continue').length, 2);
  for (const [, , options] of calls.filter(([kind]) => kind === 'continue')) {
    assert.deepEqual(options.authorization, {
      kind: 'website_provisioning', version: 1, operationId, websiteId, stepId: 'roundcube',
    });
  }
});

test('Website Roundcube inspect reconciles successful pending apply metadata without enqueueing another apply', async () => {
  let completed = 0;
  let hostMutations = 0;
  const pending = {
    ...activeMapping(),
    state: 'pending',
    operationId,
    applyJobId,
    updatedAt: '2026-09-19T18:00:00.000Z',
  };
  const deps = dependencies({
    roundcubeDomainMappingRegistry: {
      getForMailDomain: async () => null,
      getRecordForMailDomain: async () => pending,
      completeApply: async (_mailDomainId, input) => {
        completed += 1;
        assert.equal(input.operationId, operationId);
        assert.equal(input.job.id, applyJobId);
        return activeMapping();
      },
    },
    roundcubeDomainMappingService: {
      previewBind: async () => { hostMutations += 1; return {}; },
      beginBind: async () => { hostMutations += 1; return {}; },
      inspect: async () => ({
        mapping: pending,
        job: { id: applyJobId, status: 'succeeded' },
        actions: { continuation: 'continue-roundcube-domain:test' },
      }),
      continueOperation: async () => { hostMutations += 1; return {}; },
    },
    jobRegistry: {
      getJob: async () => ({
        id: applyJobId,
        serverId,
        operation: 'roundcube.config.apply',
        resourceType: 'server',
        resourceId: serverId,
        status: 'succeeded',
        result: {},
      }),
    },
  });
  const handler = createWebsiteRoundcubeProvisioningHandler(deps);

  const result = await handler.inspect({
    operation: operation(),
    operationId,
    websiteId,
    intent,
  });

  assert.equal(result.satisfied, true);
  assert.equal(completed, 1);
  assert.equal(hostMutations, 0);
});

test('Website Roundcube apply exposes a precise blocker when the webmail certificate does not cover its hostname', async () => {
  const deps = dependencies({
    roundcubeDomainMappingService: {
      previewBind: async () => {
        const error = new Error('not covered');
        error.code = 'roundcube_mapping_certificate_hostname_mismatch';
        throw error;
      },
      beginBind: async () => assert.fail('bind must not begin'),
      inspect: async () => null,
      continueOperation: async () => assert.fail('apply must not enqueue'),
    },
  });
  const handler = createWebsiteRoundcubeProvisioningHandler(deps);

  await assert.rejects(
    handler.apply({ operation: operation(), operationId, websiteId, intent }),
    (error) => error instanceof WebsiteRoundcubeProvisioningError
      && error.code === 'website_roundcube_certificate_coverage_required',
  );
});

test('Website Roundcube inspect rejects a foreign in-flight mapping instead of adopting it', async () => {
  const deps = dependencies({
    roundcubeDomainMappingRegistry: {
      getForMailDomain: async () => null,
      getRecordForMailDomain: async () => ({
        ...activeMapping(),
        state: 'pending',
        operationId: '92c1dd91-8cb4-44e1-bd50-bec1084cc659',
        updatedAt: '2026-09-19T18:00:00.000Z',
      }),
      completeApply: async () => assert.fail('foreign mapping must not finalize'),
    },
  });
  const handler = createWebsiteRoundcubeProvisioningHandler(deps);

  await assert.rejects(
    handler.inspect({ operation: operation(), operationId, websiteId, intent }),
    (error) => error instanceof WebsiteRoundcubeProvisioningError
      && error.code === 'website_roundcube_mapping_conflict',
  );
});
