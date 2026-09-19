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

test('Website provisioning runtime replaces the certificate placeholder with ACME and TLS handlers', () => {
  const runtime = createWebsiteProvisioningRuntime();
  const jobs = jobRegistry();
  const certificates = certificateRegistry();
  const domains = domainRegistry();

  assert.deepEqual(runtime.configureCertificateControlPlane({
    jobRegistry: jobs,
    certificateRegistry: certificates,
    domainRegistry: domains,
    acmeEmail: 'ops@example.com',
  }), { configured: true });

  assert.equal(typeof runtime.handlers.certificate.apply, 'function');
  assert.equal(typeof runtime.handlers.certificate.inspect, 'function');
  assert.equal(typeof runtime.handlers.tls_activation.apply, 'function');
  assert.equal(typeof runtime.handlers.tls_activation.inspect, 'function');

  assert.deepEqual(runtime.configureCertificateControlPlane({
    jobRegistry: jobs,
    certificateRegistry: certificates,
    domainRegistry: domains,
    acmeEmail: 'ops@example.com',
  }), { configured: true });
});

test('Website provisioning runtime keeps missing ACME email as a retryable handler concern', () => {
  const runtime = createWebsiteProvisioningRuntime();
  assert.doesNotThrow(() => runtime.configureCertificateControlPlane({
    jobRegistry: jobRegistry(),
    certificateRegistry: certificateRegistry(),
    domainRegistry: domainRegistry(),
    acmeEmail: null,
  }));
});
