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
    application: currentWebsite.applicationId ? {
      id: currentWebsite.applicationId,
      serverId: currentWebsite.serverId,
      name: 'app',
      type: 'node',
      state: 'active',
      desiredRevision: 7,
      currentReleaseId: null,
      activeDeploymentId: null,
    } : null,
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
  assert.equal(preview.plan.applicationRevision, 7);
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

test('orchestratable website impact blockers do not prevent removal preview from starting', () => {
  const ws = website();
  const imp = impact(ws, {
    blockers: [
      { code: 'domains_present', resourceType: 'domain', count: 2 },
      { code: 'linked_domains_present', resourceType: 'domain', count: 1 },
      { code: 'child_domains_present', resourceType: 'domain', count: 1 },
      { code: 'website_binding_present', resourceType: 'website', count: 1 },
      { code: 'application_binding_present', resourceType: 'application', count: 1 },
      { code: 'database_binding_dependencies_present', resourceType: 'database_binding', count: 1 },
      { code: 'sftp_key_dependencies_present', resourceType: 'sftp_key', count: 1 },
      { code: 'runtime_binding_dependencies_present', resourceType: 'runtime_binding', count: 1 },
      { code: 'unix_identity_dependencies_present', resourceType: 'unix_identity', count: 1 },
      { code: 'log_scope_dependencies_present', resourceType: 'log_scope', count: 1 },
      { code: 'cron_dependencies_present', resourceType: 'cron', count: 1 },
      { code: 'backup_dependencies_present', resourceType: 'backup', count: 1 },
      { code: 'impact_apply_not_implemented', resourceType: 'website' },
    ],
  });

  const preview = createWebsiteRemovalPreview({ website: ws, impact: imp });
  assert.equal(preview.readyToStart, true);
  assert.deepEqual(preview.hardBlockers, []);
  assert.ok(preview.confirmation.startsWith('start-website-remove:ws-1:2:'));
});


test('rejects missing or mismatched Application revision evidence', () => {
  const ws=website();
  const missing=impact(ws); delete missing.application;
  assert.throws(()=>createWebsiteRemovalPreview({website:ws,impact:missing}),
    (err)=>err instanceof WebsiteRemovalPlanError && err.code==='website_removal_application_state_invalid');
  const wrong=impact(ws); wrong.application={...wrong.application,id:'other'};
  assert.throws(()=>createWebsiteRemovalPreview({website:ws,impact:wrong}),
    (err)=>err instanceof WebsiteRemovalPlanError && err.code==='website_removal_application_state_invalid');
});


test('pins direct-systemd Application evidence even without a runtime binding dependency', () => {
  const ws = website();
  const imp = impact(ws, {
    dependencies: {
      runtimeBindings: { status: 'available', items: [] },
    },
  });
  const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  imp.application = { ...imp.application, currentReleaseId: releaseId };
  const preview = createWebsiteRemovalPreview({
    website: ws,
    impact: imp,
    applicationState: {
      id: 'app-1',
      serverId: 'srv-local',
      name: 'app',
      type: 'node',
      state: 'active',
      desiredRevision: 7,
      currentReleaseId: releaseId,
      activeDeploymentId: null,
      runtimeAdapter: 'direct-systemd',
      serviceName: 'yunpanel-node-aaaaaaaaaaaaaaaa.service',
      currentCommitSha: 'b'.repeat(40),
      servicePort: 3100,
      healthPath: '/health',
    },
  });
  assert.deepEqual(preview.plan.additional.runtimeBindings.ids, []);
  assert.deepEqual(preview.plan.applicationRuntime, {
    type: 'node',
    adapter: 'direct-systemd',
    releaseId,
    serviceName: 'yunpanel-node-aaaaaaaaaaaaaaaa.service',
    currentCommitSha: 'b'.repeat(40),
    servicePort: 3100,
    healthPath: '/health',
  });
});

test('rejects Application runtime evidence that moved after resource-impact capture', () => {
  const ws = website();
  const imp = impact(ws);
  assert.throws(
    () => createWebsiteRemovalPreview({
      website: ws,
      impact: imp,
      applicationState: {
        id: 'app-1',
        serverId: 'srv-local',
        type: 'node',
        desiredRevision: 8,
        currentReleaseId: null,
        runtimeAdapter: 'direct-systemd',
        serviceName: null,
        currentCommitSha: null,
        servicePort: 3100,
        healthPath: '/health',
      },
    }),
    (error) => error instanceof WebsiteRemovalPlanError
      && error.code === 'website_removal_application_runtime_state_invalid',
  );
});
