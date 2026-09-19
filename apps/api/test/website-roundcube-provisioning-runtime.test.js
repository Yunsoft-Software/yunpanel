import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

function jobRegistry() {
  return {
    async enqueue() { return {}; },
    async getJob() { return null; },
    async listJobs() { return []; },
  };
}

function certificateRegistry() {
  return {
    async createForDomain() { return {}; },
    async setState() { return {}; },
    async getCertificate() { return null; },
    async listCertificates() { return []; },
  };
}

function domainRegistry() {
  return {
    async getDomain() { return null; },
    async markStaged() { return {}; },
    async markApplied() { return {}; },
  };
}

test('Website provisioning runtime wires shared Roundcube and post-mapping DNS handlers', () => {
  const runtime = createWebsiteProvisioningRuntime();
  const jobs = jobRegistry();
  const domains = domainRegistry();
  const certificates = certificateRegistry();
  runtime.configureCertificateControlPlane({
    jobRegistry: jobs,
    certificateRegistry: certificates,
    domainRegistry: domains,
    acmeEmail: 'ops@example.com',
  });

  const mailDomains = { async getMailDomain() { return null; } };
  const mappingRegistry = {
    async getForMailDomain() { return null; },
    async getRecordForMailDomain() { return null; },
    async completeApply() { return null; },
  };
  const mappingService = {
    async previewBind() { return null; },
    async beginBind() { return null; },
    async inspect() { return null; },
    async continueOperation() { return null; },
  };
  const endpointResolver = { async resolve() { return null; } };

  assert.deepEqual(runtime.configureRoundcubeControlPlane({
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    roundcubeDomainMappingRegistry: mappingRegistry,
    roundcubeDomainMappingService: mappingService,
    roundcubeWebmailEndpointResolver: endpointResolver,
    jobRegistry: jobs,
  }), { configured: true });
  assert.equal(typeof runtime.handlers.roundcube_mapping.apply, 'function');
  assert.equal(typeof runtime.handlers.roundcube_mapping.inspect, 'function');

  const mailDkimRegistry = { async getKey() { return null; } };
  const dnsZoneReapplyRuntime = {
    async preview() { return null; },
    async start() { return null; },
    async listForDomain() { return []; },
    async get() { return null; },
    async rollbackPreview() { return null; },
    async rollback() { return null; },
  };
  runtime.configureMailDnsControlPlane({
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    mailDkimRegistry,
    dnsZoneReapplyRuntime,
  });
  assert.equal(runtime.handlers.webmail_dns_reapply, runtime.handlers.mail_dns_reapply);
});
