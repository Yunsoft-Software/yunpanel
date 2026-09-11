import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDomainHandler,
  createDomainReparentHandler,
  createDomainReparentPreviewHandler,
  createDomainUpdateHandler,
  createDomainUpdatePreviewHandler,
} from '../src/domain-http.js';
import { createDomainRegistry } from '../src/domain-registry.js';

function responseRecorder() {
  return {
    code: null, payload: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}
const body = { serverId: 'local', primaryDomain: 'example.com', targetType: 'proxy', target: { upstreamPort: 4301 } };

test('HTTP mapping passes parent IDs into the real registry and returns 201', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(body);
  const response = responseRecorder();
  await createDomainHandler(registry)({ body: { ...body, primaryDomain: 'api.example.com', parentDomainId: root.id, kind: 'domain' } }, response, (error) => { throw error; });
  assert.equal(response.code, 201);
  assert.equal(response.payload.data.parentDomainId, root.id);
  assert.equal(response.payload.data.kind, 'subdomain');
  assert.equal((await registry.getDomain(response.payload.data.id)).parentDomainId, root.id);
});

test('HTTP mapping forwards explicit Website IDs without accepting inferred linkage', async () => {
  const websiteId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
  const registry = createDomainRegistry({
    getWebsite: async (id) => id === websiteId ? { id, serverId: 'local' } : null,
  });
  const response = responseRecorder();
  await createDomainHandler(registry)({ body: { ...body, websiteId } }, response, (error) => { throw error; });
  assert.equal(response.code, 201);
  assert.equal(response.payload.data.websiteId, websiteId);

  const legacy = responseRecorder();
  await createDomainHandler(registry)({ body: { ...body, primaryDomain: 'other.example.com' } }, legacy, (error) => { throw error; });
  assert.equal(legacy.payload.data.websiteId, null);
});

test('parent validation failures reach the error middleware without a success response', async () => {
  const registry = createDomainRegistry();
  const response = responseRecorder();
  let failure;
  await createDomainHandler(registry)({ body: { ...body, parentDomainId: 'missing' } }, response, (error) => { failure = error; });
  assert.equal(failure.code, 'parent_domain_not_found');
  assert.equal(failure.status, 404);
  assert.equal(response.code, null);
  assert.equal((await registry.listDomains()).length, 0);
});

test('legacy domain requests remain independent with the same defaults', async () => {
  const registry = createDomainRegistry();
  const response = responseRecorder();
  await createDomainHandler(registry)({ body }, response, (error) => { throw error; });
  assert.equal(response.code, 201);
  assert.equal(response.payload.data.websiteId, null);
  assert.equal(response.payload.data.parentDomainId, null);
  assert.equal(response.payload.data.httpsMode, 'off');
  assert.deepEqual(response.payload.data.aliases, []);
});

test('HTTP reparent requires exact digest and typed confirmation before mutation', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(body);
  const child = await registry.createDomain({ ...body, primaryDomain: 'api.example.com', parentDomainId: root.id });
  const previewResponse = responseRecorder();
  await createDomainReparentPreviewHandler(registry)(
    { params: { domainId: child.id }, body: { parentDomainId: null } },
    previewResponse,
    (error) => { throw error; },
  );
  const preview = previewResponse.payload.data;
  assert.equal(preview.nextParentDomainId, null);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);

  const denied = responseRecorder();
  let deniedError;
  await createDomainReparentHandler(registry)(
    {
      params: { domainId: child.id },
      body: { parentDomainId: null, previewDigest: preview.previewDigest, confirmation: 'wrong' },
    },
    denied,
    (error) => { deniedError = error; },
  );
  assert.equal(deniedError.code, 'domain_reparent_confirmation_required');
  assert.equal((await registry.getDomain(child.id)).parentDomainId, root.id);

  const applied = responseRecorder();
  await createDomainReparentHandler(registry)(
    {
      params: { domainId: child.id },
      body: { parentDomainId: null, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
    },
    applied,
    (error) => { throw error; },
  );
  assert.equal(applied.payload.data.domain.parentDomainId, null);
  assert.equal(applied.payload.data.impact.domainTrafficChanged, false);
});

test('HTTP reparent rejects unknown body fields and stale digest without mutation', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(body);
  const child = await registry.createDomain({ ...body, primaryDomain: 'api.example.com', parentDomainId: root.id });
  const preview = await registry.previewDomainReparent({ domainId: child.id, parentDomainId: null });

  for (const requestBody of [
    { parentDomainId: null, hidden: true },
    { parentDomainId: null, previewDigest: preview.previewDigest, confirmation: preview.confirmation, hidden: true },
    { parentDomainId: null, previewDigest: '0'.repeat(64), confirmation: preview.confirmation },
  ]) {
    let failure;
    const handler = Object.hasOwn(requestBody, 'previewDigest')
      ? createDomainReparentHandler(registry)
      : createDomainReparentPreviewHandler(registry);
    await handler(
      { params: { domainId: child.id }, body: requestBody },
      responseRecorder(),
      (error) => { failure = error; },
    );
    assert.ok(failure instanceof Error);
    assert.equal((await registry.getDomain(child.id)).parentDomainId, root.id);
  }
});

test('HTTP Domain update requires current preview and exact typed confirmation', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(body);
  const changes = { aliases: ['www.example.com'], canonicalRedirect: true };
  const previewResponse = responseRecorder();
  await createDomainUpdatePreviewHandler(registry)(
    { params: { domainId: domain.id }, body: { changes } },
    previewResponse,
    (error) => { throw error; },
  );
  const preview = previewResponse.payload.data;
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.next.canonicalRedirect, true);

  let deniedError;
  await createDomainUpdateHandler(registry)(
    { params: { domainId: domain.id }, body: { changes, previewDigest: preview.previewDigest, confirmation: 'wrong' } },
    responseRecorder(),
    (error) => { deniedError = error; },
  );
  assert.equal(deniedError.code, 'domain_update_confirmation_required');
  assert.deepEqual((await registry.getDomain(domain.id)).aliases, []);

  const applied = responseRecorder();
  await createDomainUpdateHandler(registry)(
    { params: { domainId: domain.id }, body: { changes, previewDigest: preview.previewDigest, confirmation: preview.confirmation } },
    applied,
    (error) => { throw error; },
  );
  assert.deepEqual(applied.payload.data.domain.aliases, ['www.example.com']);
  assert.equal(applied.payload.data.domain.canonicalRedirect, true);
});

test('HTTP Domain update rejects unknown outer fields and stale digests', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(body);
  const changes = { canonicalRedirect: true };
  for (const requestBody of [
    { changes, hidden: true },
    { changes, previewDigest: '0'.repeat(64), confirmation: 'wrong', hidden: true },
    { changes, previewDigest: '0'.repeat(64), confirmation: 'wrong' },
  ]) {
    let failure;
    const handler = Object.hasOwn(requestBody, 'previewDigest') ? createDomainUpdateHandler(registry) : createDomainUpdatePreviewHandler(registry);
    await handler(
      { params: { domainId: domain.id }, body: requestBody },
      responseRecorder(),
      (error) => { failure = error; },
    );
    assert.ok(failure instanceof Error);
    assert.equal((await registry.getDomain(domain.id)).canonicalRedirect, false);
  }
});

test('HTTP Domain update apply waits for Domain and certificate operations', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(body);
  const changes = { canonicalRedirect: true };
  const preview = await registry.previewDomainUpdate({ domainId: domain.id, changes });
  const request = {
    params: { domainId: domain.id },
    body: { changes, previewDigest: preview.previewDigest, confirmation: preview.confirmation },
  };

  for (const dependencies of [
    { jobRegistry: { listJobs: async () => [{ status: 'running' }] } },
    { certificateRegistry: { listCertificates: async () => [{ domainId: domain.id, state: 'issuing' }] } },
  ]) {
    let failure;
    await createDomainUpdateHandler(registry, dependencies)(request, responseRecorder(), (error) => { failure = error; });
    assert.equal(failure.code, 'domain_update_operation_conflict');
    assert.equal((await registry.getDomain(domain.id)).canonicalRedirect, false);
  }
});
