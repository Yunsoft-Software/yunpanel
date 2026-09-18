import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createCertificateRegistry } from '../src/certificate-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import {
  ownerManagementContext,
  readOnlyManagementContext,
  withPanelContext,
} from './helpers/panel-auth-fixture.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try { await callback('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function fixture() {
  const registry = createServerRegistry();
  const enrollment = await registry.issueEnrollmentToken({ label: 'suspension-http' });
  const enrolled = await registry.enrollServer({
    token: enrollment.token,
    hostname: 'suspension-http-host',
  });
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
  });
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getApplication: async (id) => applicationRegistry.getApplication(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => Boolean(await registry.getServer(id)),
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });
  const certificateRegistry = createCertificateRegistry();
  const jobRegistry = createJobRegistry();
  const domain = await domainRegistry.createDomain({
    serverId: enrolled.server.id,
    primaryDomain: 'suspend-http.example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3300 },
  });
  return {
    registry,
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    certificateRegistry,
    jobRegistry,
    domain,
  };
}

function post(baseUrl, path, body) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('production app mounts injected Domain suspension preview and typed suspend routes', async () => {
  const state = await fixture();
  const calls = [];
  const previewDigest = 'a'.repeat(64);
  const preview = {
    version: 1,
    operation: 'domain_suspend',
    domain: {
      id: state.domain.id,
      serverId: state.domain.serverId,
      primaryDomain: state.domain.primaryDomain,
      desiredRevision: 1,
      stagedRevision: 1,
      appliedRevision: 1,
      stagedChecksum: 'b'.repeat(64),
      state: 'active',
    },
    nginx: {
      satisfied: false,
      deactivationCandidate: true,
      checksum: 'b'.repeat(64),
    },
    activeJobs: [],
    blockers: [],
    readyToSuspend: true,
    previewDigest,
    confirmation: 'suspend-confirmation',
    sideEffects: false,
  };
  const operation = {
    id: '12345678-1234-4234-8234-123456789012',
    domainId: state.domain.id,
    status: 'suspended',
  };
  const domainSuspensionRuntime = {
    preview: async (input) => { calls.push(['preview', input]); return preview; },
    start: async (input) => { calls.push(['start', input]); return operation; },
    retrySuspend: async () => operation,
    resume: async () => operation,
    retryResume: async () => operation,
    get: async () => operation,
    listForDomain: async () => [operation],
  };
  const app = withPanelContext(createApp({
    ...state,
    environment: 'production',
    localServerId: state.domain.serverId,
    domainSuspensionRuntime,
  }), ownerManagementContext);

  await withServer(app, async (baseUrl) => {
    let response = await post(
      baseUrl,
      '/api/domains/' + state.domain.id + '/suspend-preview',
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, preview);

    response = await post(
      baseUrl,
      '/api/domains/' + state.domain.id + '/suspend',
      { previewDigest, confirmation: preview.confirmation },
    );
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()).data, operation);
  });

  assert.deepEqual(calls, [
    ['preview', { domainId: state.domain.id }],
    ['start', {
      domainId: state.domain.id,
      previewDigest,
      confirmation: preview.confirmation,
    }],
  ]);
});

test('Read Only cannot trigger Domain suspension mutation routes', async () => {
  const state = await fixture();
  let calls = 0;
  const domainSuspensionRuntime = {
    preview: async () => { calls += 1; return {}; },
    start: async () => { calls += 1; return {}; },
    retrySuspend: async () => ({}),
    resume: async () => ({}),
    retryResume: async () => ({}),
    get: async () => null,
    listForDomain: async () => [],
  };
  const app = withPanelContext(createApp({
    ...state,
    environment: 'production',
    localServerId: state.domain.serverId,
    domainSuspensionRuntime,
  }), readOnlyManagementContext);

  await withServer(app, async (baseUrl) => {
    assert.equal((await post(
      baseUrl,
      '/api/domains/' + state.domain.id + '/suspend-preview',
      {},
    )).status, 403);
    assert.equal((await post(
      baseUrl,
      '/api/domains/' + state.domain.id + '/suspend',
      {
        previewDigest: 'a'.repeat(64),
        confirmation: 'suspend-confirmation',
      },
    )).status, 403);
  });
  assert.equal(calls, 0);
});
