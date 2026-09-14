import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningHandlers } from '../src/website-provisioning-handlers.js';

function dependencies() {
  return {
    identityManager: {
      apply: async () => ({ satisfied: true }),
      inspect: async () => ({ satisfied: true }),
    },
    passengerSiteManager: {
      apply: async () => ({ satisfied: true }),
      inspect: async () => ({ satisfied: true }),
    },
    nginxManager: {
      stageDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64) }),
      inspectStagedDomain: async () => ({ satisfied: false, result: null }),
      inspectActiveDomain: async () => ({ satisfied: false, result: null }),
      activateDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64), active: true }),
    },
  };
}

test('managed HTTPS never becomes ready before certificate orchestration is wired', async () => {
  const handlers = createWebsiteProvisioningHandlers(dependencies());
  const intent = {
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    primaryDomain: 'example.com',
    wwwDomain: 'www.example.com',
  };

  const applied = await handlers.certificate.apply({ intent });
  const inspected = await handlers.certificate.inspect({ intent });

  assert.deepEqual(applied, {
    satisfied: false,
    reason: 'certificate_provisioning_pending',
    primaryDomain: 'example.com',
  });
  assert.deepEqual(inspected, applied);
});
