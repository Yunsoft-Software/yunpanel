import assert from 'node:assert/strict';
import test from 'node:test';
import { previewWebsiteMigration, WebsiteMigrationPreviewError } from '../src/website-migration-preview.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const staticAppId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const nodeAppId = '340344cf-4e57-4f70-946a-3c6e919e951d';
const nodeApp2Id = '55eb283e-b1a4-471a-89fe-74959f83d482';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const domainIds = [
  '0ef7e00b-1b85-4938-b726-247c94679c66',
  '2f4d1b59-b32e-42b1-83dd-a7a6151a2e5d',
  '4c2804ab-6898-49ee-8c0e-53282138e357',
  'a255dc88-f155-4ab6-991d-ed996f58ac84',
];

function applications(extra = []) {
  return [
    { id: staticAppId, serverId, type: 'static', webRoot: `/var/www/yunpanel/apps/${staticAppId}/current`, proxyTarget: null },
    { id: nodeAppId, serverId, type: 'node', webRoot: null, proxyTarget: { host: '127.0.0.1', port: 4301 } },
    ...extra,
  ];
}

function domain(id, hostname, targetType, target, websiteIdValue = null) {
  return { id, serverId, primaryDomain: hostname, websiteId: websiteIdValue, targetType, target };
}

test('preview distinguishes existing Website binding and create-Website candidates without applying', () => {
  const result = previewWebsiteMigration({
    applications: applications(),
    websites: [{ id: websiteId, serverId, applicationId: staticAppId, runtimeType: 'static' }],
    domains: [
      domain(domainIds[0], 'static.example.com', 'static', { root: `/var/www/yunpanel/apps/${staticAppId}/current` }),
      domain(domainIds[1], 'api.example.com', 'proxy', { upstreamPort: 4301 }),
    ],
  });
  assert.equal(result.destructive, false);
  assert.equal(result.autoApply, false);
  assert.deepEqual(result.counts, { total: 2, alreadyBound: 0, ready: 2, ambiguous: 0, unresolved: 0 });
  assert.deepEqual(
    result.items.map((item) => [item.action, item.websiteId, item.applicationId]),
    [
      ['bind_existing_website', websiteId, staticAppId],
      ['create_website_then_bind', null, nodeAppId],
    ],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('/var/www/'), false);
  assert.equal(serialized.includes('4301'), false);
});

test('preview reports ambiguous and unresolved legacy targets instead of guessing', () => {
  const result = previewWebsiteMigration({
    applications: applications([{ id: nodeApp2Id, serverId, type: 'node', proxyTarget: { host: '127.0.0.1', port: 4301 } }]),
    websites: [],
    domains: [
      domain(domainIds[0], 'api.example.com', 'proxy', { upstreamPort: 4301 }),
      domain(domainIds[1], 'external.example.com', 'proxy', { upstreamPort: 5500 }),
    ],
  });
  assert.equal(result.items[0].status, 'ambiguous');
  assert.deepEqual(result.items[0].candidateApplicationIds, [nodeAppId, nodeApp2Id].sort());
  assert.equal(result.items[1].status, 'unresolved');
  assert.equal(result.items.every((item) => item.requiresConfirmation), true);
});

test('already-bound Domains remain explicit and are not remapped', () => {
  const result = previewWebsiteMigration({
    applications: applications(),
    websites: [{ id: websiteId.toUpperCase(), serverId: serverId.toUpperCase(), applicationId: staticAppId.toUpperCase(), runtimeType: 'static' }],
    domains: [domain(domainIds[0].toUpperCase(), 'example.com', 'static', { root: '/ignored' }, websiteId.toUpperCase())],
  });
  assert.equal(result.items[0].status, 'already_bound');
  assert.equal(result.items[0].websiteId, websiteId);
  assert.equal(result.items[0].applicationId, staticAppId);
  assert.equal(result.items[0].requiresConfirmation, false);
});

test('invalid bound references and inconsistent Website state fail closed', () => {
  assert.throws(
    () => previewWebsiteMigration({
      applications: applications(),
      websites: [],
      domains: [domain(domainIds[0], 'example.com', 'proxy', { upstreamPort: 4301 }, websiteId)],
    }),
    (error) => error instanceof WebsiteMigrationPreviewError && error.code === 'website_migration_bound_reference_invalid',
  );

  assert.throws(
    () => previewWebsiteMigration({
      applications: applications(),
      websites: [{ id: websiteId, serverId, applicationId: 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7' }],
      domains: [],
    }),
    (error) => error instanceof WebsiteMigrationPreviewError && error.code === 'website_migration_state_invalid',
  );
});
