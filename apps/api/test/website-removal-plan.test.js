import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebsiteRemovalPreview,
  WebsiteRemovalPlanError,
} from '../src/website-removal-plan.js';

function website(overrides = {}) {
  return {
    id: 'ws-1',
    name: 'example-site',
    serverId: 'srv-local',
    applicationId: 'app-1',
    systemUser: 'yunapp-site1',
    unixUser: 'yunapp-site1',
    state: 'active',
    suspended: false,
    desiredRevision: 2,
    stagedRevision: 2,
    appliedRevision: 2,
    ...overrides,
  };
}

function impact(currentWebsite = website(), overrides = {}) {
  const dependencies = {
    domains: [
      { id: 'dom-sub', primaryDomain: 'sub.example.com', parentDomainId: 'dom-root' },
      { id: 'dom-root', primaryDomain: 'example.com', parentDomainId: null },
    ],
    databases: { status: 'available', items: [{ id: 'db-1', state: 'mydb' }] },
    sftpKeys: { status: 'available', items: [{ id: 'key-1', state: 'active' }] },
    runtimeBindings: { status: 'available', items: [{ id: 'rb-1', state: 'active' }] },
    unixIdentities: { status: 'available', items: [{ id: 'yunapp-site1', state: 'active' }] },
    logScopes: { status: 'available', items: [{ id: 'ws-1', state: 'managed' }] },
    crons: { status: 'available', items: [] },
    backups: { status: 'available', items: [] },
    activeJobs: [],
    ...(overrides.dependencies ?? {}),
  };

  const previewDigest = overrides.previewDigest ?? 'a'.repeat(64);
  const confirmation = `delete:website:${currentWebsite.id}:${previewDigest}`;

  return {
    version: 1,
    resourceType: 'website',
    resource: {
      id: currentWebsite.id,
      serverId: currentWebsite.serverId,
    },
    operation: 'delete',
    targetServerId: null,
    dependencies,
    blockers: overrides.blockers ?? [
      { code: 'domains_present', resourceType: 'domain', count: 2 },
    ],
    previewDigest,
    confirmation,
  };
}

test('creates deterministic website removal preview with ordered domains', () => {
  const ws = website();
  const imp = impact(ws);
  const preview = createWebsiteRemovalPreview({ website: ws, impact: imp });

  assert.equal(preview.operation, 'website_remove');
  assert.equal(preview.readyToStart, true);
  assert.deepEqual(preview.hardBlockers, []);
  assert.equal(preview.website.id, 'ws-1');
  assert.deepEqual(preview.plan.domainIds, ['dom-sub', 'dom-root']); // Subdomain before root domain
  assert.equal(preview.plan.applicationId, 'app-1');
  assert.equal(preview.plan.systemUser, 'yunapp-site1');
  assert.equal(preview.plan.additional.databases.status, 'available');
  assert.deepEqual(preview.plan.additional.databases.ids, ['db-1']);
  assert.ok(preview.previewDigest);
  assert.equal(preview.confirmation, `start-website-remove:ws-1:2:${preview.previewDigest}`);
});

test('fails closed with hardBlocker when an inventory bucket is unavailable', () => {
  const ws = website();
  const imp = impact(ws, {
    dependencies: {
      databases: { status: 'unavailable', items: [] },
    },
    blockers: [
      { code: 'dependency_inventory_unavailable', resourceType: 'database' },
    ],
  });

  const preview = createWebsiteRemovalPreview({ website: ws, impact: imp });
  assert.equal(preview.readyToStart, false);
  assert.ok(preview.hardBlockers.includes('databases_inventory_unavailable'));
  assert.equal(preview.confirmation, null);
});

test('fails closed on active jobs present', () => {
  const ws = website();
  const imp = impact(ws, {
    dependencies: {
      activeJobs: [{ id: 'job-1' }],
    },
    blockers: [
      { code: 'active_jobs_present', resourceType: 'job' },
    ],
  });

  const preview = createWebsiteRemovalPreview({ website: ws, impact: imp });
  assert.equal(preview.readyToStart, false);
  assert.ok(preview.hardBlockers.includes('active_jobs_present'));
  assert.equal(preview.confirmation, null);
});

test('rejects mismatched or stale impact confirmation', () => {
  const ws = website();
  const imp = impact(ws);
  imp.confirmation = 'wrong_confirmation';

  assert.throws(
    () => createWebsiteRemovalPreview({ website: ws, impact: imp }),
    (err) => err instanceof WebsiteRemovalPlanError && err.code === 'website_removal_impact_invalid',
  );
});
