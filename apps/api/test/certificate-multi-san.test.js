import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: response.status === 204 ? null : await response.json() };
}

test('Owner issues certificate with Plesk Obsidian multi-SAN options and validates domain boundaries', async () => {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'multi-san-host' });
  const enrolled = await registry.enrollServer({ token: enrollment.token, hostname: 'multi-san-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await registry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 4302 },
    httpsMode: 'managed',
  });
  const checksum = 'a'.repeat(64);
  await domainRegistry.markStaged(domain.id, { checksum, configName: 'yunpanel-example.conf' });
  await domainRegistry.markApplied(domain.id, { checksum });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const app = withPanelContext(createApp({
    environment: 'production',
    registry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    localServerId: enrolled.server.id,
  }));

  await withServer(app, async (baseUrl) => {
    // 1. Reject foreign domain
    const foreign = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        domains: ['example.com', 'otherdomain.org'],
      },
    });
    assert.equal(foreign.response.status, 409);
    assert.equal(foreign.payload.error.code, 'certificate_domain_mismatch');

    // 2. Reject wildcard with HTTP-01
    const wildcardHttp = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        domains: ['example.com', '*.example.com'],
      },
    });
    assert.equal(wildcardHttp.response.status, 409);
    assert.equal(wildcardHttp.payload.error.code, 'wildcard_not_supported');

    // 3. Issue with valid multi-SAN list (apex, www, webmail, mail) and assignToMail
    const issued = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/issue`, {
      method: 'POST',
      body: {
        email: 'admin@example.com',
        staging: false,
        domains: ['www.example.com', 'webmail.example.com', 'mail.example.com'],
        assignToMail: true,
      },
    });
    assert.equal(issued.response.status, 202);
    const certificate = issued.payload.data.certificate;
    // primaryDomain should always be first
    assert.equal(certificate.certificateNames[0], 'example.com');
    assert.deepEqual(certificate.certificateNames, [
      'example.com',
      'www.example.com',
      'webmail.example.com',
      'mail.example.com',
    ]);

    // Enqueued job payload should contain the multi-SAN names and email
    const job = issued.payload.data.job;
    const storedJob = await jobRegistry.getJob(job.id);
    assert.equal(storedJob.payload.email, 'admin@example.com');
    assert.deepEqual(storedJob.payload.domains, [
      'example.com',
      'www.example.com',
      'webmail.example.com',
      'mail.example.com',
    ]);
  });
});
