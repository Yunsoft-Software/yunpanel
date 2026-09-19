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

test('Website provisioning runtime wires local mail health only after mail, DKIM and Roundcube control planes', () => {
  const runtime = createWebsiteProvisioningRuntime();
  const jobs = jobRegistry();
  const domains = domainRegistry();
  const certificates = certificateRegistry();
  const mailDomains = { async getMailDomain() { return null; } };
  const mailConfigurationService = {
    async previewTransition() { return null; },
    async materializeCurrent() { return null; },
  };
  const mailDkimRegistry = { async getKey() { return null; } };
  const mailDkimConfigurationService = { async previewApply() { return null; } };
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
  const discoveryEndpointResolver = { async resolve() { return null; } };
  const mailReadinessInspector = { async inspect() { return null; } };
  const mailProtocolHealthInspector = { async inspect() { return null; } };

  assert.throws(
    () => runtime.configureMailHealthControlPlane({
      mailDomainRegistry: mailDomains,
      domainRegistry: domains,
      mailConfigurationService,
      mailReadinessInspector,
      mailProtocolHealthInspector,
      roundcubeWebmailEndpointResolver: endpointResolver,
      mailDiscoveryEndpointResolver: discoveryEndpointResolver,
    }),
    /requires mail, DKIM, and Roundcube control planes/,
  );

  runtime.configureCertificateControlPlane({
    jobRegistry: jobs,
    certificateRegistry: certificates,
    domainRegistry: domains,
    acmeEmail: 'ops@example.com',
  });
  runtime.configureWebmailCertificateControlPlane({
    jobRegistry: jobs,
    certificateRegistry: certificates,
    domainRegistry: domains,
    mailDomainRegistry: mailDomains,
    acmeEmail: 'ops@example.com',
  });
  runtime.configureMailControlPlane({
    jobRegistry: jobs,
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    mailConfigurationService,
  });
  runtime.configureMailDkimControlPlane({
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    mailDkimRegistry,
    jobRegistry: jobs,
    mailDkimConfigurationService,
  });
  runtime.configureRoundcubeControlPlane({
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    roundcubeDomainMappingRegistry: mappingRegistry,
    roundcubeDomainMappingService: mappingService,
    roundcubeWebmailEndpointResolver: endpointResolver,
    jobRegistry: jobs,
  });

  const dependencies = {
    mailDomainRegistry: mailDomains,
    domainRegistry: domains,
    mailConfigurationService,
    mailReadinessInspector,
    mailProtocolHealthInspector,
    roundcubeWebmailEndpointResolver: endpointResolver,
    mailDiscoveryEndpointResolver: discoveryEndpointResolver,
  };
  assert.deepEqual(runtime.configureMailHealthControlPlane(dependencies), { configured: true });
  assert.equal(typeof runtime.handlers.mail_health.apply, 'function');
  assert.equal(typeof runtime.handlers.mail_health.inspect, 'function');
  assert.deepEqual(runtime.configureMailHealthControlPlane(dependencies), { configured: true });
  assert.throws(
    () => runtime.configureMailHealthControlPlane({
      ...dependencies,
      mailProtocolHealthInspector: { async inspect() { return null; } },
    }),
    /cannot be replaced/,
  );
  assert.throws(
    () => runtime.configureMailHealthControlPlane({
      ...dependencies,
      mailDiscoveryEndpointResolver: { async resolve() { return null; } },
    }),
    /cannot be replaced/,
  );
});
