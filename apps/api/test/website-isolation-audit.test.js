import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import {
  createWebsiteIsolationAuditService,
  WebsiteIsolationAuditError,
} from '../src/website-isolation-audit.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const identity = createApplicationIdentity(applicationId);

function hostedWebsite(runtimeType = 'php', overrides = {}) {
  const documentRoot = runtimeType === 'static'
    ? `${identity.paths.static.publishRoot}/current`
    : runtimeType === 'php'
      ? `${identity.paths.runtime.currentRelease}/public`
      : identity.paths.runtime.currentRelease;
  return {
    id: websiteId,
    serverId,
    applicationId,
    runtimeType,
    unixUser: identity.unixUser,
    documentRoot,
    revision: 3,
    ...overrides,
  };
}

function application(runtimeType = 'php') {
  return { id: applicationId, serverId, type: runtimeType };
}

function operation(runtimeType = 'php') {
  const runtimeStep = runtimeType === 'php' ? 'php_runtime' : 'runtime';
  return {
    operationId,
    websiteId,
    steps: [
      { id: 'unix_identity', kind: 'unix_identity', state: 'succeeded', intent: { scope: 'identity' }, evidence: null, compensation: {} },
      { id: runtimeStep, kind: runtimeStep, state: 'succeeded', intent: { scope: 'runtime' }, evidence: null, compensation: {} },
      { id: 'sftp', kind: 'sftp', state: 'succeeded', intent: { scope: 'sftp' }, evidence: null, compensation: {} },
    ],
  };
}

function service({
  runtimeType = 'php',
  website = hostedWebsite(runtimeType),
  currentApplication = application(runtimeType),
  latest = operation(runtimeType),
  stepResults = {},
  workspaceMigrationAvailable = false,
} = {}) {
  const handlers = {};
  for (const kind of ['unix_identity', 'runtime', 'php_runtime', 'sftp']) {
    handlers[kind] = {
      async inspect() {
        const result = stepResults[kind] ?? { satisfied: true };
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }
  return createWebsiteIsolationAuditService({
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? website : null; } },
    applicationRegistry: { async getApplication(id) { return id === applicationId ? currentApplication : null; } },
    provisioningRegistry: { async getLatestForWebsite(id) { return id === websiteId ? latest : null; } },
    provisioningHandlers: handlers,
    workspaceMigrationAvailable,
  });
}

test('isolation audit is mutation-free and reports an isolated hosted Website', async () => {
  const audit = await service().audit(websiteId);
  assert.equal(audit.status, 'isolated');
  assert.equal(audit.migrationRequired, false);
  assert.equal(audit.migration, null);
  assert.deepEqual(audit.findings, []);
  assert.deepEqual(audit.inspectedSteps.map((step) => [step.stepId, step.satisfied]), [
    ['unix_identity', true],
    ['php_runtime', true],
    ['sftp', true],
  ]);
});

test('isolation audit produces explicit non-destructive migration preview on drift', async () => {
  const audit = await service({
    website: hostedWebsite('php', { unixUser: 'yunapp-aaaaaaaaaaaa', documentRoot: '/srv/legacy/public' }),
    stepResults: { sftp: { satisfied: false, reason: 'sftp_key_reconcile_required', keyReason: 'sftp_authorized_keys_outdated' } },
  }).audit(websiteId);

  assert.equal(audit.status, 'migration_required');
  assert.equal(audit.migrationRequired, true);
  assert.equal(audit.migration.autoApply, false);
  assert.equal(audit.migration.destructive, false);
  assert.equal(audit.migration.applyAvailable, false);
  assert.match(audit.migration.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(audit.migration.confirmation, `migrate-isolation:${websiteId}:3:${audit.migration.previewDigest}`);
  assert.match(audit.migration.warning, /No ownership, filesystem or runtime mutation/);
  assert.equal(audit.findings.some((entry) => entry.code === 'website_isolation_unix_user_drift'), true);
  assert.equal(audit.findings.some((entry) => entry.code === 'website_isolation_document_root_drift'), true);
  assert.equal(audit.findings.some((entry) => entry.code === 'website_isolation_sftp_not_satisfied'), true);
  assert.equal(audit.inspectedSteps.find((step) => step.stepId === 'sftp').reason, 'sftp_key_reconcile_required');
  assert.deepEqual(audit.migration.changes.map((change) => [change.id, change.action, change.ownership]), [
    ['website.unix_identity', 'adopt_canonical_unix_identity', 'legacy_review_required'],
    ['website.document_root', 'adopt_canonical_document_root', 'legacy_review_required'],
    ['provisioning.sftp', 'reconcile_isolation_step', 'operation_receipt_required'],
  ]);
  assert.deepEqual(audit.migration.changes[0], {
    id: 'website.unix_identity',
    action: 'adopt_canonical_unix_identity',
    ownership: 'legacy_review_required',
    applyState: 'blocked',
    current: { unixUser: 'yunapp-aaaaaaaaaaaa' },
    desired: { unixUser: identity.unixUser },
  });
  assert.equal(audit.migration.changes[2].current.stepState, 'succeeded');
  assert.match(audit.migration.changes[2].current.intentSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(audit.migration).includes('"scope":"sftp"'), false);
});

test('isolation migration digest pins the inspected exact-change reason', async () => {
  const first = await service({
    stepResults: { sftp: { satisfied: false, reason: 'sftp_key_reconcile_required' } },
  }).audit(websiteId);
  const second = await service({
    stepResults: { sftp: { satisfied: false, reason: 'sftp_authorized_keys_file_missing' } },
  }).audit(websiteId);

  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
  assert.notDeepEqual(first.migration.changes, second.migration.changes);
});

test('isolation audit emits exact receipt-bound directory changes for canonical workspace gaps', async () => {
  const audit = await service({
    workspaceMigrationAvailable: true,
    stepResults: {
      unix_identity: {
        satisfied: false,
        reason: 'website_identity_workspace_missing',
        missingWorkspace: 'temporary',
        missingWorkspaces: ['temporary', 'logs'],
      },
    },
  }).audit(websiteId);

  assert.equal(audit.migration.changes.length, 1);
  assert.equal(audit.migration.applyAvailable, true);
  assert.match(audit.migration.warning, /does not rename users/);
  assert.deepEqual(audit.inspectedSteps[0].missingWorkspaces, ['temporary', 'logs']);
  assert.deepEqual(audit.migration.changes[0], {
    id: 'workspace.directories',
    action: 'create_workspace_directories',
    ownership: 'operation_receipt_planned',
    applyState: 'requires_explicit_apply',
    current: {
      operationId,
      stepId: 'unix_identity',
      stepKind: 'unix_identity',
      stepState: 'succeeded',
      intentSha256: audit.migration.changes[0].current.intentSha256,
      directories: [
        { name: 'temporary', directory: identity.paths.workspace.temporaryDirectory, present: false },
        { name: 'logs', directory: identity.paths.workspace.logDirectory, present: false },
      ],
    },
    desired: {
      directories: [
        { name: 'temporary', directory: identity.paths.workspace.temporaryDirectory, mode: '0700' },
        { name: 'logs', directory: identity.paths.workspace.logDirectory, mode: '0750' },
      ],
    },
  });
});

test('isolation audit fails closed when managed host inspection detects drift', async () => {
  const drift = new Error('drift');
  drift.code = 'website_identity_workspace_drift';
  const audit = await service({ stepResults: { unix_identity: drift } }).audit(websiteId);
  assert.equal(audit.status, 'migration_required');
  assert.equal(audit.inspectedSteps.find((step) => step.stepId === 'unix_identity').reason, 'website_identity_workspace_drift');
  assert.equal(audit.findings.some((entry) => entry.code === 'website_isolation_unix_identity_drift'), true);
});

test('proxy Website isolation audit is explicitly not applicable', async () => {
  const website = {
    id: websiteId,
    serverId,
    applicationId: null,
    runtimeType: 'proxy',
    unixUser: null,
    documentRoot: null,
    revision: 1,
  };
  const audit = await createWebsiteIsolationAuditService({
    websiteRegistry: { async getWebsite() { return website; } },
    applicationRegistry: { async getApplication() { return null; } },
  }).audit(websiteId);
  assert.equal(audit.applicable, false);
  assert.equal(audit.status, 'not_applicable');
  assert.equal(audit.migrationRequired, false);
});

test('isolation audit rejects Website/Application binding drift', async () => {
  await assert.rejects(
    service({ currentApplication: { id: applicationId, serverId: 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23', type: 'php' } }).audit(websiteId),
    (error) => error instanceof WebsiteIsolationAuditError && error.code === 'website_isolation_binding_drift',
  );
});
