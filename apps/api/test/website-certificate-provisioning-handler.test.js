import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteCertificateProvisioningHandler,
  WebsiteCertificateProvisioningError,
} from '../src/website-certificate-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const domainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const certificateId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const jobId = '28f795dd-5911-4de0-9835-32f94206d4a8';
const fingerprint256 = Array.from({ length: 32 }, () => 'AA').join(':');

const intent = Object.freeze({
  websiteId,
  primaryDomainId: domainId,
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
  wwwDomainId: null,
  wwwDomain: null,
});

function activeDomain(overrides = {}) {
  return {
    id: domainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    httpsMode: 'managed',
    certificateId: null,
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
    state: 'active',
    ...overrides,
  };
}

function issuedCertificate(overrides = {}) {
  return {
    id: certificateId,
    domainId,
    serverId,
    provisioningOperationId: operationId,
    source: 'acme',
    purpose: 'web',
    renewalMode: 'automatic',
    state: 'active',
    staging: false,
    domains: ['example.com', 'www.example.com'],
    certificateNames: ['example.com', 'www.example.com'],
    challenge: { type: 'http-01' },
    email: 'ops@example.com',
    fingerprint256,
    validTo: '2026-12-31T00:00:00.000Z',
    createdAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
  };
}

function successfulJob(overrides = {}) {
  return {
    id: jobId,
    serverId,
    type: `website.ssl.issue:${operationId}`,
    operation: 'ssl.issue',
    resourceType: 'certificate',
    resourceId: certificateId,
    status: 'succeeded',
    ...overrides,
  };
}

test('Website certificate apply reuses the durable SSL issue queue and returns secret-safe ownership evidence', async () => {
  let domain = activeDomain();
  let certificate = null;
  const calls = [];
  const jobs = [];

  const certificateRegistry = {
    listCertificates: async () => certificate ? [certificate] : [],
    createForDomain: async (input) => {
      calls.push(['create', input]);
      certificate = issuedCertificate({
        state: 'pending',
        fingerprint256: null,
        validTo: null,
        ...input,
        id: certificateId,
        source: 'acme',
        renewalMode: 'automatic',
        createdAt: '2026-09-19T12:00:00.000Z',
      });
      return certificate;
    },
    setState: async (id, state) => {
      calls.push(['state', id, state]);
      certificate = { ...certificate, state };
      return certificate;
    },
    getCertificate: async () => certificate,
  };
  const domainRegistry = {
    getDomain: async () => domain,
  };
  const jobRegistry = {
    listJobs: async ({ resourceId }) => jobs.filter((job) => job.resourceId === resourceId),
    getJob: async (id) => jobs.find((job) => job.id === id) ?? null,
    enqueue: async (input) => {
      calls.push(['enqueue', input]);
      const queued = successfulJob({ status: 'queued' });
      jobs.push(queued);
      return queued;
    },
  };
  const handler = createWebsiteCertificateProvisioningHandler({
    jobRegistry,
    certificateRegistry,
    domainRegistry,
    acmeEmail: 'OPS@EXAMPLE.COM',
    waitForTerminalJob: async (job) => {
      assert.equal(job.status, 'queued');
      const index = jobs.findIndex((candidate) => candidate.id === job.id);
      jobs[index] = successfulJob();
      certificate = issuedCertificate();
      domain = activeDomain({
        certificateId,
        desiredRevision: 2,
        stagedRevision: 0,
        appliedRevision: 1,
        state: 'draft',
      });
      return jobs[index];
    },
    waitForAttachment: async () => ({ certificate, domain }),
  });

  const result = await handler.apply({
    operationId,
    websiteId,
    intent,
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'acme-certificate');
  assert.equal(result.certificateId, certificateId);
  assert.equal(result.issueJobId, jobId);
  assert.equal(result.provisioningOperationId, operationId);
  assert.equal(result.fingerprint256, fingerprint256);
  assert.equal(result.attachedDomainRevision, 2);
  assert.equal(Object.hasOwn(result, 'certificatePath'), false);
  assert.equal(Object.hasOwn(result, 'privateKeyPath'), false);

  assert.deepEqual(calls[0], ['create', {
    domainId,
    serverId,
    domains: ['example.com', 'www.example.com'],
    certificateNames: ['example.com', 'www.example.com'],
    challenge: { type: 'http-01' },
    email: 'ops@example.com',
    staging: false,
    replaceExisting: true,
    provisioningOperationId: operationId,
    purpose: 'web',
  }]);
  assert.deepEqual(calls[1][0], 'enqueue');
  assert.equal(calls[1][1].operation, 'ssl.issue');
  assert.deepEqual(calls[1][1].payload, {
    domains: ['example.com', 'www.example.com'],
    email: 'ops@example.com',
    staging: false,
  });
  assert.equal(calls[1][1].idempotencyKey, `website.cert.issue:${operationId}:${certificateId}`);
  assert.deepEqual(calls[2], ['state', certificateId, 'issuing']);
});

test('Website certificate inspect reconciles an already attached operation-owned certificate without mutation', async () => {
  const certificate = issuedCertificate();
  const domain = activeDomain({
    certificateId,
    desiredRevision: 2,
    stagedRevision: 0,
    appliedRevision: 1,
    state: 'draft',
  });
  let mutations = 0;
  const handler = createWebsiteCertificateProvisioningHandler({
    acmeEmail: 'ops@example.com',
    domainRegistry: { getDomain: async () => domain },
    certificateRegistry: {
      listCertificates: async () => [certificate],
      getCertificate: async () => certificate,
      createForDomain: async () => { mutations += 1; return certificate; },
      setState: async () => { mutations += 1; return certificate; },
    },
    jobRegistry: {
      listJobs: async () => [successfulJob()],
      getJob: async () => successfulJob(),
      enqueue: async () => { mutations += 1; return successfulJob(); },
    },
  });

  const result = await handler.inspect({ operationId, websiteId, intent });
  assert.equal(result.satisfied, true);
  assert.equal(result.certificateId, certificateId);
  assert.equal(result.attachedDomainRevision, 2);
  assert.equal(mutations, 0);
});

test('Website certificate apply fails before mutation when the server ACME email is not configured', async () => {
  let mutations = 0;
  const handler = createWebsiteCertificateProvisioningHandler({
    domainRegistry: { getDomain: async () => activeDomain() },
    certificateRegistry: {
      listCertificates: async () => [],
      getCertificate: async () => null,
      createForDomain: async () => { mutations += 1; return null; },
      setState: async () => { mutations += 1; return null; },
    },
    jobRegistry: {
      listJobs: async () => [],
      getJob: async () => null,
      enqueue: async () => { mutations += 1; return null; },
    },
  });

  await assert.rejects(
    handler.apply({ operationId, websiteId, intent }),
    (error) => error instanceof WebsiteCertificateProvisioningError
      && error.code === 'website_certificate_acme_email_required',
  );
  assert.equal(mutations, 0);
});

test('Website certificate apply rejects a foreign certificate binding before issuing another certificate', async () => {
  let mutations = 0;
  const handler = createWebsiteCertificateProvisioningHandler({
    acmeEmail: 'ops@example.com',
    domainRegistry: {
      getDomain: async () => activeDomain({
        certificateId: '0a33932e-dffd-4b40-810c-ac4452e99b54',
        desiredRevision: 2,
        stagedRevision: 0,
        state: 'draft',
      }),
    },
    certificateRegistry: {
      listCertificates: async () => [],
      getCertificate: async () => null,
      createForDomain: async () => { mutations += 1; return null; },
      setState: async () => { mutations += 1; return null; },
    },
    jobRegistry: {
      listJobs: async () => [],
      getJob: async () => null,
      enqueue: async () => { mutations += 1; return null; },
    },
  });

  await assert.rejects(
    handler.apply({ operationId, websiteId, intent }),
    (error) => error instanceof WebsiteCertificateProvisioningError
      && error.code === 'website_certificate_binding_conflict',
  );
  assert.equal(mutations, 0);
});


test('Website certificate inspection ignores a live webmail-purpose certificate on the same Domain', async () => {
  let mutations = 0;
  const webmailCertificate = issuedCertificate({
    id: 'b1d94308-4b55-4b46-a7dc-8189edbc9e6e',
    provisioningOperationId: 'a79bba4e-5b79-44f6-b45e-fd845d3848a8',
    purpose: 'webmail',
    domains: ['webmail.example.com'],
    certificateNames: ['webmail.example.com'],
  });
  const handler = createWebsiteCertificateProvisioningHandler({
    acmeEmail: 'ops@example.com',
    domainRegistry: { getDomain: async () => activeDomain() },
    certificateRegistry: {
      listCertificates: async () => [webmailCertificate],
      getCertificate: async () => webmailCertificate,
      createForDomain: async () => { mutations += 1; return null; },
      setState: async () => { mutations += 1; return null; },
    },
    jobRegistry: {
      listJobs: async () => [],
      getJob: async () => null,
      enqueue: async () => { mutations += 1; return null; },
    },
  });

  const result = await handler.inspect({ operationId, websiteId, intent });
  assert.deepEqual(result, {
    satisfied: false,
    reason: 'website_certificate_issue_required',
  });
  assert.equal(mutations, 0);
});
