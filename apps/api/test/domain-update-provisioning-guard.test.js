import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainUpdateHandler } from '../src/domain-http.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const domain = { id: '11111111-1111-4111-8111-111111111111', serverId: 'local', websiteId: 'site-1' };

function setup(operation) {
  const updates = [];
  const registry = {
    getDomain: async () => domain,
    previewDomainUpdate: async () => ({ previewDigest: 'a'.repeat(64), confirmation: 'update-domain:ok' }),
    updateDomain: async (input) => { updates.push(input); return { domain }; },
  };
  const handler = createDomainUpdateHandler(registry, {
    localServerId: 'local',
    provisioningRegistry: { getLatestForWebsite: async () => operation },
    now: () => NOW,
  });
  const run = async () => {
    let error = null;
    const response = { json: (payload) => payload, status() { return this; } };
    await handler({ params: { domainId: domain.id }, body: {
      changes: { nginxSettings: { spaFallback: true } }, previewDigest: 'a'.repeat(64), confirmation: 'update-domain:ok',
    } }, response, (err) => { error = err; });
    return error;
  };
  return { run, updates };
}

const step = (state) => ({ id: `step-${state}`, state, required: true });
const operation = (steps, updatedAt = '2026-11-06T11:59:00.000Z') => ({ websiteId: 'site-1', ready: false, status: 'pending', steps, updatedAt });

test('Domain settings cannot change while its Website setup is still running', async () => {
  const f = setup(operation([step('succeeded'), step('pending')]));
  const error = await f.run();
  assert.equal(error?.code, 'domain_update_provisioning_in_progress');
  assert.equal(error?.status, 409);
  assert.equal(f.updates.length, 0);
});

test('a finished, failed or long-idle setup does not block Domain changes', async () => {
  for (const current of [
    null,
    { ...operation([step('succeeded')]), ready: true },
    operation([step('failed'), step('pending')]),
    operation([step('pending')], '2026-11-04T11:00:00.000Z'),
  ]) {
    const f = setup(current);
    assert.equal(await f.run(), null);
    assert.equal(f.updates.length, 1);
  }
});
