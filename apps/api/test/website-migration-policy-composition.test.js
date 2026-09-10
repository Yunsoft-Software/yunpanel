import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createWebsiteMigrationPolicyStore } from '../src/website-migration-policy.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const digest = 'a'.repeat(64);

function completePreview() {
  return {
    version: 1,
    digest,
    destructive: false,
    autoApply: false,
    counts: { total: 1, alreadyBound: 1, ready: 0, ambiguous: 0, unresolved: 0 },
    items: [{ status: 'already_bound', action: 'none', requiresConfirmation: false }],
  };
}

function domainInput(name, extra = {}) {
  return {
    serverId,
    primaryDomain: name,
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    ...extra,
  };
}

test('finalized policy requires Website binding and rollback restores compatibility mode', async () => {
  const policy = createWebsiteMigrationPolicyStore();
  const domains = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? { id, serverId } : null,
    websiteBindingRequired: () => policy.snapshot().websiteBindingRequired,
  });

  const legacy = await domains.createDomain(domainInput('legacy.example.com'));
  await domains.bindWebsite(legacy.id, websiteId);
  await policy.finalize({ preview: completePreview(), previewDigest: digest });

  await assert.rejects(domains.createDomain(domainInput('blocked.example.com')), {
    code: 'website_binding_required', status: 409,
  });
  const explicit = await domains.createDomain(domainInput('bound.example.com', { websiteId }));
  assert.equal(explicit.websiteId, websiteId);

  await policy.rollback({ enforcedDigest: digest });
  const compatible = await domains.createDomain(domainInput('compatible.example.com'));
  assert.equal(compatible.websiteId, null);
});
