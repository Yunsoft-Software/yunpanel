import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteWebmailCertificateProvisioningHandler,
  WebsiteWebmailCertificateProvisioningError,
} from '../src/website-webmail-certificate-provisioning-handler.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const webDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const mailDomainId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const webCertificateId = '77cb88e1-63e3-4e17-9427-e43252d513bc';
const webmailCertificateId = 'f2fc02fc-d35e-479c-b999-107f519c7e49';
const jobId = '1fbec675-cbea-4054-ac28-e4ca9ef85249';
const dnsOperationId = '66baa447-c92c-433e-8b50-a5af35653b27';
const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');

function intent() {
  return {
    adapter: 'acme-webmail-certificate',
    serverId,
    websiteId,
    webDomainId,
    mailDomainId,
    domainName: 'example.com',
    hostname: 'webmail.example.com',
    expectedMailDomainRevision: 2,
  };
}

function domain() {
  return {
    id: webDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    httpsMode: 'managed',
    state: 'active',
    desiredRevision: 4,
    stagedRevision: 4,
    appliedRevision: 4,
    certificateId: webCertificateId,
  };
}

function webCertificate() {
  return {
    id: webCertificateId,
    domainId: webDomainId,
    serverId,
    purpose: 'web',
    source: 'acme',
    state: 'active',
    staging: false,
  };
}

function webmailCertificate(state = 'active') {
  return {
    id: webmailCertificateId,
    domainId: webDomainId,
    serverId,
    source: 'acme',
    purpose: 'webmail',
    renewalMode: 'automatic',
    state,
    staging: false,
    certName: 'webmail.example.com',
    domains: ['webmail.example.com'],
    certificateNames: ['webmail.example.com'],
    email: 'ops@example.com',
    provisioningOperationId: operationId,
    fingerprint256: state === 'active' ? fingerprint : null,
    validTo: state === 'active' ? '2026-12-19T00:00:00.000Z' : null,
    createdAt: '2026-09-19T12:00:00.000Z',
  };
}

function successfulJob() {
  return {
    id: jobId,
    serverId,
    operation: OPERATIONS.SSL_ISSUE,
    resourceType: 'certificate',
    resourceId: webmailCertificateId,
    status: 'succeeded',
  };
}

function context({ dnsSucceeded = true } = {}) {
  return {
    operationId,
    websiteId,
    stepId: 'webmail_certificate',
    intent: intent(),
    evidence: null,
    operation: {
      operationId,
      websiteId,
      steps: [
        {
          id: 'nginx',
          kind: 'nginx',
          state: 'succeeded',
          intent: { acmeOnlyHostnames: ['webmail.example.com'] },
          evidence: { satisfied: true, checksum: 'a'.repeat(64) },
        },
        {
          id: 'mail_dns_reapply',
          kind: 'mail_dns_reapply',
          state: dnsSucceeded ? 'succeeded' : 'pending',
          intent: { webDomainId, mailDomainId, webmailHostname: 'webmail.example.com' },
          evidence: dnsSucceeded ? {
            satisfied: true,
            adapter: 'powerdns-mail-reapply',
            webDomainId,
            mailDomainId,
            webmailHostname: 'webmail.example.com',
            dnsReapplyOperationId: dnsOperationId,
          } : null,
        },
      ],
    },
  };
}

function fixture({ existing = false } = {}) {
  let mutations = 0;
  let createdInput = null;
  let enqueueInput = null;
  let certificate = existing ? webmailCertificate() : null;
  let jobs = existing ? [successfulJob()] : [];
  const handler = createWebsiteWebmailCertificateProvisioningHandler({
    acmeEmail: 'OPS@example.com',
    domainRegistry: {
      getDomain: async (id) => {
        assert.equal(id, webDomainId);
        return domain();
      },
    },
    mailDomainRegistry: {
      getMailDomain: async (id) => {
        assert.equal(id, mailDomainId);
        return {
          id: mailDomainId,
          webDomainId,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
          revision: 2,
        };
      },
    },
    certificateRegistry: {
      getCertificate: async (id) => id === webCertificateId ? webCertificate() : certificate,
      listCertificates: async () => [webCertificate(), ...(certificate ? [certificate] : [])],
      createForDomain: async (input) => {
        mutations += 1;
        createdInput = input;
        certificate = webmailCertificate('pending');
        return certificate;
      },
      setState: async (id, state) => {
        mutations += 1;
        assert.equal(id, webmailCertificateId);
        assert.equal(state, 'issuing');
        certificate = webmailCertificate('issuing');
        return certificate;
      },
    },
    jobRegistry: {
      listJobs: async ({ resourceId }) => {
        assert.equal(resourceId, webmailCertificateId);
        return jobs;
      },
      getJob: async (id) => jobs.find((job) => job.id === id) ?? null,
      enqueue: async (input) => {
        mutations += 1;
        enqueueInput = input;
        const queued = { ...successfulJob(), status: 'queued' };
        jobs = [queued];
        return queued;
      },
    },
    waitForTerminalJob: async () => {
      const terminal = successfulJob();
      jobs = [terminal];
      return terminal;
    },
    waitForActive: async (id) => {
      assert.equal(id, webmailCertificateId);
      certificate = webmailCertificate('active');
      return certificate;
    },
  });
  return {
    handler,
    mutations: () => mutations,
    createdInput: () => createdInput,
    enqueueInput: () => enqueueInput,
  };
}

test('fresh Website issues an operation-owned purpose:webmail certificate after DNS and HTTP-01 evidence', async () => {
  const f = fixture();
  const evidence = await f.handler.apply(context());

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.adapter, 'acme-webmail-certificate');
  assert.equal(evidence.certificateId, webmailCertificateId);
  assert.equal(evidence.hostname, 'webmail.example.com');
  assert.equal(evidence.dnsReapplyOperationId, dnsOperationId);
  assert.equal(f.createdInput().purpose, 'webmail');
  assert.equal(f.createdInput().replaceExisting, false);
  assert.deepEqual(f.createdInput().domains, ['webmail.example.com']);
  assert.deepEqual(f.createdInput().challenge, { type: 'http-01' });
  assert.equal(f.createdInput().provisioningOperationId, operationId);
  assert.deepEqual(f.enqueueInput().payload.domains, ['webmail.example.com']);
  assert.equal(f.enqueueInput().resourceId, webmailCertificateId);
  assert.deepEqual(f.enqueueInput().authorization, {
    kind: 'website_provisioning', version: 1, operationId, websiteId, stepId: 'webmail_certificate',
  });
  assert.equal(f.mutations(), 3);
});

test('webmail certificate inspection recovers exact active child evidence without replaying mutation', async () => {
  const f = fixture({ existing: true });
  const evidence = await f.handler.inspect(context());

  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.issueJobId, jobId);
  assert.equal(evidence.certificateId, webmailCertificateId);
  assert.equal(f.mutations(), 0);
});

test('webmail certificate refuses issuance until operation-owned webmail DNS evidence exists', async () => {
  const f = fixture();
  await assert.rejects(
    f.handler.apply(context({ dnsSucceeded: false })),
    (error) => error instanceof WebsiteWebmailCertificateProvisioningError
      && error.code === 'website_webmail_certificate_dns_routing_missing',
  );
  assert.equal(f.mutations(), 0);
});
