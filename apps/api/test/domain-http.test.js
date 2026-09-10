import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainHandler } from '../src/domain-http.js';
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
