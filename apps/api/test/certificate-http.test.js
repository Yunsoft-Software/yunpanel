import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createCertificateMaterialManager } from '../src/certificate-material-manager.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { withPanelContext } from './helpers/panel-auth-fixture.js';

const execFileAsync = promisify(execFile);

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function generateCertificate(directory, name) {
  const certificatePath = path.join(directory, `${name}.crt`);
  const privateKeyPath = path.join(directory, `${name}.key`);
  await execFileAsync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=secure.example.com',
    '-addext', 'subjectAltName=DNS:secure.example.com,DNS:www.secure.example.com',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  return {
    certificatePem: await readFile(certificatePath, 'utf8'),
    chainPem: '',
    privateKeyPem: await readFile(privateKeyPath, 'utf8'),
  };
}

test('Owner imports and reselects matched custom certificates without exposing PEM material', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const customRoot = path.join(directory, 'custom-certificates');
  const serverRegistry = createServerRegistry();
  const enrollment = await serverRegistry.issueEnrollmentToken({ label: 'custom-certificate-host' });
  const enrolled = await serverRegistry.enrollServer({ token: enrollment.token, hostname: 'custom-certificate-host' });
  const domainRegistry = createDomainRegistry({
    serverExists: async (serverId) => Boolean(await serverRegistry.getServer(serverId)),
  });
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'secure.example.com',
    aliases: ['www.secure.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    httpsMode: 'managed',
  });
  const certificateRegistry = createCertificateRegistry({ customRoot });
  const certificateMaterialManager = createCertificateMaterialManager({ customRoot, getUid: () => 0 });
  const app = withPanelContext(createApp({
    environment: 'production',
    registry: serverRegistry,
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager,
    jobRegistry: createJobRegistry(),
    localServerId: enrolled.server.id,
  }));
  const firstMaterial = await generateCertificate(directory, 'first');
  const secondMaterial = await generateCertificate(directory, 'second');

  await withServer(app, async (baseUrl) => {
    async function importCertificate(material) {
      const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
        method: 'POST', body: material,
      });
      assert.equal(preview.response.status, 200);
      assert.match(preview.payload.data.previewDigest, /^[a-f0-9]{64}$/);
      assert.equal(preview.payload.data.certificate.source, 'custom');
      const applied = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, {
        method: 'POST',
        body: {
          ...material,
          previewDigest: preview.payload.data.previewDigest,
          confirmation: preview.payload.data.confirmation,
        },
      });
      assert.equal(applied.response.status, 201);
      assert.doesNotMatch(JSON.stringify(applied.payload), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|privateKeyPath|materialDigest/);
      return applied.payload.data.certificate;
    }

    const concurrentPreview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
      method: 'POST', body: firstMaterial,
    });
    assert.equal(concurrentPreview.response.status, 200);
    const concurrentBody = {
      ...firstMaterial,
      previewDigest: concurrentPreview.payload.data.previewDigest,
      confirmation: concurrentPreview.payload.data.confirmation,
    };
    const concurrent = await Promise.all([
      requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, { method: 'POST', body: concurrentBody }),
      requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom`, { method: 'POST', body: concurrentBody }),
    ]);
    assert.deepEqual(concurrent.map((entry) => entry.response.status).sort(), [201, 409]);
    const first = concurrent.find((entry) => entry.response.status === 201).payload.data.certificate;
    assert.equal((await certificateRegistry.listCertificates()).length, 1);
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, first.id);
    const second = await importCertificate(secondMaterial);
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'superseded');
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, second.id);

    const preview = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${first.id}/select-preview`, {
      method: 'POST', body: {},
    });
    assert.equal(preview.response.status, 200);
    const selected = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/${first.id}/select`, {
      method: 'POST',
      body: { previewDigest: preview.payload.data.previewDigest, confirmation: preview.payload.data.confirmation },
    });
    assert.equal(selected.response.status, 200);
    assert.equal((await domainRegistry.getDomain(domain.id)).certificateId, first.id);
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'active');
    assert.equal((await certificateRegistry.getCertificate(second.id)).state, 'superseded');
    assert.doesNotMatch(JSON.stringify(selected.payload), /privateKeyPath|materialDigest|BEGIN/);

    const selectedRecord = await certificateRegistry.getCertificate(first.id);
    await writeFile(selectedRecord.privateKeyPath, secondMaterial.privateKeyPem, 'utf8');
    const tamperedStage = await requestJson(`${baseUrl}/api/domains/${domain.id}/stage`, { method: 'POST' });
    assert.equal(tamperedStage.response.status, 409);
    assert.equal(tamperedStage.payload.error.code, 'certificate_private_key_mismatch');
    assert.equal((await certificateRegistry.getCertificate(first.id)).state, 'active');
  });
});

test('custom certificate API rejects mismatched keys and remote Domains before persistence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-certificate-http-denied-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await generateCertificate(directory, 'first');
  const second = await generateCertificate(directory, 'second');
  const domainRegistry = createDomainRegistry();
  const domain = await domainRegistry.createDomain({
    serverId: 'remote', primaryDomain: 'secure.example.com', aliases: ['www.secure.example.com'],
    targetType: 'proxy', target: { upstreamPort: 4301 }, httpsMode: 'managed',
  });
  const customRoot = path.join(directory, 'custom-certificates');
  const certificateRegistry = createCertificateRegistry({ customRoot });
  const app = withPanelContext(createApp({
    environment: 'production',
    domainRegistry,
    certificateRegistry,
    certificateMaterialManager: createCertificateMaterialManager({ customRoot, getUid: () => 0 }),
    jobRegistry: createJobRegistry(),
    localServerId: 'local',
  }));

  await withServer(app, async (baseUrl) => {
    const remote = await requestJson(`${baseUrl}/api/domains/${domain.id}/certificates/custom-preview`, {
      method: 'POST', body: first,
    });
    assert.equal(remote.response.status, 409);
    assert.equal(remote.payload.error.code, 'local_certificate_required');

    const localRegistry = createDomainRegistry();
    const local = await localRegistry.createDomain({
      serverId: 'local', primaryDomain: 'secure.example.com', aliases: ['www.secure.example.com'],
      targetType: 'proxy', target: { upstreamPort: 4301 }, httpsMode: 'managed',
    });
    const localApp = withPanelContext(createApp({
      environment: 'production', domainRegistry: localRegistry, certificateRegistry,
      certificateMaterialManager: createCertificateMaterialManager({ customRoot, getUid: () => 0 }),
      jobRegistry: createJobRegistry(), localServerId: 'local',
    }));
    await withServer(localApp, async (localBaseUrl) => {
      const mismatch = await requestJson(`${localBaseUrl}/api/domains/${local.id}/certificates/custom-preview`, {
        method: 'POST',
        body: { ...first, privateKeyPem: second.privateKeyPem },
      });
      assert.equal(mismatch.response.status, 409);
      assert.equal(mismatch.payload.error.code, 'certificate_private_key_mismatch');
      assert.doesNotMatch(JSON.stringify(mismatch.payload), /BEGIN|PRIVATE KEY/);
      assert.equal((await certificateRegistry.listCertificates()).length, 0);
    });
  });
});
