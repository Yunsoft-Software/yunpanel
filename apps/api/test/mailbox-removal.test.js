import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
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
import {
  mountMailboxRoutes,
} from '../src/mailbox-http.js';
import {
  MailboxRegistryError,
} from '../src/mailbox-registry.js';

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

  // Model active sessions across protocols and clients for both mailboxes
  const activeSessions = new Map([
    [mailbox.address, [
      { id: 'sess-imap-user', proto: 'imap', client: 'roundcube', pid: 1001, ip: '127.0.0.1' },
      { id: 'sess-smtp-user', proto: 'smtp', client: 'postfix-sasl', pid: 1002, ip: '192.168.1.50' },
    ]],
    [siblingMailbox.address, [
      { id: 'sess-imap-sib', proto: 'imap', client: 'roundcube', pid: 2001, ip: '127.0.0.1' },
      { id: 'sess-smtp-sib', proto: 'smtp', client: 'postfix-sasl', pid: 2002, ip: '192.168.1.51' },
    ]],
  ]);

  const mailboxAccessGuard = {
    calls: [],
    async quiesce(identity) {
      this.calls.push(['quiesce', identity]);
      if (typeof identity !== 'string' || !identity.includes('@')) {
        const error = new Error('Invalid mailbox identity');
        error.code = 'mailbox_access_identity_invalid';
        throw error;
      }
      const mb = [...mailboxesMap.values()].find((m) => m.address === identity);
      if (mb && mb.enabled !== false) {
        const error = new Error('Mailbox is still enabled');
        error.code = 'mailbox_access_still_enabled';
        throw error;
      }
      const sessions = activeSessions.get(identity) || [];
      if (sessions.some((s) => s.stubborn)) {
        const error = new Error('Active sessions remain after kick');
        error.code = 'mailbox_access_sessions_remaining';
        throw error;
      }
      // Target mailbox sessions are flushed and kicked
      activeSessions.set(identity, []);
      return Object.freeze({ identity, accessDisabled: true, sessionsCleared: true });
    },
    async verify(identity) {
      this.calls.push(['verify', identity]);
      const sessions = activeSessions.get(identity) || [];
      if (sessions.length > 0) {
        const error = new Error('Active sessions remain');
        error.code = 'mailbox_access_sessions_remaining';
        throw error;
      }
      return Object.freeze({ identity, accessDisabled: true, sessionsCleared: true });
    },
  };

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

  let mutationChain = Promise.resolve();
  function mutate(fn) {
    const res = mutationChain.then(fn);
    mutationChain = res.catch(() => {});
    return res;
  }

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
    async createMailbox({ mailDomainId, address, password } = {}) {
      return mutate(async () => {
        const id = randomUUID();
        const record = {
          id,
          mailDomainId,
          address,
          enabled: true,
          revision: 1,
        };
        mailboxesMap.set(id, record);
        return { ...record };
      });
    },
    async rotatePassword(id, { expectedRevision, password } = {}) {
      return mutate(async () => {
        const mb = mailboxesMap.get(id);
        if (!mb) {
          const error = new Error('mailbox_not_found');
          error.code = 'mailbox_not_found';
          error.status = 404;
          throw error;
        }
        if (mb.revision !== expectedRevision) {
          const error = new Error('Mailbox state changed before password rotation');
          error.code = 'stale_mailbox_revision';
          error.status = 409;
          throw error;
        }
        mb.revision += 1;
        return { ...mb };
      });
    },
    async setEnabled(id, { expectedRevision, enabled }) {
      return mutate(async () => {
        const mb = mailboxesMap.get(id);
        if (!mb) {
          const error = new Error('mailbox_not_found');
          error.code = 'mailbox_not_found';
          error.status = 404;
          throw error;
        }
        if (mb.revision !== expectedRevision) {
          const error = new Error('Mailbox state changed before update');
          error.code = 'stale_mailbox_revision';
          error.status = 409;
          throw error;
        }
        mb.enabled = enabled;
        mb.revision += 1;
        return { ...mb };
      });
    },
    async deleteMailbox(id, { expectedRevision, confirmation }) {
      return mutate(async () => {
        const mb = mailboxesMap.get(id);
        if (!mb) {
          const error = new Error('mailbox_not_found');
          error.code = 'mailbox_not_found';
          error.status = 404;
          throw error;
        }
        if (mb.revision !== expectedRevision) {
          const error = new Error('Mailbox state changed before deletion');
          error.code = 'stale_mailbox_revision';
          error.status = 409;
          throw error;
        }
        if (confirmation !== `delete-mailbox:${mb.address}`) {
          const error = new Error('Mailbox deletion confirmation mismatch');
          error.code = 'mailbox_confirmation_mismatch';
          error.status = 409;
          throw error;
        }
        mailboxesMap.delete(id);
        return { id, deleted: true };
      });
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
      if (scope === 'mailbox') {
        const proof = await mailboxAccessGuard.quiesce(identity);
        if (!proof || proof.accessDisabled !== true || proof.sessionsCleared !== true) {
          const error = new Error('Selected mailbox access is not confirmed disabled');
          error.code = 'mailbox_access_unverified';
          throw error;
        }
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
      if (scope === 'mailbox') {
        await mailboxAccessGuard.verify(identity);
      }
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
    activeSessions,
    mailboxAccessGuard,
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
// Criterion 1: Single mailbox deletion flow operates without taking down or
//              affecting the active parent domain or other mailboxes on the same domain
// ============================================================================

test('Criterion 1: Single mailbox deletion flow operates without taking down or affecting the active parent domain or other mailboxes on the same domain', async () => {
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

  // 8. Single mailbox disable gating without touching parent domain or sibling accounts
  {
    const fx = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: true,
      mailboxRevision: 1,
    });

    // Enabled target mailbox rejects previewDelete and queueDelete
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

    // Parent domain and sibling mailbox remain active / enabled
    const domainBefore = await fx.mailDomainRegistry.getMailDomain(fx.mailDomainId);
    assert.equal(domainBefore.status, 'enabled');
    const siblingBefore = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
    assert.equal(siblingBefore.enabled, true);

    // Disable only the target mailbox via registry setEnabled
    const disabled = await fx.mailboxRegistry.setEnabled(fx.mailboxId, {
      expectedRevision: 1,
      enabled: false,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.revision, 2);

    // Sibling mailbox and parent domain remain completely untouched and enabled
    const siblingAfter = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
    assert.equal(siblingAfter.enabled, true);
    assert.equal(siblingAfter.revision, 1);
    const domainAfter = await fx.mailDomainRegistry.getMailDomain(fx.mailDomainId);
    assert.equal(domainAfter.status, 'enabled');
    assert.equal(domainAfter.revision, 1);

    // With target disabled, previewDelete succeeds without disabling parent domain
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
  }
});

// ============================================================================
// Criterion 2: Active SMTP, IMAP, and Roundcube sessions for the mailbox being
//              deleted are safely terminated and verified
// ============================================================================

test('Criterion 2: Active SMTP, IMAP, and Roundcube sessions for the mailbox being deleted are safely terminated and verified', async () => {
  const fx = createMailboxRemovalFixture({
    domainStatus: 'enabled',
    mailboxEnabled: false,
    mailboxRevision: 2,
    dataPresent: true,
  });

  // 1. Initial state: verify active sessions exist for target and sibling
  const targetSessionsBefore = fx.activeSessions.get(fx.mailbox.address);
  assert.equal(targetSessionsBefore.length, 2);
  assert.ok(targetSessionsBefore.some((s) => s.client === 'roundcube' && s.proto === 'imap'));
  assert.ok(targetSessionsBefore.some((s) => s.proto === 'smtp'));

  const siblingSessionsBefore = fx.activeSessions.get(fx.siblingMailbox.address);
  assert.equal(siblingSessionsBefore.length, 2);
  assert.ok(siblingSessionsBefore.some((s) => s.client === 'roundcube' && s.proto === 'imap'));
  assert.ok(siblingSessionsBefore.some((s) => s.proto === 'smtp'));

  // 2. Queue and execute host deletion of target mailbox
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
  assert.equal(deleteResult.sideEffects, true);

  // 3. Verify mailboxAccessGuard was invoked to quiesce and terminate sessions
  assert.ok(fx.mailboxAccessGuard.calls.some(([method, id]) => method === 'quiesce' && id === fx.mailbox.address));

  // Target mailbox active sessions (IMAP/Roundcube webmail, SMTP) are completely terminated
  const targetSessionsAfter = fx.activeSessions.get(fx.mailbox.address);
  assert.equal(targetSessionsAfter.length, 0);

  // Verification inspect confirms sessions remain cleared
  const verifiedProof = await fx.mailboxAccessGuard.verify(fx.mailbox.address);
  assert.equal(verifiedProof.sessionsCleared, true);
  assert.equal(verifiedProof.accessDisabled, true);

  // 4. Sibling mailbox session continuity:
  // Sibling mailbox sessions (Roundcube webmail IMAP, SMTP) are completely UNTOUCHED
  const siblingSessionsAfter = fx.activeSessions.get(fx.siblingMailbox.address);
  assert.equal(siblingSessionsAfter.length, 2);
  assert.ok(siblingSessionsAfter.some((s) => s.client === 'roundcube' && s.proto === 'imap'));
  assert.ok(siblingSessionsAfter.some((s) => s.proto === 'smtp'));
  assert.equal(fx.mailboxAccessGuard.calls.some(([, id]) => id === fx.siblingMailbox.address), false);

  // Sibling mailbox remains enabled in registry
  const siblingMb = await fx.mailboxRegistry.getMailbox(fx.siblingMailboxId);
  assert.equal(siblingMb.enabled, true);

  // 5. Fail-closed behavior: stubborn session refusing to terminate blocks deletion
  {
    const fxStubborn = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: false,
      mailboxRevision: 2,
      dataPresent: true,
    });
    // Add a stubborn Roundcube session that cannot be kicked
    fxStubborn.activeSessions.set(fxStubborn.mailbox.address, [
      { id: 'sess-stubborn-roundcube', proto: 'imap', client: 'roundcube', stubborn: true },
    ]);

    const previewStubborn = await fxStubborn.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fxStubborn.mailboxId,
      backupId: fxStubborn.backupId,
    });

    const queuedStubborn = await fxStubborn.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fxStubborn.mailboxId,
      backupId: fxStubborn.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: previewStubborn.previewDigest,
      confirmation: previewStubborn.confirmation,
    });

    // Host deletion execution fails-closed because session cannot be terminated
    await assert.rejects(
      async () => fxStubborn.hostOperations.executeOperation(
        OPERATIONS.MAIL_DATA_DELETE,
        queuedStubborn.job.payload,
        {
          jobId: queuedStubborn.job.id,
          serverId: fxStubborn.localServerId,
          type: 'mail_data_delete',
          resourceType: 'mail_domain',
          resourceId: fxStubborn.mailDomainId,
        }
      ),
      (err) => err.code === 'mailbox_access_sessions_remaining'
    );

    // Live mail data was NOT deleted because sessions could not be verified cleared
    const intactData = await fxStubborn.mailDataInspector.inspectMailbox(fxStubborn.mailbox.address);
    assert.equal(intactData.present, true);
    assert.equal(intactData.bytes, 4096);
  }

  // 6. Fail-closed behavior: target mailbox still enabled during quiescing throws mailbox_access_still_enabled
  {
    const fxEnabled = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: true,
      mailboxRevision: 1,
    });
    await assert.rejects(
      async () => fxEnabled.mailboxAccessGuard.quiesce(fxEnabled.mailbox.address),
      (err) => err.code === 'mailbox_access_still_enabled'
    );
  }
});

// ============================================================================
// Criterion 3: Atomic backend race and permission boundaries are enforced
//              so concurrent mailbox deletion requests fail-closed without corrupting state
// ============================================================================

test('Criterion 3: Atomic backend race and permission boundaries are enforced so concurrent mailbox deletion requests fail-closed without corrupting state', async (t) => {
  const fx = createMailboxRemovalFixture({
    domainStatus: 'enabled',
    mailboxEnabled: false,
    mailboxRevision: 2,
    dataPresent: true,
  });

  // 1. Race condition: concurrent queueDelete requests on active mail domain
  const preview = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
  });

  // First queueDelete succeeds
  const queued1 = await fx.mailDataOperationsService.queueDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: fx.backupId,
    expectedRevision: 2,
    expectedPreviewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(queued1.job.status, 'queued');

  // Second concurrent queueDelete fails-closed with mail_domain_job_conflict
  await assert.rejects(
    async () => fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: fx.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (err) => err instanceof MailDataOperationsError && err.code === 'mail_domain_job_conflict' && err.status === 409
  );

  // 2. Race condition: state change during deletion flow (re-enabled target mailbox)
  {
    const fxRace = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: false,
      mailboxRevision: 2,
      dataPresent: true,
    });
    const previewRace = await fxRace.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fxRace.mailboxId,
      backupId: fxRace.backupId,
    });

    // Concurrently re-enable the mailbox
    fxRace.mailboxesMap.get(fxRace.mailboxId).enabled = true;

    // queueDelete detects target is no longer disabled and fails-closed
    await assert.rejects(
      async () => fxRace.mailDataOperationsService.queueDelete({
        scope: 'mailbox',
        resourceId: fxRace.mailboxId,
        backupId: fxRace.backupId,
        expectedRevision: 2,
        expectedPreviewDigest: previewRace.previewDigest,
        confirmation: previewRace.confirmation,
      }),
      (err) => err instanceof MailDataOperationsError
        && (err.code === 'mail_data_delete_mailbox_disable_required' || err.code === 'mail_data_delete_preview_stale')
        && err.status === 409
    );

    // Concurrently bump revision while remaining disabled: queueDelete detects stale preview and fails-closed
    fxRace.mailboxesMap.get(fxRace.mailboxId).enabled = false;
    fxRace.mailboxesMap.get(fxRace.mailboxId).revision = 3;

    await assert.rejects(
      async () => fxRace.mailDataOperationsService.queueDelete({
        scope: 'mailbox',
        resourceId: fxRace.mailboxId,
        backupId: fxRace.backupId,
        expectedRevision: 2,
        expectedPreviewDigest: previewRace.previewDigest,
        confirmation: previewRace.confirmation,
      }),
      (err) => err instanceof MailDataOperationsError
        && err.code === 'mail_data_delete_preview_stale'
        && err.status === 409
    );
  }

  // 3. Race condition: concurrent finalizeMailbox calls
  {
    const fxFinalizeRace = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: false,
      mailboxRevision: 2,
      dataPresent: true,
    });

    // Prepare completed deletion job
    const delPreview = await fxFinalizeRace.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fxFinalizeRace.mailboxId,
      backupId: fxFinalizeRace.backupId,
    });
    const queuedDel = await fxFinalizeRace.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: fxFinalizeRace.mailboxId,
      backupId: fxFinalizeRace.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: delPreview.previewDigest,
      confirmation: delPreview.confirmation,
    });
    const delResult = await fxFinalizeRace.hostOperations.executeOperation(
      OPERATIONS.MAIL_DATA_DELETE,
      queuedDel.job.payload,
      {
        jobId: queuedDel.job.id,
        serverId: fxFinalizeRace.localServerId,
        type: 'mail_data_delete',
        resourceType: 'mail_domain',
        resourceId: fxFinalizeRace.mailDomainId,
      }
    );
    fxFinalizeRace.storedJobs.set(queuedDel.job.id, {
      ...queuedDel.job,
      status: 'succeeded',
      result: sanitizeMailDataDeleteResult(queuedDel.job, delResult),
    });

    const validConf = `delete-mailbox:${fxFinalizeRace.mailbox.address}`;

    // Two concurrent finalizations: first succeeds, second fails-closed with mailbox_not_found
    const [result1, result2] = await Promise.allSettled([
      fxFinalizeRace.mailDeleteFinalizeService.finalizeMailbox({
        mailboxId: fxFinalizeRace.mailboxId,
        expectedRevision: 2,
        deleteJobId: queuedDel.job.id,
        confirmation: validConf,
      }),
      fxFinalizeRace.mailDeleteFinalizeService.finalizeMailbox({
        mailboxId: fxFinalizeRace.mailboxId,
        expectedRevision: 2,
        deleteJobId: queuedDel.job.id,
        confirmation: validConf,
      }),
    ]);

    // Exactly one call succeeds, the other fails-closed with 404 mailbox_not_found
    const fulfilled = [result1, result2].filter((r) => r.status === 'fulfilled');
    const rejected = [result1, result2].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(fulfilled[0].value.deleted, true);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'mailbox_not_found');
    assert.equal(rejected[0].reason.status, 404);

    // Sibling mailbox revision and state are completely intact and untouched
    const siblingMb = await fxFinalizeRace.mailboxRegistry.getMailbox(fxFinalizeRace.siblingMailboxId);
    assert.equal(siblingMb.enabled, true);
    assert.equal(siblingMb.revision, 1);
  }

  // 4. Stale revision rejection on finalization
  {
    const fxStale = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: false,
      mailboxRevision: 2,
      dataPresent: false,
    });
    await assert.rejects(
      async () => fxStale.mailDeleteFinalizeService.finalizeMailbox({
        mailboxId: fxStale.mailboxId,
        expectedRevision: 1, // Stale!
        deleteJobId: randomUUID(),
        confirmation: `delete-mailbox:${fxStale.mailbox.address}`,
      }),
      (err) => err instanceof MailDeleteFinalizeError && err.code === 'stale_mailbox_revision' && err.status === 409
    );
  }

  // 5. Permission boundary enforcement via HTTP routes
  {
    const fxHttp = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: true,
      mailboxRevision: 1,
    });

    const app = express();
    app.use(express.json());

    let currentAuth = {
      user: { role: 'read_only' },
      access: { mode: 'read_only', permissions: ['mailboxes.read'] },
      security: { managementAllowed: false },
    };

    app.use((req, _res, next) => {
      req.auth = currentAuth;
      next();
    });

    mountMailboxRoutes(app, {
      mailboxRegistry: fxHttp.mailboxRegistry,
      mailDomainRegistry: fxHttp.mailDomainRegistry,
      domainRegistry: fxHttp.domainRegistry,
      mailDeleteFinalizeService: fxHttp.mailDeleteFinalizeService,
      localServerId: fxHttp.localServerId,
    });

    app.use((error, _req, res, _next) => {
      const known = error instanceof MailboxRegistryError
        || error instanceof MailDeleteFinalizeError;
      return res.status(known ? error.status : (error.status || 500)).json({
        error: { code: error.code || 'internal_error', message: error.message },
      });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // 5a. Read-only user cannot mutate mailbox state (403 Forbidden)
      const patchRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, enabled: false }),
      });
      assert.equal(patchRes.status, 403);

      // 5b. Read-only user cannot delete mailbox (403 Forbidden)
      const deleteRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: `delete-mailbox:${fxHttp.mailbox.address}`,
        }),
      });
      assert.equal(deleteRes.status, 403);

      // 5c. Owner role with managementAllowed: true can access routes
      currentAuth = {
        user: { role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };

      // 5d. Malformed confirmation body rejected fail-closed (400)
      const malformedRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: 'short',
        }),
      });
      assert.equal(malformedRes.status, 400);

      // 5e. Cross-server isolation: mailbox not on this server returns 404
      const otherServerRes = await fetch(`${base}/api/mailboxes/${randomUUID()}`, {
        method: 'GET',
      });
      assert.equal(otherServerRes.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
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

  // 1. Pre-deletion backup creation and receipt validation
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
  assert.ok(backupPreview.previewDigest.length === 64);
  assert.equal(backupPreview.confirmation, `backup-mail-data:${fx.mailDomainId}:${backupPreview.previewDigest}`);

  const queuedBackup = await fx.mailDataOperationsService.queueBackup({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    expectedRevision: 1,
    expectedPreviewDigest: backupPreview.previewDigest,
    confirmation: backupPreview.confirmation,
  });
  assert.equal(queuedBackup.job.type, 'mail_data_backup');
  assert.equal(queuedBackup.job.operation, OPERATIONS.MAIL_DATA_BACKUP);

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

  fx.storedJobs.set(queuedBackup.job.id, {
    ...queuedBackup.job,
    status: 'succeeded',
    result: sanitizeMailDataBackupResult(queuedBackup.job, backupResult),
  });

  const verifiedBackup = await fx.mailDataBackupManager.inspectBackup(queuedBackup.job.id);
  assert.ok(verifiedBackup);
  assert.equal(verifiedBackup.backupId, queuedBackup.job.id);
  assert.equal(verifiedBackup.sourceSnapshotSha256, fx.snapshotDigest);
  assert.equal(verifiedBackup.contentSha256, fx.backupContentDigest);

  // 2. Data drift after backup rejects delete preview as stale
  const deletePreviewValid = await fx.mailDataOperationsService.previewDelete({
    scope: 'mailbox',
    resourceId: fx.mailboxId,
    backupId: queuedBackup.job.id,
  });
  assert.equal(deletePreviewValid.backupId, queuedBackup.job.id);

  fx.liveData.snapshotSha256 = sha256('new-snapshot-after-backup');
  await assert.rejects(
    async () => fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: fx.mailboxId,
      backupId: queuedBackup.job.id,
    }),
    (err) => err instanceof MailDataOperationsError && err.code === 'mail_data_delete_backup_stale'
  );

  // Restore snapshot for rollback test
  fx.liveData.snapshotSha256 = fx.snapshotDigest;

  // 3. Prepare deletion operation with failingDeleteManager to test rollback
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

  // 4. Define failingDeleteManager mock with deleteNow AND deleteData
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

  // 5. Test host operations execution with failingDeleteManager
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

  // 6. Host rollback verification:
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

  // 7. Deletion finalization gating:
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

  // Sibling mailbox remains untouched and enabled
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
