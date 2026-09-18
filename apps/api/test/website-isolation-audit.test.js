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
  migrationPreviews = {},
  workspaceMigrationAvailable = false,
  identityMigrationAvailable = false,
} = {}) {
  const handlers = {};
  for (const kind of ['unix_identity', 'runtime', 'static_runtime', 'php_runtime', 'sftp']) {
    const sourceKind = kind === 'static_runtime' ? 'runtime' : kind;
    handlers[kind] = {
      async inspect() {
        const result = stepResults[sourceKind] ?? { satisfied: true };
        if (result instanceof Error) throw result;
        return result;
      },
      async previewMigration() {
        return migrationPreviews[sourceKind] ?? null;
      },
    };
  }
  return createWebsiteIsolationAuditService({
    websiteRegistry: { async getWebsite(id) { return id === websiteId ? website : null; } },
    applicationRegistry: { async getApplication(id) { return id === applicationId ? currentApplication : null; } },
    provisioningRegistry: { async getLatestForWebsite(id) { return id === websiteId ? latest : null; } },
    provisioningHandlers: handlers,
    workspaceMigrationAvailable,
    identityMigrationAvailable,
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

test('isolation audit opens apply only for an all-missing canonical Unix identity preview', async () => {
  const preview = {
    version: 1,
    satisfied: false,
    safeCreateCandidate: true,
    current: { account: null, group: null, home: null },
    desired: {
      user: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
      shellPolicy: 'nologin',
      privateGroup: true,
      groupMemberCount: 0,
      homeMode: '0750',
    },
    differences: [
      'website_identity_user_missing',
      'website_identity_group_missing',
      'website_identity_home_missing',
    ],
  };
  const audit = await service({
    identityMigrationAvailable: true,
    stepResults: { unix_identity: { satisfied: false, reason: 'website_identity_user_missing' } },
    migrationPreviews: { unix_identity: preview },
  }).audit(websiteId);

  assert.equal(audit.migration.applyAvailable, true);
  assert.match(audit.migration.warning, /all-missing canonical Unix user\/group\/HOME/);
  assert.equal(audit.migration.changes[0].action, 'create_canonical_unix_identity');
  assert.equal(audit.migration.changes[0].ownership, 'operation_receipt_planned');
  assert.equal(audit.migration.changes[0].applyState, 'requires_explicit_apply');
  assert.deepEqual(audit.migration.changes[0].desired, { identity: preview.desired });

  const blocked = await service({
    identityMigrationAvailable: true,
    stepResults: { unix_identity: { satisfied: false, reason: 'website_identity_home_drift' } },
    migrationPreviews: {
      unix_identity: {
        ...preview,
        safeCreateCandidate: false,
        current: { account: null, group: null, home: { uid: 1201, gid: 1201, mode: '0755' } },
        differences: ['website_identity_home_conflict'],
      },
    },
  }).audit(websiteId);
  assert.equal(blocked.migration.applyAvailable, false);
  assert.equal(blocked.migration.changes[0].action, 'reconcile_isolation_step');
  assert.equal(blocked.migration.changes[0].applyState, 'blocked');
});

test('isolation audit pins a public-safe Unix identity migration preview into drift digest', async () => {
  const drift = Object.assign(new Error('drift'), { code: 'website_identity_drift' });
  const migrationPreview = {
    version: 1,
    satisfied: false,
    safeCreateCandidate: false,
    current: {
      account: { uid: 1201, gid: 1201, homeDirectory: '/srv/legacy', shell: '/bin/bash' },
      group: { gid: 1201, memberCount: 1, members: ['hidden-member'] },
      home: { uid: 1201, gid: 1201, mode: '0755' },
    },
    desired: {
      user: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
      shellPolicy: 'nologin',
      privateGroup: true,
      groupMemberCount: 0,
      homeMode: '0750',
    },
    differences: [
      'website_identity_account_home_drift',
      'website_identity_account_shell_drift',
      'website_identity_group_members_drift',
      'website_identity_home_mode_drift',
    ],
    rawSecret: 'do-not-project',
  };
  const first = await service({
    stepResults: { unix_identity: drift },
    migrationPreviews: { unix_identity: migrationPreview },
  }).audit(websiteId);

  const preview = first.migration.changes.find((change) => change.id === 'provisioning.unix_identity')
    .current.identityMigrationPreview;
  assert.deepEqual(preview, {
    version: 1,
    satisfied: false,
    safeCreateCandidate: false,
    current: {
      account: { uid: 1201, gid: 1201, homeDirectory: '/srv/legacy', shell: '/bin/bash' },
      group: { gid: 1201, memberCount: 1 },
      home: { uid: 1201, gid: 1201, mode: '0755' },
    },
    desired: {
      user: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
      shellPolicy: 'nologin',
      privateGroup: true,
      groupMemberCount: 0,
      homeMode: '0750',
    },
    differences: migrationPreview.differences,
  });
  assert.deepEqual(first.inspectedSteps[0].identityMigrationPreview, preview);
  assert.equal(JSON.stringify(first.migration).includes('hidden-member'), false);
  assert.equal(JSON.stringify(first.migration).includes('do-not-project'), false);

  const second = await service({
    stepResults: { unix_identity: drift },
    migrationPreviews: {
      unix_identity: {
        ...migrationPreview,
        current: {
          ...migrationPreview.current,
          home: { ...migrationPreview.current.home, mode: '0700' },
        },
      },
    },
  }).audit(websiteId);
  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
});

test('isolation audit ignores Unix identity migration previews that target a non-canonical identity', async () => {
  const drift = Object.assign(new Error('drift'), { code: 'website_identity_drift' });
  const audit = await service({
    stepResults: { unix_identity: drift },
    migrationPreviews: {
      unix_identity: {
        version: 1,
        satisfied: false,
        safeCreateCandidate: true,
        current: { account: null, group: null, home: null },
        desired: {
          user: 'yunapp-aaaaaaaaaaaa',
          homeDirectory: identity.paths.workspace.homeDirectory,
          shellPolicy: 'nologin',
          privateGroup: true,
          groupMemberCount: 0,
          homeMode: '0750',
        },
        differences: ['website_identity_user_missing'],
      },
    },
  }).audit(websiteId);

  const change = audit.migration.changes.find((entry) => entry.id === 'provisioning.unix_identity');
  assert.equal(change.current.identityMigrationPreview, undefined);
  assert.equal(audit.inspectedSteps[0].identityMigrationPreview, undefined);
});

test('isolation audit pins bounded SFTP host and authorized-key drift into the migration digest', async () => {
  const chrootRoot = '/var/lib/yunpanel/sftp-chroots';
  const sftpPreview = {
    version: 1,
    satisfied: false,
    safeCreateCandidate: true,
    current: {
      receiptState: null,
      receiptError: null,
      sshdConfig: { present: false, sha256: null, matchesDesired: false },
      mountUnit: { present: false, sha256: null, matchesDesired: false, active: false },
      chrootRoot: { present: false },
      chrootDirectory: { present: false },
      mountDirectory: { present: false },
      sshdConfigValid: true,
    },
    desired: {
      websiteId,
      applicationId,
      unixUser: identity.unixUser,
      sourceDirectory: identity.paths.workspace.sftpRoot,
      chrootRoot,
      chrootDirectory: `${chrootRoot}/${applicationId}`,
      mountDirectory: `${chrootRoot}/${applicationId}/site`,
      sshdConfigPath: `/etc/ssh/sshd_config.d/90-yunpanel-sftp-${identity.unixUser}.conf`,
      unitName: 'yunpanel-test.mount',
      sshdSha256: 'b'.repeat(64),
      mountSha256: 'c'.repeat(64),
      directoryMode: '0755',
      directoryUid: 0,
      directoryGid: 0,
    },
    authorizedKeys: { satisfied: false, reason: 'sftp_authorized_keys_outdated' },
    differences: ['sftp_receipt_missing', 'sftp_sshd_config_missing', 'sftp_mount_unit_missing', 'sftp_mount_inactive'],
    rawSecret: 'do-not-project',
  };
  const first = await service({
    stepResults: {
      sftp: {
        satisfied: false,
        reason: 'sftp_key_reconcile_required',
        keyReason: 'sftp_authorized_keys_outdated',
      },
    },
    migrationPreviews: { sftp: sftpPreview },
  }).audit(websiteId);

  const preview = first.migration.changes.find((change) => change.id === 'provisioning.sftp')
    .current.sftpMigrationPreview;
  assert.equal(preview.current.receiptState, null);
  assert.equal(preview.current.sshdConfig.sha256, null);
  assert.equal(preview.current.mountUnit.active, false);
  assert.deepEqual(preview.authorizedKeys, {
    satisfied: false,
    reason: 'sftp_authorized_keys_outdated',
  });
  assert.equal(JSON.stringify(first.migration).includes('do-not-project'), false);
  assert.deepEqual(first.inspectedSteps.find((step) => step.stepId === 'sftp').sftpMigrationPreview, preview);

  const second = await service({
    stepResults: {
      sftp: {
        satisfied: false,
        reason: 'sftp_key_reconcile_required',
        keyReason: 'sftp_authorized_keys_outdated',
      },
    },
    migrationPreviews: {
      sftp: {
        ...sftpPreview,
        authorizedKeys: { satisfied: false, reason: 'sftp_authorized_keys_file_missing' },
      },
    },
  }).audit(websiteId);
  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
});


test('isolation audit pins bounded Passenger runtime drift into the migration digest', async () => {
  const passengerPreview = {
    version: 1,
    adapter: 'passenger',
    satisfied: false,
    current: {
      passenger: { healthy: true, installedVersion: '6.0.27-1~noble1' },
      identity: {
        satisfied: true,
        uid: 1201,
        gid: 1201,
        homeDirectory: identity.paths.workspace.homeDirectory,
        shell: '/usr/sbin/nologin',
        homeMode: '0750',
      },
      nodeCandidates: [
        {
          path: '/opt/yunpanel/node-runtimes/v24/bin/node',
          available: false,
          version: null,
          matchesRequestedMajor: false,
        },
        {
          path: '/usr/bin/node',
          available: true,
          version: 'v22.19.0',
          matchesRequestedMajor: false,
        },
      ],
      currentReleaseTarget: 'releases/f73cc6ac-07e8-4d22-b29a-741154687d20',
      currentReleaseTargetError: null,
      release: null,
    },
    runtimeUmask: { satisfied: false, reason: 'service_umask_not_effective' },
    desired: {
      applicationId,
      nodeMajor: 24,
      nodeCandidates: ['/opt/yunpanel/node-runtimes/v24/bin/node', '/usr/bin/node'],
      currentRoot: identity.paths.runtime.currentRelease,
      releasesDirectory: identity.paths.runtime.releasesDirectory,
      homeDirectory: identity.paths.workspace.homeDirectory,
      appRoot: identity.paths.runtime.currentRelease,
      documentRoot: identity.paths.runtime.currentRelease,
      startupFile: 'server.js',
      unixUser: identity.unixUser,
    },
    differences: ['passenger_node_unavailable', 'passenger_release_unavailable'],
    rawSecret: 'do-not-project',
  };
  const first = await service({
    runtimeType: 'node',
    stepResults: { runtime: { satisfied: false, reason: 'passenger_node_unavailable' } },
    migrationPreviews: { runtime: passengerPreview },
  }).audit(websiteId);

  const preview = first.migration.changes.find((change) => change.id === 'provisioning.runtime')
    .current.passengerMigrationPreview;
  assert.equal(preview.adapter, 'passenger');
  assert.equal(preview.current.passenger.healthy, true);
  assert.equal(preview.current.identity.homeMode, '0750');
  assert.equal(preview.current.nodeCandidates[1].version, 'v22.19.0');
  assert.equal(preview.current.release, null);
  assert.deepEqual(preview.current.runtimeUmask, {
    satisfied: false,
    reason: 'service_umask_not_effective',
  });
  assert.equal(preview.desired.applicationId, applicationId);
  assert.equal(JSON.stringify(first.migration).includes('do-not-project'), false);
  assert.deepEqual(first.inspectedSteps.find((step) => step.stepId === 'runtime').passengerMigrationPreview, preview);

  const second = await service({
    runtimeType: 'node',
    stepResults: { runtime: { satisfied: false, reason: 'passenger_runtime_unavailable' } },
    migrationPreviews: {
      runtime: {
        ...passengerPreview,
        current: {
          ...passengerPreview.current,
          passenger: { healthy: false, installedVersion: null },
        },
        differences: ['passenger_runtime_unavailable', ...passengerPreview.differences],
      },
    },
  }).audit(websiteId);
  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
});

test('isolation audit rejects Passenger preview paths that only share a string prefix with canonical roots', async () => {
  const audit = await service({
    runtimeType: 'node',
    stepResults: { runtime: { satisfied: false, reason: 'passenger_release_unavailable' } },
    migrationPreviews: {
      runtime: {
        version: 1,
        adapter: 'passenger',
        satisfied: false,
        current: {
          passenger: { healthy: true, installedVersion: '6.0.27-1~noble1' },
          identity: {
            satisfied: true,
            uid: 1201,
            gid: 1201,
            homeDirectory: identity.paths.workspace.homeDirectory,
            shell: '/usr/sbin/nologin',
            homeMode: '0750',
          },
          nodeCandidates: [{
            path: '/opt/yunpanel/node-runtimes/v24/bin/node',
            available: true,
            version: 'v24.11.1',
            matchesRequestedMajor: true,
          }],
          currentReleaseTarget: null,
          currentReleaseTargetError: 'passenger_release_unavailable',
          release: null,
        },
        desired: {
          applicationId,
          nodeMajor: 24,
          nodeCandidates: ['/opt/yunpanel/node-runtimes/v24/bin/node'],
          currentRoot: identity.paths.runtime.currentRelease,
          releasesDirectory: identity.paths.runtime.releasesDirectory,
          homeDirectory: identity.paths.workspace.homeDirectory,
          appRoot: `${identity.paths.runtime.currentRelease}-escape`,
          documentRoot: `${identity.paths.runtime.currentRelease}-escape/public`,
          startupFile: 'server.js',
          unixUser: identity.unixUser,
        },
        differences: ['passenger_release_unavailable'],
      },
    },
  }).audit(websiteId);

  const change = audit.migration.changes.find((entry) => entry.id === 'provisioning.runtime');
  assert.equal(change.current.passengerMigrationPreview, undefined);
  assert.equal(audit.inspectedSteps.find((step) => step.stepId === 'runtime').passengerMigrationPreview, undefined);
});


test('isolation audit pins bounded static release and publish isolation drift into the migration digest', async () => {
  const releaseId = operationId;
  const publishRoot = identity.paths.static.publishRoot;
  const staticPreview = {
    version: 1,
    adapter: 'static-runtime',
    satisfied: false,
    current: {
      runtime: {
        satisfied: false,
        reason: 'website_static_release_not_current',
        adapter: 'static',
        applicationId,
        releaseId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
        deploymentId: releaseId,
        currentRelease: `${publishRoot}/current`,
        unixUser: identity.unixUser,
        homeDirectory: identity.paths.workspace.homeDirectory,
      },
      isolation: {
        version: 1,
        adapter: 'static-publish-isolation',
        satisfied: false,
        current: {
          identity: {
            satisfied: true,
            uid: 1201,
            gid: 1201,
            homeDirectory: identity.paths.workspace.homeDirectory,
          },
          aclToolsAvailable: true,
          publishRoot: {
            present: true,
            directory: true,
            symbolicLink: false,
            uid: 0,
            gid: 0,
            mode: '0711',
          },
          releasesRoot: {
            present: true,
            directory: true,
            symbolicLink: false,
            uid: 0,
            gid: 0,
            mode: '0711',
          },
          releases: [{
            releaseId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
            satisfied: false,
            reason: 'static_publish_acl_drift',
          }],
          current: {
            present: true,
            symbolicLink: true,
            uid: 0,
            gid: 0,
            target: 'releases/f73cc6ac-07e8-4d22-b29a-741154687d20',
          },
        },
        desired: {
          websiteId,
          applicationId,
          unixUser: identity.unixUser,
          homeDirectory: identity.paths.workspace.homeDirectory,
          publishRoot,
          releasesRoot: `${publishRoot}/releases`,
          currentPath: `${publishRoot}/current`,
          controlDirectoryMode: '0711',
          releaseDirectoryMode: '0750',
          releaseFileMode: '0640',
          nginxDirectoryAcl: 'user:www-data:r-x',
          nginxFileAcl: 'user:www-data:r--',
          aclPackage: 'acl',
        },
        differences: ['static_publish_acl_drift'],
        rawSecret: 'do-not-project',
      },
    },
    desired: {
      websiteId,
      applicationId,
      mode: 'deploy',
      deploymentId: releaseId,
    },
    differences: ['website_static_release_not_current', 'static_publish_acl_drift'],
  };

  const first = await service({
    runtimeType: 'static',
    stepResults: { runtime: { satisfied: false, reason: 'website_static_release_not_current' } },
    migrationPreviews: { runtime: staticPreview },
  }).audit(websiteId);

  const preview = first.migration.changes.find((change) => change.id === 'provisioning.runtime')
    .current.staticRuntimeMigrationPreview;
  assert.equal(preview.adapter, 'static-runtime');
  assert.equal(preview.current.runtime.deploymentId, releaseId);
  assert.equal(preview.current.isolation.current.publishRoot.mode, '0711');
  assert.equal(preview.current.isolation.current.releases[0].reason, 'static_publish_acl_drift');
  assert.equal(preview.current.isolation.current.current.target, 'releases/f73cc6ac-07e8-4d22-b29a-741154687d20');
  assert.equal(JSON.stringify(first.migration).includes('do-not-project'), false);
  assert.equal(first.inspectedSteps.find((step) => step.stepId === 'runtime').passengerMigrationPreview, undefined);
  assert.deepEqual(
    first.inspectedSteps.find((step) => step.stepId === 'runtime').staticRuntimeMigrationPreview,
    preview,
  );

  const second = await service({
    runtimeType: 'static',
    stepResults: { runtime: { satisfied: false, reason: 'static_publish_current_drift' } },
    migrationPreviews: {
      runtime: {
        ...staticPreview,
        current: {
          ...staticPreview.current,
          isolation: {
            ...staticPreview.current.isolation,
            current: {
              ...staticPreview.current.isolation.current,
              current: {
                ...staticPreview.current.isolation.current.current,
                target: 'releases/3854e385-adfc-42bd-bccf-f655f24cd68f',
              },
            },
            differences: ['static_publish_current_drift'],
          },
        },
        differences: ['static_publish_current_drift'],
      },
    },
  }).audit(websiteId);
  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
});

test('isolation audit pins bounded PHP container, FPM and UMask drift into the migration digest', async () => {
  const releaseDirectory = `${identity.paths.runtime.releasesDirectory}/${operationId}`;
  const healthyDirectory = (uid, gid, mode) => ({
    present: true,
    directory: true,
    symbolicLink: false,
    uid,
    gid,
    mode,
  });
  const phpPreview = {
    version: 1,
    adapter: 'php-runtime',
    satisfied: false,
    current: {
      container: {
        version: 1,
        adapter: 'php-container',
        satisfied: false,
        current: {
          identity: {
            satisfied: true,
            uid: 1201,
            gid: 1201,
            homeDirectory: identity.paths.workspace.homeDirectory,
          },
          applicationRoot: healthyDirectory(1201, 1201, '0750'),
          releasesDirectory: healthyDirectory(1201, 1201, '0750'),
          releaseDirectory: healthyDirectory(1201, 1201, '0750'),
          releaseDocumentRoot: healthyDirectory(1201, 1201, '0750'),
          currentRelease: {
            present: true,
            directory: false,
            symbolicLink: true,
            uid: 1201,
            gid: 1201,
            mode: '0777',
          },
          currentTarget: releaseDirectory,
          currentTargetError: null,
        },
        desired: {
          websiteId,
          applicationId,
          releaseId: operationId,
          unixUser: identity.unixUser,
          documentRoot: `${identity.paths.runtime.currentRelease}/public`,
          applicationRoot: identity.paths.runtime.applicationRoot,
          releasesDirectory: identity.paths.runtime.releasesDirectory,
          currentRelease: identity.paths.runtime.currentRelease,
          releaseDirectory,
          releaseDocumentRoot: `${releaseDirectory}/public`,
          controlDirectoryMode: '0755',
          releaseDirectoryMode: '0750',
        },
        differences: ['php_site_container_control_plane_drift'],
      },
      fpm: {
        version: 1,
        adapter: 'php-fpm',
        satisfied: false,
        current: {
          identity: {
            satisfied: true,
            uid: 1201,
            gid: 1201,
            homeDirectory: identity.paths.workspace.homeDirectory,
            homeMode: '0750',
          },
          documentRoot: healthyDirectory(1201, 1201, '0750'),
          package: { installed: false, version: null },
          receipt: { state: null, mutated: null, previousConfigSha256: null, error: null },
          pool: { present: false, sha256: null, matchesDesired: false, readError: null },
          configValid: null,
          serviceActive: false,
          socket: { present: false },
        },
        desired: {
          websiteId,
          applicationId,
          unixUser: identity.unixUser,
          homeDirectory: identity.paths.workspace.homeDirectory,
          documentRoot: `${identity.paths.runtime.currentRelease}/public`,
          packageName: 'php8.3-fpm',
          phpVersion: '8.3',
          configPath: `/etc/php/8.3/fpm/pool.d/yunpanel-${identity.unixUser}.conf`,
          configSha256: 'd'.repeat(64),
          configMode: '0600',
          socketPath: `/run/php/yunpanel-${identity.unixUser}.sock`,
          socketMode: '0660',
          serviceUnit: 'php8.3-fpm.service',
        },
        differences: [
          'php_fpm_package_missing',
          'php_fpm_receipt_missing',
          'php_fpm_pool_missing',
          'php_fpm_service_inactive',
          'php_fpm_socket_missing',
        ],
      },
      umask: { satisfied: false, reason: 'service_umask_not_effective' },
    },
    desired: {
      websiteId,
      applicationId,
      unixUser: identity.unixUser,
      documentRoot: `${identity.paths.runtime.currentRelease}/public`,
      runtimeUmask: '0027',
    },
    differences: [
      'php_site_container_control_plane_drift',
      'php_fpm_package_missing',
      'php_fpm_receipt_missing',
      'php_fpm_pool_missing',
      'php_fpm_service_inactive',
      'php_fpm_socket_missing',
      'php_runtime_umask_not_ready',
    ],
    rawSecret: 'do-not-project',
  };

  const first = await service({
    runtimeType: 'php',
    stepResults: { php_runtime: { satisfied: false, reason: 'php_container_not_ready' } },
    migrationPreviews: { php_runtime: phpPreview },
  }).audit(websiteId);

  const preview = first.migration.changes.find((change) => change.id === 'provisioning.php_runtime')
    .current.phpRuntimeMigrationPreview;
  assert.equal(preview.adapter, 'php-runtime');
  assert.equal(preview.current.container.current.applicationRoot.uid, 1201);
  assert.equal(preview.current.fpm.current.pool.present, false);
  assert.equal(preview.current.fpm.current.receipt.state, null);
  assert.deepEqual(preview.current.umask, {
    satisfied: false,
    reason: 'service_umask_not_effective',
  });
  assert.equal(JSON.stringify(first.migration).includes('do-not-project'), false);
  assert.deepEqual(first.inspectedSteps.find((step) => step.stepId === 'php_runtime').phpRuntimeMigrationPreview, preview);

  const second = await service({
    runtimeType: 'php',
    stepResults: { php_runtime: { satisfied: false, reason: 'php_runtime_umask_not_ready' } },
    migrationPreviews: {
      php_runtime: {
        ...phpPreview,
        current: {
          ...phpPreview.current,
          umask: { satisfied: false, reason: 'service_umask_unavailable' },
        },
      },
    },
  }).audit(websiteId);
  assert.notEqual(first.migration.previewDigest, second.migration.previewDigest);
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
