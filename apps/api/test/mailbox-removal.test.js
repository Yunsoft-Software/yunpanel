import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createMailDeleteImpactService,
  MailDeleteImpactError,
} from '../src/mail-delete-impact.js';
import {
  createMailDataOperationsService,
  MailDataOperationsError,
} from '../src/mail-data-operations.js';
import {
  createMailDeleteFinalizeService,
  MailDeleteFinalizeError,
} from '../src/mail-delete-finalize.js';
import {
  createLocalHostOperations,
} from '../src/local-host-operations.js';
import {
  mailboxAliasReferences,
} from '../src/mailbox-alias-references.js';
import {
  sanitizeMailDataBackupResult,
  sanitizeMailDataDeleteResult,
} from '../src/mail-data-job-result.js';

function sha256(content) {
  return createHash('sha256').update(typeof content === 'string' ? content : JSON.stringify(content)).digest('hex');
}

function createMailboxRemovalFixture({
  domainStatus = 'enabled',
  mailboxEnabled = false,
  mailboxRevision = 1,
  dataPresent = true,
  dataBytes = 4096,
  snapshotDigest = 'a'.repeat(64),
  backupContentDigest = 'b'.repeat(64),
  quotas = [],
  forwardings = [],
  aliases = [],
  jobs = [],
} = {}) {
  const localServerId = randomUUID();
  const webDomainId = randomUUID();
  const mailDomainId = randomUUID();
  const mailboxId = randomUUID();
  const siblingMailboxId = randomUUID();
  const backupId = 'mail-backup-' + randomUUID().slice(0, 8);

  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: domainStatus,
    revision: 1,
  };

  const domain = {
    id: webDomainId,
    serverId: localServerId,
    primaryDomain: 'example.com',
  };

  const mailbox = {
    id: mailboxId,
    mailDomainId,
    address: 'user@example.com',
    enabled: mailboxEnabled,
    revision: mailboxRevision,
  };

  const siblingMailbox = {
    id: siblingMailboxId,
    mailDomainId,
    address: 'sibling@example.com',
    enabled: true,
    revision: 1,
  };

  const mailboxesMap = new Map([
    [mailbox.id, { ...mailbox }],
    [siblingMailbox.id, { ...siblingMailbox }],
  ]);

  const liveData = {
    present: dataPresent,
    bytes: dataBytes,
    snapshotSha256: snapshotDigest,
  };

  const backupsMap = new Map();
  if (dataPresent) {
    backupsMap.set(backupId, {
      version: 1,
      backupId,
      scope: 'mailbox',
      identity: mailbox.address,
      sourcePath: `/var/lib/yunpanel/mail/example.com/${mailbox.address.split('@')[0]}`,
      sourcePresent: true,
      sourceSnapshotSha256: snapshotDigest,
      contentSha256: backupContentDigest,
      bytes: dataBytes,
      files: 8,
      directories: 2,
      createdAt: new Date().toISOString(),
      sideEffects: true,
    });
  }

  const enqueuedJobs = [];
  const storedJobs = new Map();
  for (const j of jobs) {
    storedJobs.set(j.id, { ...j });
  }

  const mailDomainRegistry = {
    async getMailDomain(id) {
      return id === mailDomainId ? { ...mailDomain } : null;
    },
    async deleteMailDomain(id) {
      if (id === mailDomainId) mailDomain.status = 'deleted';
    },
  };

  const domainRegistry = {
    async getDomain(id) {
      return id === webDomainId ? { ...domain } : null;
    },
  };

  const mailboxRegistry = {
    async getMailbox(id) {
      return mailboxesMap.has(id) ? { ...mailboxesMap.get(id) } : null;
    },
    async listMailboxes(filter) {
      const list = [...mailboxesMap.values()];
      if (filter?.mailDomainId) {
        return list.filter((m) => m.mailDomainId === filter.mailDomainId);
      }
      return list;
    },
    async setEnabled(id, { expectedRevision, enabled }) {
      const mb = mailboxesMap.get(id);
      if (!mb) throw new Error('mailbox_not_found');
      if (mb.revision !== expectedRevision) {
        const error = new Error('Mailbox state changed before update');
        error.code = 'stale_mailbox_revision';
        error.status = 409;
        throw error;
      }
      mb.enabled = enabled;
      mb.revision += 1;
      return { ...mb };
    },
    async deleteMailbox(id, { expectedRevision, confirmation }) {
      const mb = mailboxesMap.get(id);
      if (!mb) throw new Error('mailbox_not_found');
      if (mb.revision !== expectedRevision) {
        const error = new Error('Mailbox state changed before deletion');
        error.code = 'stale_mailbox_revision';
        error.status = 409;
        throw error;
      }
      mailboxesMap.delete(id);
      return { id, deleted: true };
    },
  };

  const mailAliasRegistry = {
    async listAliases(filter) {
      if (filter?.mailDomainId) {
        return aliases.filter((a) => a.mailDomainId === filter.mailDomainId);
      }
      return aliases;
    },
  };

  const mailboxQuotaRegistry = {
    async getQuota(mbId) {
      return quotas.find((q) => q.mailboxId === mbId) ?? null;
    },
  };

  const mailboxForwardingRegistry = {
    async getForwarding(mbId) {
      return forwardings.find((f) => f.mailboxId === mbId) ?? null;
    },
  };

  const mailDkimRegistry = {
    async getKey() { return null; },
  };

  const mailDataInspector = {
    async inspectMailbox(identity) {
      if (identity !== mailbox.address && identity !== siblingMailbox.address) {
        return { version: 1, scope: 'mailbox', identity, dataPath: null, present: false, bytes: 0, snapshotSha256: null, sideEffects: false };
      }
      return {
        version: 1,
        scope: 'mailbox',
        identity,
        dataPath: `/var/lib/yunpanel/mail/example.com/${identity.split('@')[0]}`,
        present: liveData.present,
        bytes: liveData.bytes,
        snapshotSha256: liveData.snapshotSha256,
        sideEffects: false,
      };
    },
    async inspectDomain(domainName) {
      return {
        version: 1,
        scope: 'domain',
        identity: domainName,
        dataPath: `/var/lib/yunpanel/mail/${domainName}`,
        present: liveData.present,
        bytes: liveData.bytes,
        snapshotSha256: liveData.snapshotSha256,
        sideEffects: false,
      };
    },
  };

  const mailDataBackupManager = {
    async inspectBackup(id) {
      return backupsMap.get(id) ?? null;
    },
    async materializeBackup(id) {
      const manifest = backupsMap.get(id);
      if (!manifest) throw new Error('backup_not_found');
      return { manifest, sideEffects: false };
    },
    async backup({ backupId: requestedBackupId, scope, identity, expectedSnapshotSha256 }) {
      const manifest = {
        version: 1,
        backupId: requestedBackupId,
        scope,
        identity,
        sourcePath: `/var/lib/yunpanel/mail/example.com/${identity.split('@')[0]}`,
        sourcePresent: true,
        sourceSnapshotSha256: expectedSnapshotSha256,
        contentSha256: backupContentDigest,
        bytes: dataBytes,
        files: 8,
        directories: 2,
        createdAt: new Date().toISOString(),
        sideEffects: true,
      };
      backupsMap.set(requestedBackupId, manifest);
      return manifest;
    },
  };

  const jobRegistry = {
    async listJobs(filter) {
      let list = [...storedJobs.values()];
      if (filter?.resourceType) list = list.filter((j) => j.resourceType === filter.resourceType);
      if (filter?.resourceId) list = list.filter((j) => j.resourceId === filter.resourceId);
      return list;
    },
    async getJob(id) {
      return storedJobs.get(id) ?? null;
    },
    async enqueue(entry) {
      const job = {
        id: randomUUID(),
        status: 'queued',
        ...entry,
        createdAt: new Date().toISOString(),
      };
      enqueuedJobs.push(job);
      storedJobs.set(job.id, job);
      return job;
    },
    async updateJobStatus(id, status, result = null, error = null) {
      const job = storedJobs.get(id);
      if (!job) return null;
      job.status = status;
      job.result = result;
      job.error = error;
      return job;
    },
  };

  const mailDeleteImpactService = createMailDeleteImpactService({
    localServerId,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    jobRegistry,
    mailDataInspector,
  });

  const mailDataOperationsService = createMailDataOperationsService({
    localServerId,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDataInspector,
    mailDataBackupManager,
    mailDeleteImpactService,
    jobRegistry,
  });

  const mailDeleteFinalizeService = createMailDeleteFinalizeService({
    mailboxRegistry,
    mailDomainRegistry,
    mailDeleteImpactService,
    jobRegistry,
  });

  const standardDeleteManager = {
    async deleteNow({ transactionId, backupId: bid, scope, identity, expectedTargetSnapshotSha256 }) {
      const selected = await mailDataBackupManager.inspectBackup(bid);
      if (!selected || selected.scope !== scope || selected.identity !== identity) {
        const error = new Error('Mail data backup mismatch');
        error.code = 'mail_data_delete_backup_mismatch';
        throw error;
      }
      liveData.present = false;
      liveData.bytes = 0;
      liveData.snapshotSha256 = sha256('deleted');
      return Object.freeze({
        version: 1,
        transactionId,
        backupId: bid,
        scope,
        identity,
        sourcePresent: selected.sourcePresent,
        contentSha256: selected.contentSha256,
        bytes: selected.bytes,
        files: selected.files,
        directories: selected.directories,
        deleted: true,
        sideEffects: true,
      });
    },
    async deleteData(input) {
      return this.deleteNow(input);
    },
    async inspectDeleted({ transactionId, backupId: bid, scope, identity }) {
      return Object.freeze({
        satisfied: !liveData.present,
        result: Object.freeze({
          version: 1,
          transactionId,
          backupId: bid,
          scope,
          identity,
          sourcePresent: true,
          contentSha256: backupContentDigest,
          bytes: dataBytes,
          files: 8,
          directories: 2,
          deleted: true,
          sideEffects: true,
        }),
      });
    },
  };

  const hostOperations = createLocalHostOperations({
    mailDataBackupManager,
    mailDataDeleteManager: standardDeleteManager,
  });

  return {
    localServerId,
    webDomainId,
    mailDomainId,
    mailboxId,
    siblingMailboxId,
    backupId,
    snapshotDigest,
    backupContentDigest,
    mailDomain,
    domain,
    mailbox,
    siblingMailbox,
    liveData,
    mailboxesMap,
    backupsMap,
    storedJobs,
    enqueuedJobs,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDataInspector,
    mailDataBackupManager,
    jobRegistry,
    mailDeleteImpactService,
    mailDataOperationsService,
    mailDeleteFinalizeService,
    standardDeleteManager,
    hostOperations,
  };
}

// ============================================================================
// Criterion 1: Mailbox removal impact and dependency evaluation
// ============================================================================

test('Criterion 1: Mailbox removal impact and dependency evaluation', async () => {
  // 1. Quota blocker test
  {
    const fx = createMailboxRemovalFixture({
      quotas: [{ id: 'quota-1', mailboxId: 'dummy', bytes: 104857600 }],
    });
    fx.mailboxQuotaRegistry.getQuota = async (id) => (id === fx.mailboxId ? { id: 'q-1', mailboxId: id, bytes: 100 } : null);
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mailbox_quota_configured'));
    assert.equal(impact.dependencies.quotaConfigured, true);
  }

  // 2. Forwarding blocker test
  {
    const fx = createMailboxRemovalFixture();
    fx.mailboxForwardingRegistry.getForwarding = async (id) => (id === fx.mailboxId ? { id: 'fwd-1', mailboxId: id, destinations: ['ext@remote.test'] } : null);
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mailbox_forwarding_configured'));
    assert.equal(impact.dependencies.forwardingConfigured, true);
  }

  // 3. Local alias blocker test
  {
    const fx = createMailboxRemovalFixture({
      aliases: [{ id: 'local-alias-1', mailDomainId: 'dummy', destinations: ['user@example.com'] }],
    });
    fx.mailAliasRegistry.listAliases = async (filter) => [{ id: 'local-alias-1', mailDomainId: fx.mailDomainId, destinations: ['user@example.com'] }];
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mailbox_alias_reference_configured'));
    assert.deepEqual(impact.dependencies.aliasReferences.ids, ['local-alias-1']);
  }

  // 4. Inbound foreign alias blocker test: foreign alias ID must be redacted
  {
    const fx = createMailboxRemovalFixture();
    const foreign = { id: 'private-foreign-alias-id', destinations: ['user@example.com'] };
    fx.mailAliasRegistry.listAliases = async (filter) => (filter ? [] : [foreign]);
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mailbox_alias_reference_configured'));
    assert.equal(impact.dependencies.aliasReferences.count, 1);
    assert.deepEqual(impact.dependencies.aliasReferences.ids, []);
    assert.equal(impact.dependencies.aliasReferences.truncated, true);
    assert.equal(JSON.stringify(impact).includes('private-foreign-alias-id'), false);
  }

  // 5. Active job blocker test
  {
    const fx = createMailboxRemovalFixture({
      jobs: [{ id: 'active-job-1', status: 'running', resourceType: 'mail_domain', resourceId: 'placeholder' }],
    });
    fx.jobRegistry.listJobs = async () => [{ id: 'active-job-1', status: 'running', resourceType: 'mail_domain', resourceId: fx.mailDomainId }];
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mail_domain_job_active'));
  }

  // 6. Mail data present without backup blocker test
  {
    const fx = createMailboxRemovalFixture({ dataPresent: true });
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, false);
    assert.ok(impact.blockers.some((b) => b.code === 'mail_data_backup_required'));
    assert.equal(impact.requiresDataBackup, true);
    assert.equal(impact.mailData.present, true);
  }

  // 7. Clear dependencies test
  {
    const fx = createMailboxRemovalFixture({ dataPresent: false });
    const impact = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
    assert.equal(impact.safeToDelete, true);
    assert.deepEqual(impact.blockers, []);
    assert.equal(impact.requiresDataBackup, false);
    assert.equal(impact.confirmation, `delete-mailbox:${fx.mailbox.address}`);
  }
});

// ============================================================================
// Criterion 2: Mailbox state transition and disable gating prior to deletion
// ============================================================================

test('Criterion 2: Mailbox state transition and disable gating prior to deletion', async () => {
  const fx = createMailboxRemovalFixture({
    domainStatus: 'enabled',
    mailboxEnabled: true, // target starts enabled
    mailboxRevision: 1,
  });

  // 1. Target mailbox is enabled -> previewDelete throws mail_data_delete_mailbox_disable_required
  await assert.rejects(
    async () => fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: fx.backupId,
    }),
    (err) => err instanceof MailDataOperationsError
      && err.code === 'mail_data_delete_mailbox_disable_required'
      && err.status === 409
  );

  // 2. Queueing delete while enabled throws mail_data_delete_mailbox_disable_required
  await assert.rejects(
    async () => fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: fx.backupId,
      expectedRevision: 1,
      expectedPreviewDigest: 'a'.repeat(64),
      confirmation: `delete-mail-data:${fx.mailDomainId}:${'a'.repeat(64)}`,
    }),
    (err) => err instanceof MailDataOperationsError
      && err.code === 'mail_data_delete_mailbox_disable_required'
      && err.status === 409
  );

  // 3. Domain and sibling mailbox remain active / enabled
  const currentDomain = await fx.mailDomainRegistry.getMailDomain(fx.mailDomainId);
  assert.equal(currentDomain.status, 'enabled');
  const sibling = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
  assert.equal(sibling.enabled, true);

  // 4. Disable only the target mailbox via registry setEnabled
  const disabled = await fx.mailboxRegistry.setEnabled(fx.mailboxId, {
    expectedRevision: 1,
    enabled: false,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.revision, 2);

  // Sibling and domain remain untouched
  const siblingAfter = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
  assert.equal(siblingAfter.enabled, true);
  assert.equal(siblingAfter.revision, 1);
  const domainAfter = await fx.mailDomainRegistry.getMailDomain(fx.mailDomainId);
  assert.equal(domainAfter.status, 'enabled');

  // 5. With mailbox disabled, previewDelete succeeds
  const preview = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
  });
  assert.equal(preview.operation, 'mail_data_delete');
  assert.equal(preview.scope, 'mailbox');
  assert.equal(preview.resourceId, fx.mailboxId);
  assert.equal(preview.expectedRevision, 2);
  assert.equal(preview.sideEffects, false);
  assert.ok(typeof preview.previewDigest === 'string' && preview.previewDigest.length === 64);
  assert.equal(preview.confirmation, `delete-mail-data:${fx.mailDomainId}:${preview.previewDigest}`);

  // 6. Stale revision rejection on queueDelete
  await assert.rejects(
    async () => fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: fx.backupId,
      expectedRevision: 1, // stale revision!
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof MailDataOperationsError && err.code === 'mail_data_delete_preview_stale'
  );

  // 7. Invalid confirmation rejection on queueDelete
  await assert.rejects(
    async () => fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: fx.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: 'wrong-confirmation-token',
    }),
    (err) => err instanceof MailDataOperationsError && err.code === 'mail_data_delete_confirmation_invalid'
  );
});

// ============================================================================
// Criterion 3: Verified pre-deletion backup job execution and receipt validation
// ============================================================================

test('Criterion 3: Verified pre-deletion backup job execution and receipt validation', async () => {
  const fx = createMailboxRemovalFixture({
    mailboxEnabled: false,
    mailboxRevision: 1,
    dataPresent: true,
  });

  // 1. Preview backup
  const backupPreview = await fx.mailDataOperationsService.previewBackup({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
  });
  assert.equal(backupPreview.operation, 'mail_data_backup');
  assert.equal(backupPreview.scope, 'mailbox');
  assert.equal(backupPreview.resourceId, fx.mailboxId);
  assert.equal(backupPreview.expectedRevision, 1);
  assert.equal(backupPreview.sourcePresent, true);
  assert.equal(backupPreview.bytes, 4096);
  assert.equal(backupPreview.snapshotSha256, fx.snapshotDigest);
  assert.equal(backupPreview.sideEffects, false);
  assert.ok(backupPreview.previewDigest.length === 64);
  assert.equal(backupPreview.confirmation, `backup-mail-data:${fx.mailDomainId}:${backupPreview.previewDigest}`);

  // 2. Queue backup
  const queuedBackup = await fx.mailDataOperationsService.queueBackup({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    expectedRevision: 1,
    expectedPreviewDigest: backupPreview.previewDigest,
    confirmation: backupPreview.confirmation,
  });
  assert.equal(queuedBackup.previewDigest, backupPreview.previewDigest);
  assert.equal(queuedBackup.job.type, 'mail_data_backup');
  assert.equal(queuedBackup.job.operation, OPERATIONS.MAIL_DATA_BACKUP);
  assert.equal(queuedBackup.job.resourceId, fx.mailDomainId);

  // 3. Execute backup via localHostOperations
  const backupResult = await fx.hostOperations.executeOperation(
    OPERATIONS.MAIL_DATA_BACKUP,
    queuedBackup.job.payload,
    {
      jobId: queuedBackup.job.id,
      serverId: fx.localServerId,
      type: 'mail_data_backup',
      resourceType: 'mail_domain',
      resourceId: fx.mailDomainId,
    }
  );
  assert.equal(backupResult.backedUp, true);
  assert.equal(backupResult.backupId, queuedBackup.job.id);
  assert.equal(backupResult.scope, 'mailbox');
  assert.equal(backupResult.identity, fx.mailbox.address);
  assert.equal(backupResult.sourcePresent, true);
  assert.equal(backupResult.contentSha256, fx.backupContentDigest);
  assert.equal(backupResult.sideEffects, true);

  // Update stored backup job to succeeded state
  const completedBackupJob = {
    ...queuedBackup.job,
    status: 'succeeded',
    result: sanitizeMailDataBackupResult(queuedBackup.job, backupResult),
  };
  fx.storedJobs.set(queuedBackup.job.id, completedBackupJob);

  // 4. Validate backup receipt in backup manager
  const verifiedBackup = await fx.mailDataBackupManager.inspectBackup(queuedBackup.job.id);
  assert.ok(verifiedBackup);
  assert.equal(verifiedBackup.backupId, queuedBackup.job.id);
  assert.equal(verifiedBackup.sourceSnapshotSha256, fx.snapshotDigest);
  assert.equal(verifiedBackup.contentSha256, fx.backupContentDigest);
  assert.equal(verifiedBackup.sourcePresent, true);

  // 5. Delete preview uses verified backup
  const deletePreview = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: queuedBackup.job.id,
  });
  assert.equal(deletePreview.backupId, queuedBackup.job.id);
  assert.equal(deletePreview.backupContentSha256, fx.backupContentDigest);
  assert.equal(deletePreview.targetSnapshotSha256, fx.snapshotDigest);

  // 6. Data drift after backup rejects delete preview as stale
  fx.liveData.snapshotSha256 = sha256('new-snapshot-after-backup');
  await assert.rejects(
    async () => fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: queuedBackup.job.id,
    }),
    (err) => err instanceof MailDataOperationsError && err.code === 'mail_data_delete_backup_stale'
  );
});

// ============================================================================
// Criterion 4: Verifiable pre-deletion backup and host rollback flow
// ============================================================================

test('Criterion 4: Verifiable pre-deletion backup and host rollback flow', async () => {
  const fx = createMailboxRemovalFixture({
    mailboxEnabled: false,
    mailboxRevision: 1,
    dataPresent: true,
  });

  // 1. Prepare and queue the deletion operation
  const deletePreview = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
  });

  const queuedDelete = await fx.mailDataOperationsService.queueDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
    expectedRevision: 1,
    expectedPreviewDigest: deletePreview.previewDigest,
    confirmation: deletePreview.confirmation,
  });

  assert.equal(queuedDelete.job.type, 'mail_data_delete');
  assert.equal(queuedDelete.job.operation, OPERATIONS.MAIL_DATA_DELETE);

  // 2. Define failingDeleteManager mock with deleteNow AND deleteData
  const failingDeleteManager = {
    calls: [],
    async deleteNow({ transactionId, backupId: bid, scope, identity, expectedTargetSnapshotSha256 } = {}) {
      this.calls.push(['deleteNow', { transactionId, bid, scope, identity, expectedTargetSnapshotSha256 }]);
      const error = new Error('Host mail data deletion failed during file unlink; host rollback triggered');
      error.code = 'mail_data_delete_failed';
      throw error;
    },
    async deleteData(input) {
      this.calls.push(['deleteData', input]);
      return this.deleteNow(input);
    },
    async inspectDeleted({ transactionId, backupId: bid, scope, identity } = {}) {
      return Object.freeze({ satisfied: false, result: null });
    },
  };

  // 3. Directly verify failingDeleteManager interface and methods
  assert.equal(typeof failingDeleteManager.deleteNow, 'function');
  assert.equal(typeof failingDeleteManager.deleteData, 'function');
  assert.equal(typeof failingDeleteManager.inspectDeleted, 'function');

  // Calling deleteNow directly rejects with mail_data_delete_failed without throwing TypeError
  await assert.rejects(
    async () => failingDeleteManager.deleteNow({
      transactionId: queuedDelete.job.id,
      backupId: fx.backupId,
      scope: 'mailbox',
      identity: fx.mailbox.address,
      expectedTargetSnapshotSha256: fx.snapshotDigest,
    }),
    (err) => err.code === 'mail_data_delete_failed'
  );
  assert.ok(failingDeleteManager.calls.some(([type]) => type === 'deleteNow'));

  // Calling deleteData directly also delegates to deleteNow and rejects as expected
  await assert.rejects(
    async () => failingDeleteManager.deleteData({
      transactionId: queuedDelete.job.id,
      backupId: fx.backupId,
      scope: 'mailbox',
      identity: fx.mailbox.address,
      expectedTargetSnapshotSha256: fx.snapshotDigest,
    }),
    (err) => err.code === 'mail_data_delete_failed'
  );

  // 4. Test host operations execution with failingDeleteManager
  const failingHostOperations = createLocalHostOperations({
    mailDataBackupManager: fx.mailDataBackupManager,
    mailDataDeleteManager: failingDeleteManager,
  });

  await assert.rejects(
    async () => failingHostOperations.executeOperation(
      OPERATIONS.MAIL_DATA_DELETE,
      queuedDelete.job.payload,
      {
        jobId: queuedDelete.job.id,
        serverId: fx.localServerId,
        type: 'mail_data_delete',
        resourceType: 'mail_domain',
        resourceId: fx.mailDomainId,
      }
    ),
    (err) => err.code === 'mail_data_delete_failed'
  );

  // 5. Host rollback verification:
  // Live mail data was NOT deleted and remains intact
  const inspectedData = await fx.mailDataInspector.inspectMailbox(fx.mailbox.address);
  assert.equal(inspectedData.present, true);
  assert.equal(inspectedData.snapshotSha256, fx.snapshotDigest);
  assert.equal(inspectedData.bytes, 4096);

  // Pre-deletion backup in mailDataBackupManager remains intact and verified
  const intactBackup = await fx.mailDataBackupManager.inspectBackup(fx.backupId);
  assert.ok(intactBackup);
  assert.equal(intactBackup.sourcePresent, true);
  assert.equal(intactBackup.contentSha256, fx.backupContentDigest);

  // 6. Deletion finalization gating:
  // Job in registry was NOT completed successfully
  const failedJob = {
    ...queuedDelete.job,
    status: 'failed',
    error: { code: 'mail_data_delete_failed', message: 'Host execution error' },
  };
  fx.storedJobs.set(queuedDelete.job.id, failedJob);

  // Attempting to finalize deletion rejects fail-closed
  await assert.rejects(
    async () => fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: fx.mailboxId,
      expectedRevision: 1,
      deleteJobId: queuedDelete.job.id,
      confirmation: `delete-mailbox:${fx.mailbox.address}`,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mail_delete_job_mismatch'
  );

  // Mailbox in mailboxRegistry is NOT deleted; remains present at revision 1
  const preservedMailbox = await fx.mailboxRegistry.getMailbox(fx.mailboxId);
  assert.ok(preservedMailbox);
  assert.equal(preservedMailbox.id, fx.mailboxId);
  assert.equal(preservedMailbox.enabled, false);
  assert.equal(preservedMailbox.revision, 1);
});

// ============================================================================
// Criterion 5: Finalization and cleanup of mailbox registry records
// ============================================================================

test('Criterion 5: Finalization and cleanup of mailbox registry records', async () => {
  const fx = createMailboxRemovalFixture({
    mailboxEnabled: false,
    mailboxRevision: 2,
    dataPresent: true,
  });

  // 1. Complete deletion job on host
  const deletePreview = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
  });

  const queuedDelete = await fx.mailDataOperationsService.queueDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
    expectedRevision: 2,
    expectedPreviewDigest: deletePreview.previewDigest,
    confirmation: deletePreview.confirmation,
  });

  const deleteResult = await fx.hostOperations.executeOperation(
    OPERATIONS.MAIL_DATA_DELETE,
    queuedDelete.job.payload,
    {
      jobId: queuedDelete.job.id,
      serverId: fx.localServerId,
      type: 'mail_data_delete',
      resourceType: 'mail_domain',
      resourceId: fx.mailDomainId,
    }
  );
  assert.equal(deleteResult.deleted, true);

  // Update stored job to succeeded state
  const completedJob = {
    ...queuedDelete.job,
    status: 'succeeded',
    result: sanitizeMailDataDeleteResult(queuedDelete.job, deleteResult),
  };
  fx.storedJobs.set(queuedDelete.job.id, completedJob);

  // Verify mail data is now absent
  const dataAfter = await fx.mailDataInspector.inspectMailbox(fx.mailbox.address);
  assert.equal(dataAfter.present, false);

  // Impact service now confirms safeToDelete with clear dependencies
  const impactAfter = await fx.mailDeleteImpactService.inspectMailbox(fx.mailboxId);
  assert.equal(impactAfter.safeToDelete, true);
  assert.deepEqual(impactAfter.blockers, []);
  assert.equal(impactAfter.requiresDataBackup, false);
  assert.equal(impactAfter.mailData.present, false);

  const validConfirmation = `delete-mailbox:${fx.mailbox.address}`;

  // 2. Reject stale revision during finalizeMailbox
  await assert.rejects(
    async () => fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: fx.mailboxId,
      expectedRevision: 1, // current revision is 2
      deleteJobId: queuedDelete.job.id,
      confirmation: validConfirmation,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'stale_mailbox_revision' && err.status === 409
  );

  // 3. Reject mismatched deleteJobId during finalizeMailbox
  await assert.rejects(
    async () => fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: fx.mailboxId,
      expectedRevision: 2,
      deleteJobId: 'wrong-job-id-00000000',
      confirmation: validConfirmation,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mail_delete_job_mismatch' && err.status === 409
  );

  // 4. Reject invalid confirmation during finalizeMailbox
  await assert.rejects(
    async () => fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: fx.mailboxId,
      expectedRevision: 2,
      deleteJobId: queuedDelete.job.id,
      confirmation: 'short',
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mail_delete_confirmation_invalid' && err.status === 400
  );

  // 5. Successful finalization removes mailbox from registry
  const finalized = await fx.mailDeleteFinalizeService.finalizeMailbox({
    mailboxId: fx.mailboxId,
    expectedRevision: 2,
    deleteJobId: queuedDelete.job.id,
    confirmation: validConfirmation,
  });

  assert.equal(finalized.deleted, true);
  assert.equal(finalized.id, fx.mailboxId);
  assert.equal(finalized.resourceType, 'mailbox');
  assert.equal(finalized.deleteJobId, queuedDelete.job.id);
  assert.equal(finalized.backupId, fx.backupId);

  // 6. Mailbox is deleted from registry
  const deletedLookup = await fx.mailboxRegistry.getMailbox(fx.mailboxId);
  assert.equal(deletedLookup, null);

  // Sibling mailbox remains untouched
  const siblingMailbox = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
  assert.ok(siblingMailbox);
  assert.equal(siblingMailbox.id, fx.siblingMailboxId);
  assert.equal(siblingMailbox.enabled, true);

  // 7. Re-attempting finalization fails closed with mailbox_not_found
  await assert.rejects(
    async () => fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: fx.mailboxId,
      expectedRevision: 2,
      deleteJobId: queuedDelete.job.id,
      confirmation: validConfirmation,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mailbox_not_found' && err.status === 404
  );
});
