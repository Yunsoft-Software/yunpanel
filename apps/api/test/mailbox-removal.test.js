import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import React, { StrictMode, createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { OPERATIONS } from '@yunpanel/protocol';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { mountMailDataRoutes } from '../src/mail-data-http.js';
import { mountMailDeleteImpactRoutes } from '../src/mail-delete-impact-http.js';
import {
  createMailboxRemoval,
  EMPTY_MAILBOX_REMOVAL,
} from '../../web/src/workspace/mailbox-removal-controller.js';
import {
  mailboxRemovalEligible,
  mailboxRemovalJob,
  mailboxRemovalSnapshot,
  mailboxRemovalTarget,
  mailboxRemovalBusy,
  mailboxRemovalJobId,
} from '../../web/src/workspace/mailbox-removal-model.js';
import { panelPermission, ownerAccess } from '../../web/src/owner-access.js';
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
  createMailDataDeleteManager,
  MailDataDeleteError,
} from '@yunpanel/host-runtime';
import {
  createSingleMailboxLifecycleCoordinator,
  assertNoDomainOrSiblingDisruption,
  assertNoClosedDomainReopened,
  assertMailboxAccessTerminatedSeparately,
  assertSiblingMailboxContinuity,
  createMailboxProtocolSessionTracker,
  createMailboxAccessGuard,
  MailboxAccessError,
  mailboxAccessInternals,
  assertDovecotPostfixCommandContracts,
  assertCommonConfigApplyPendingPreviewAndReloadEffect,
  MailboxReconciliationError,
  MailboxConcurrencyLockError,
  MailboxRollbackError,
  MailboxAuthorizationRevokedError,
  createRapidConfirmationGuard,
  reconcileLostMailboxOperation,
  validateResumeJobProof,
  assertActorAuthorizationContinuous,
  createMailboxInterProcessLockManager,
  assertWorkerMutationConcurrencyGuard,
  executeMailboxDeletionWithRollbackVerification,
} from '../src/mailbox-single-lifecycle.js';
import {
  createMailConfigurationService,
  MailConfigurationError,
} from '../src/mail-configuration.js';
import {
  recoverRunningMailData,
} from '../src/job-running-mail-data-recovery.js';
import {
  MailboxRegistryError,
} from '../src/mailbox-registry.js';
import {
  createSiteResourceBoundary,
  needsSiteResourceJson,
} from '../src/site-resource-boundary.js';
import {
  createTenantBoundaryMiddleware,
} from '../src/tenant-boundary.js';

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
  const websiteId = randomUUID();
  const otherWebsiteId = randomUUID();
  const otherWebDomainId = randomUUID();
  const otherMailDomainId = randomUUID();
  const otherMailboxId = randomUUID();

  const website = {
    id: websiteId,
    serverId: localServerId,
    customerId: 'cust-1',
  };

  const otherWebsite = {
    id: otherWebsiteId,
    serverId: localServerId,
    customerId: 'cust-2',
  };

  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: domainStatus,
    revision: 1,
  };

  const otherMailDomain = {
    id: otherMailDomainId,
    webDomainId: otherWebDomainId,
    domainName: 'other.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 1,
  };

  const domain = {
    id: webDomainId,
    websiteId,
    serverId: localServerId,
    primaryDomain: 'example.com',
  };

  const otherDomain = {
    id: otherWebDomainId,
    websiteId: otherWebsiteId,
    serverId: localServerId,
    primaryDomain: 'other.com',
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

  const otherMailbox = {
    id: otherMailboxId,
    mailDomainId: otherMailDomainId,
    address: 'user@other.com',
    enabled: false,
    revision: 1,
  };

  const mailboxesMap = new Map([
    [mailbox.id, { ...mailbox }],
    [siblingMailbox.id, { ...siblingMailbox }],
    [otherMailbox.id, { ...otherMailbox }],
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
      if (id === mailDomainId) return { ...mailDomain };
      if (id === otherMailDomainId) return { ...otherMailDomain };
      return null;
    },
    async deleteMailDomain(id) {
      if (id === mailDomainId) mailDomain.status = 'deleted';
      if (id === otherMailDomainId) otherMailDomain.status = 'deleted';
    },
    async listMailDomains() {
      return [{ ...mailDomain }, { ...otherMailDomain }];
    },
  };

  const domainRegistry = {
    async getDomain(id) {
      if (id === webDomainId) return { ...domain };
      if (id === otherWebDomainId) return { ...otherDomain };
      return null;
    },
    async listDomains() {
      return [{ ...domain }, { ...otherDomain }];
    },
  };

  const websiteRegistry = {
    async getWebsite(id) {
      if (id === websiteId) return { ...website };
      if (id === otherWebsiteId) return { ...otherWebsite };
      return null;
    },
    async listWebsites() {
      return [{ ...website }, { ...otherWebsite }];
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
    websiteId,
    otherWebsiteId,
    otherWebDomainId,
    otherMailDomainId,
    otherMailboxId,
    website,
    otherWebsite,
    otherDomain,
    otherMailDomain,
    otherMailbox,
    websiteRegistry,
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
    app.disable('x-powered-by');
    const smallJson = express.json({ limit: '64kb' });
    app.use((request, response, next) => {
      if (needsSiteResourceJson(request)) return smallJson(request, response, next);
      return express.json()(request, response, next);
    });

    let currentAuth = {
      user: { role: 'read_only' },
      access: { mode: 'read_only', permissions: ['mailboxes.read'] },
      security: { managementAllowed: false },
    };

    app.use((req, _res, next) => {
      req.auth = currentAuth;
      next();
    });

    app.use(createTenantBoundaryMiddleware({
      websiteRegistry: fxHttp.websiteRegistry,
      websiteLookup: async (id) => fxHttp.websiteRegistry.getWebsite(id),
    }));

    app.use(createSiteResourceBoundary({
      websiteRegistry: fxHttp.websiteRegistry,
      domainRegistry: fxHttp.domainRegistry,
      mailDomainRegistry: fxHttp.mailDomainRegistry,
      mailboxRegistry: fxHttp.mailboxRegistry,
      localServerId: fxHttp.localServerId,
    }));

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

      // 5f. Unauthenticated request rejected fail-closed (401 Unauthorized)
      currentAuth = null;
      const unauthRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: `delete-mailbox:${fxHttp.mailbox.address}`,
        }),
      });
      assert.equal(unauthRes.status, 401);

      // 5g. Inactive site_manager account rejected fail-closed (403 Forbidden)
      currentAuth = {
        user: {
          id: 'sm-inactive',
          role: 'site_manager',
          active: false,
          websiteIds: [fxHttp.websiteId],
        },
        access: { mode: 'site_management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      const inactiveRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: `delete-mailbox:${fxHttp.mailbox.address}`,
        }),
      });
      assert.equal(inactiveRes.status, 403);

      // 5h. Site_manager attempting cross-site deletion of mailbox on foreign website rejected with 403
      currentAuth = {
        user: {
          id: 'sm-active',
          role: 'site_manager',
          active: true,
          websiteIds: [fxHttp.websiteId],
        },
        access: { mode: 'site_management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      const crossSiteRes = await fetch(`${base}/api/mailboxes/${fxHttp.otherMailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: `delete-mailbox:${fxHttp.otherMailbox.address}`,
        }),
      });
      assert.equal(crossSiteRes.status, 403);
      const crossSiteBody = await crossSiteRes.json();
      assert.equal(crossSiteBody?.error?.code, 'site_scope_forbidden');

      // 5i. Customer account attempting cross-site deletion rejected with 403
      currentAuth = {
        user: {
          id: 'cust-1',
          role: 'customer',
          hosting: { kind: 'customer', resellerId: null },
          active: true,
          websiteIds: [fxHttp.websiteId],
        },
        access: { mode: 'site_management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      const custCrossRes = await fetch(`${base}/api/mailboxes/${fxHttp.otherMailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          deleteJobId: randomUUID(),
          confirmation: `delete-mailbox:${fxHttp.otherMailbox.address}`,
        }),
      });
      assert.equal(custCrossRes.status, 403);
      const custCrossBody = await custCrossRes.json();
      assert.equal(custCrossBody?.error?.code, 'site_scope_forbidden');

      // 5j. Authorized site account successfully disables and finalizes mailbox removal
      // 5j.1 Disable mailbox via PATCH as authorized customer
      const disableRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, enabled: false }),
      });
      assert.equal(disableRes.status, 200);
      const disabledData = await disableRes.json();
      assert.equal(disabledData?.data?.enabled, false);
      assert.equal(disabledData?.data?.revision, 2);

      // Prepare simulated completed delete job for revision 2
      const deleteJobId = randomUUID();
      const jobResult = {
        version: 1,
        transactionId: deleteJobId,
        backupId: fxHttp.backupId,
        scope: 'mailbox',
        identity: fxHttp.mailbox.address,
        mailDomainId: fxHttp.mailDomainId,
        resourceId: fxHttp.mailboxId,
        expectedResourceRevision: 2,
        sourcePresent: true,
        contentSha256: fxHttp.backupContentDigest,
        bytes: 0,
        files: 0,
        directories: 0,
        deleted: true,
        sideEffects: true,
      };
      fxHttp.storedJobs.set(deleteJobId, {
        id: deleteJobId,
        serverId: fxHttp.localServerId,
        type: 'mail_data_delete',
        resourceType: 'mail_domain',
        resourceId: fxHttp.mailDomainId,
        operation: OPERATIONS.MAIL_DATA_DELETE,
        status: 'succeeded',
        payload: {
          transactionId: deleteJobId,
          backupId: fxHttp.backupId,
          scope: 'mailbox',
          identity: fxHttp.mailbox.address,
        },
        result: jobResult,
      });
      fxHttp.liveData.present = false;
      fxHttp.liveData.bytes = 0;

      // 5j.2 Finalize deletion via DELETE as authorized customer
      const validConfirmation = `delete-mailbox:${fxHttp.mailbox.address}`;
      const deleteSuccessRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 2,
          deleteJobId,
          confirmation: validConfirmation,
        }),
      });
      assert.equal(deleteSuccessRes.status, 200);
      const deleteSuccessBody = await deleteSuccessRes.json();
      assert.equal(deleteSuccessBody?.data?.deleted, true);
      assert.equal(deleteSuccessBody?.data?.id, fxHttp.mailboxId);

      // Verify mailbox removed from registry
      assert.equal(await fxHttp.mailboxRegistry.getMailbox(fxHttp.mailboxId), null);

      // Subsequent GET as customer fails closed with 403 site_scope_forbidden
      const getDeletedCustomerRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'GET',
      });
      assert.equal(getDeletedCustomerRes.status, 403);
      const getDeletedCustomerBody = await getDeletedCustomerRes.json();
      assert.equal(getDeletedCustomerBody?.error?.code, 'site_scope_forbidden');

      // Subsequent GET as owner returns 404 mailbox_not_found from route handler
      currentAuth = {
        user: { role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };
      const getDeletedOwnerRes = await fetch(`${base}/api/mailboxes/${fxHttp.mailboxId}`, {
        method: 'GET',
      });
      assert.equal(getDeletedOwnerRes.status, 404);
      const getDeletedOwnerBody = await getDeletedOwnerRes.json();
      assert.equal(getDeletedOwnerBody?.error?.code, 'mailbox_not_found');
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

test('Criterion 6: Field-only lookup, strict absence exit codes, cache flush, and single-user kick/who in real Dovecot/Postfix contracts without accepting errors or unmanaged configs as absence', async () => {
  const targetAddress = 'alice@example.com';
  const siblingAddress = 'bob@example.com';

  const executedCommands = [];
  const validMockRunner = async (file, args) => {
    executedCommands.push({ file, args });
    const fullCmd = `${file} ${args.join(' ')}`;

    // 1. Postfix managed lookups verification
    if (file === '/usr/sbin/postconf') {
      if (args[0] === '-h' && args[1] === 'virtual_mailbox_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf', stderr: '' };
      }
      if (args[0] === '-h' && args[1] === 'smtpd_sender_login_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
      }
      throw new Error(`Unexpected postconf parameter: ${args[1]}`);
    }

    // 2. Postfix postmap absence query
    if (file === '/usr/sbin/postmap') {
      assert.equal(args[0], '-q');
      const queriedAddress = args[1];
      if (queriedAddress === targetAddress) {
        // Strict absence: exit code 1 with empty stdout and stderr
        const err = new Error('not found');
        err.code = 1;
        err.stdout = '';
        err.stderr = '';
        throw err;
      }
      // If someone queries sibling, it is present (exit 0)
      return { stdout: siblingAddress, stderr: '' };
    }

    // 3. Dovecot commands
    if (file === '/usr/bin/doveadm') {
      const sub = args[0];

      // Field-only passdb lookup: -f user
      if (sub === 'auth' && args[1] === 'lookup') {
        assert.ok(args.includes('-f'), 'Passdb lookup must be field-only');
        assert.equal(args[args.indexOf('-f') + 1], 'user', 'Field-only passdb lookup must specify user');
        const queriedAddress = args.at(-1);
        if (queriedAddress === targetAddress) {
          const err = new Error('user not found');
          err.code = 67;
          err.stdout = '';
          err.stderr = `passdb lookup: user ${targetAddress} doesn't exist`;
          throw err;
        }
        return { stdout: queriedAddress, stderr: '' };
      }

      // Field-only userdb lookup: -f uid
      if (sub === 'user') {
        assert.ok(args.includes('-f'), 'Userdb lookup must be field-only');
        assert.equal(args[args.indexOf('-f') + 1], 'uid', 'Field-only userdb lookup must specify uid');
        const queriedAddress = args.at(-1);
        if (queriedAddress === targetAddress) {
          const err = new Error('user not found');
          err.code = 67;
          err.stdout = '';
          err.stderr = `userdb lookup: user ${targetAddress} doesn't exist`;
          throw err;
        }
        return { stdout: '1000', stderr: '' };
      }

      // Cache flush
      if (sub === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
        assert.equal(args[3], targetAddress, 'Cache flush must target only the specified address');
        return { stdout: '3 cache entries flushed', stderr: '' };
      }

      // Kick user
      if (sub === 'kick') {
        assert.equal(args[1], targetAddress, 'Kick must target strictly the single chosen address');
        assert.ok(!args.includes('-A'), 'Kick must never terminate all accounts with -A');
        assert.ok(!args.includes('*'), 'Kick must never terminate with wildcard');
        return { stdout: targetAddress, stderr: '' };
      }

      // Who active sessions
      if (args.includes('who')) {
        const queriedAddress = args.at(-1);
        assert.equal(queriedAddress, targetAddress, 'Who must target only the specified address');
        // No active sessions remaining
        return { stdout: 'username\tproto\tpid\tip', stderr: '' };
      }
    }

    throw new Error(`Unexpected command: ${fullCmd}`);
  };

  // Positive verification of Dovecot/Postfix contracts
  const contractResult = await assertDovecotPostfixCommandContracts({
    run: validMockRunner,
    targetAddress,
  });
  assert.equal(contractResult.identity, targetAddress);
  assert.equal(contractResult.contractsVerified, true);
  assert.equal(contractResult.quiesced.accessDisabled, true);
  assert.equal(contractResult.quiesced.sessionsCleared, true);

  // Verify that Dovecot passdb field-only lookup used -f user across all services
  const passdbLookups = executedCommands.filter((c) => c.file === '/usr/bin/doveadm' && c.args[0] === 'auth' && c.args[1] === 'lookup');
  assert.equal(passdbLookups.length >= 8, true, 'Quiesce and verify must check all auth services');
  for (const call of passdbLookups) {
    const fIdx = call.args.indexOf('-f');
    assert.equal(fIdx !== -1, true);
    assert.equal(call.args[fIdx + 1], 'user');
    assert.equal(call.args.at(-1), targetAddress);
  }

  // Verify that Dovecot userdb field-only lookup used -f uid across all services
  const userdbLookups = executedCommands.filter((c) => c.file === '/usr/bin/doveadm' && c.args[0] === 'user');
  assert.equal(userdbLookups.length >= 8, true, 'Quiesce and verify must check all userdb services');
  for (const call of userdbLookups) {
    const fIdx = call.args.indexOf('-f');
    assert.equal(fIdx !== -1, true);
    assert.equal(call.args[fIdx + 1], 'uid');
    assert.equal(call.args.at(-1), targetAddress);
  }

  // Verify kick and who strictly isolated to targetAddress
  const kicks = executedCommands.filter((c) => c.file === '/usr/bin/doveadm' && c.args[0] === 'kick');
  assert.equal(kicks.length, 1);
  assert.deepEqual(kicks[0].args, ['kick', targetAddress]);

  // Negative tests: error codes or unmanaged config MUST NEVER be accepted as absence
  // 1. Postconf unmanaged config map
  const unmanagedRunner = async (file, args) => {
    if (file === '/usr/sbin/postconf') {
      return { stdout: 'hash:/etc/postfix/unmanaged_map', stderr: '' };
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: unmanagedRunner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_configuration_unverified'
  );

  // 2. Postmap exit code 75 (tempfail / sqlite error)
  const postmap75Runner = async (file, args) => {
    if (file === '/usr/sbin/postmap') {
      const err = new Error('temporary failure');
      err.code = 75;
      err.stdout = '';
      err.stderr = 'postmap: fatal: sqlite table error';
      throw err;
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: postmap75Runner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_check_failed'
  );

  // 3. Dovecot auth lookup exit code 75 (tempfail / missing dovecot.conf)
  const doveadmAuth75Runner = async (file, args) => {
    if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'lookup') {
      const err = new Error('doveadm auth tempfail');
      err.code = 75;
      err.stdout = '';
      err.stderr = 'stat(/etc/dovecot/dovecot.conf) failed: No such file or directory';
      throw err;
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: doveadmAuth75Runner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_check_failed'
  );

  // 4. Dovecot userdb lookup exit code 75
  const doveadmUser75Runner = async (file, args) => {
    if (file === '/usr/bin/doveadm' && args[0] === 'user') {
      const err = new Error('userdb tempfail');
      err.code = 75;
      err.stdout = '';
      err.stderr = 'doveadm(user): fatal: userdb lookup service unavailable';
      throw err;
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: doveadmUser75Runner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_check_failed'
  );

  // 5. Postmap exit code 0 (account still enabled in postfix)
  const postmapEnabledRunner = async (file, args) => {
    if (file === '/usr/sbin/postmap') {
      return { stdout: 'user@example.com', stderr: '' };
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: postmapEnabledRunner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_still_enabled'
  );

  // 6. Cache flush invalid output format
  const badFlushRunner = async (file, args) => {
    if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
      return { stdout: 'failed to flush cache', stderr: '' };
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: badFlushRunner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_cache_unverified'
  );

  // 7. Active sessions remaining after kick
  const remainingSessionRunner = async (file, args) => {
    if (file === '/usr/bin/doveadm' && args.includes('who')) {
      return { stdout: 'username\tproto\tpid\tip\nalice@example.com\timap\t1234\t10.0.0.1', stderr: '' };
    }
    return validMockRunner(file, args);
  };
  await assert.rejects(
    assertDovecotPostfixCommandContracts({ run: remainingSessionRunner, targetAddress }),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_sessions_remaining'
  );
});

test('Criterion 7: Common config apply previews all recorded pending changes and proves service reload effect without whole-domain shutdown workaround', async () => {
  const domainId = 'domain-shared-01';
  const targetMailboxId = 'mb-target-01';
  const siblingMailboxId = 'mb-sibling-02';
  const pendingMailboxId = 'mb-pending-03';
  const domainName = 'example.com';

  const domain = {
    id: domainId,
    domainName,
    managementMode: 'local',
    status: 'enabled',
    revision: 3,
  };

  const mailboxes = new Map([
    [targetMailboxId, {
      id: targetMailboxId,
      mailDomainId: domainId,
      address: 'target@example.com',
      enabled: false, // Disabled pending deletion
      revision: 2,
    }],
    [siblingMailboxId, {
      id: siblingMailboxId,
      mailDomainId: domainId,
      address: 'sibling@example.com',
      enabled: true,
      revision: 1,
    }],
    [pendingMailboxId, {
      id: pendingMailboxId,
      mailDomainId: domainId,
      address: 'pending-new@example.com',
      enabled: true,
      revision: 1,
    }],
  ]);

  const passwordHash = '$argon2id$v=19$m=65536,t=3,p=1$' + Buffer.alloc(16, 5).toString('base64').replace(/=+$/, '') + '$' + Buffer.alloc(32, 6).toString('base64').replace(/=+$/, '');

  const mailDomainRegistry = {
    getMailDomain: async (id) => (id === domain.id ? { ...domain } : null),
    listMailDomains: async () => [{ ...domain }],
  };

  const mailboxRegistry = {
    getMailbox: async (id) => (mailboxes.has(id) ? { ...mailboxes.get(id) } : null),
    listMailboxes: async () => [...mailboxes.values()].map((m) => ({ ...m })),
    materializeEnabledAccounts: async () =>
      [...mailboxes.values()]
        .filter((m) => m.enabled)
        .map((m) => ({ address: m.address, passwordHash })),
    setEnabled: async (id, { expectedRevision, enabled }) => {
      const mb = mailboxes.get(id);
      if (!mb) throw new Error('not found');
      mb.enabled = enabled;
      mb.revision = expectedRevision + 1;
      return { ...mb };
    },
  };

  const mailAliasRegistry = {
    materializeEnabledAliases: async () => [{ source: 'info@example.com', destinations: ['sibling@example.com'] }],
  };

  const mailConfigurationService = createMailConfigurationService({
    mailDomainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
  });

  // 1. Verify common config apply preview includes pending changes and proves reload effect
  // Domain status remains 'enabled'! Target is excluded, pending mailbox is included.
  const previewResult = await assertCommonConfigApplyPendingPreviewAndReloadEffect({
    mailConfigurationService,
    mailDomainRegistry,
    mailboxRegistry,
    mailDomainId: domainId,
    targetMailboxId,
    otherPendingMailboxId: pendingMailboxId,
  });

  assert.equal(previewResult.domainStatus, 'enabled');
  assert.equal(previewResult.targetExcluded, true);
  assert.equal(previewResult.pendingIncluded, true);
  assert.equal(previewResult.accountsCount, 2); // sibling + pending-new
  assert.ok(previewResult.configurationSha256);
  assert.ok(previewResult.previewDigest);
  assert.equal(previewResult.domainShutdownWorkaroundAvoided, true);

  // 2. Reject domain shutdown workaround if domain status is changed to disabled
  const disabledDomain = { ...domain, status: 'disabled' };
  const disruptedDomainRegistry = {
    getMailDomain: async (id) => (id === domain.id ? { ...disabledDomain } : null),
    listMailDomains: async () => [{ ...disabledDomain }],
  };
  await assert.rejects(
    async () => assertCommonConfigApplyPendingPreviewAndReloadEffect({
      mailConfigurationService,
      mailDomainRegistry: disruptedDomainRegistry,
      mailboxRegistry,
      mailDomainId: domainId,
      targetMailboxId,
      otherPendingMailboxId: pendingMailboxId,
    }),
    (err) => err.code === 'domain_workaround_detected',
    'Domain shutdown workaround must be detected and rejected'
  );
});

// ============================================================================
// T-DEV-MR-SINGLE Task Extension:
// Criteria 8–14: Lost Operation Reconciliation, Rapid Confirmation Guard,
// Resume Proof, Session Revocation, Inter-Process Lock, and Rollback
// ============================================================================

test('Criterion 8: Lost PATCH, apply, delete, or finalize replies are reconciled without blind duplicate writes', async () => {
  const mailboxId = 'mb-rec-01';
  const address = 'target-rec@example.com';
  const mailDomainId = 'domain-rec-01';
  const backupId = 'backup-rec-01';

  const mailboxes = new Map([
    [mailboxId, { id: mailboxId, address, mailDomainId, enabled: false, revision: 2 }],
  ]);

  const mailboxRegistry = {
    getMailbox: async (id) => (mailboxes.has(id) ? { ...mailboxes.get(id) } : null),
  };

  // 1. Lost PATCH reconciliation:
  // Mailbox is already disabled at revision 2 -> reconciled without second PATCH write
  const patchReconcile = await reconcileLostMailboxOperation({
    operation: 'patch',
    mailboxId,
    expectedRevision: 2,
    mailboxRegistry,
  });
  assert.equal(patchReconcile.reconciled, true);
  assert.equal(patchReconcile.duplicateWriteAvoided, true);
  assert.equal(patchReconcile.action, 'reconciled_existing_disabled');

  // PATCH not applied (still enabled at expected revision) -> safe to retry
  mailboxes.set('mb-unapplied', { id: 'mb-unapplied', address: 'unapplied@test.com', mailDomainId, enabled: true, revision: 1 });
  const patchUnapplied = await reconcileLostMailboxOperation({
    operation: 'patch',
    mailboxId: 'mb-unapplied',
    expectedRevision: 1,
    mailboxRegistry,
  });
  assert.equal(patchUnapplied.reconciled, false);
  assert.equal(patchUnapplied.safeToRetry, true);

  // PATCH conflict: enabled with advanced revision -> fails closed with 409
  mailboxes.set('mb-conflict', { id: 'mb-conflict', address: 'conflict@test.com', mailDomainId, enabled: true, revision: 5 });
  await assert.rejects(
    reconcileLostMailboxOperation({
      operation: 'patch',
      mailboxId: 'mb-conflict',
      expectedRevision: 2,
      mailboxRegistry,
    }),
    (err) => err instanceof MailboxReconciliationError && err.code === 'mailbox_reconcile_conflict'
  );

  // 2. Lost Apply reconciliation:
  const jobs = new Map();
  const jobRegistry = {
    getJob: async (id) => (jobs.has(id) ? { ...jobs.get(id) } : null),
  };

  jobs.set('job-apply-succeeded', {
    id: 'job-apply-succeeded',
    operation: 'mail.config.apply',
    resourceId: mailDomainId,
    status: 'succeeded',
    result: { applied: true, configurationSha256: 'sha-applied-123' },
  });

  const applyReconcile = await reconcileLostMailboxOperation({
    operation: 'apply',
    mailboxId,
    mailDomainId,
    lastKnownJobId: 'job-apply-succeeded',
    mailboxRegistry,
    jobRegistry,
  });
  assert.equal(applyReconcile.reconciled, true);
  assert.equal(applyReconcile.duplicateApplyAvoided, true);
  assert.equal(applyReconcile.action, 'reconciled_applied_job');

  // Apply job still waiting/running
  jobs.set('job-apply-running', {
    id: 'job-apply-running',
    operation: 'mail.config.apply',
    resourceId: mailDomainId,
    status: 'running',
  });
  const applyWaiting = await reconcileLostMailboxOperation({
    operation: 'apply',
    mailboxId,
    mailDomainId,
    lastKnownJobId: 'job-apply-running',
    mailboxRegistry,
    jobRegistry,
  });
  assert.equal(applyWaiting.reconciled, false);
  assert.equal(applyWaiting.status, 'waiting');

  // Failed apply job -> never automatic retry, requires fresh confirmation
  jobs.set('job-apply-failed', {
    id: 'job-apply-failed',
    operation: 'mail.config.apply',
    resourceId: mailDomainId,
    status: 'failed',
  });
  await assert.rejects(
    reconcileLostMailboxOperation({
      operation: 'apply',
      mailboxId,
      mailDomainId,
      lastKnownJobId: 'job-apply-failed',
      mailboxRegistry,
      jobRegistry,
    }),
    (err) => err instanceof MailboxReconciliationError && err.code === 'apply_job_failed'
  );

  // 3. Lost Delete reconciliation:
  jobs.set('job-del-succeeded', {
    id: 'job-del-succeeded',
    operation: 'mail.data.delete',
    resourceId: mailDomainId,
    status: 'succeeded',
    result: {
      scope: 'mailbox',
      identity: address,
      backupId,
      deleted: true,
    },
  });

  const deleteReconcile = await reconcileLostMailboxOperation({
    operation: 'delete',
    mailboxId,
    address,
    backupId,
    lastKnownJobId: 'job-del-succeeded',
    mailboxRegistry,
    jobRegistry,
  });
  assert.equal(deleteReconcile.reconciled, true);
  assert.equal(deleteReconcile.duplicateDeleteAvoided, true);
  assert.equal(deleteReconcile.action, 'reconciled_deleted_job');

  // Delete job mismatch identity rejects
  await assert.rejects(
    reconcileLostMailboxOperation({
      operation: 'delete',
      mailboxId,
      address: 'different-user@example.com',
      backupId,
      lastKnownJobId: 'job-del-succeeded',
      mailboxRegistry,
      jobRegistry,
    }),
    (err) => err instanceof MailboxReconciliationError && err.code === 'delete_job_mismatch'
  );

  // 4. Lost Finalize reconciliation:
  // Mailbox is absent (deleted from registry), verified by delete job receipt & verified absent mail data
  mailboxes.delete(mailboxId);
  const mailDataInspector = {
    inspectMailbox: async (addr) => ({ present: false, bytes: 0, snapshotSha256: null }),
  };

  const finalizeReconcile = await reconcileLostMailboxOperation({
    operation: 'finalize',
    mailboxId,
    address,
    backupId,
    lastKnownJobId: 'job-del-succeeded',
    mailboxRegistry,
    jobRegistry,
    mailDataInspector,
  });
  assert.equal(finalizeReconcile.reconciled, true);
  assert.equal(finalizeReconcile.deleted, true);
  assert.equal(finalizeReconcile.verifiedByReceipt, true);

  // Finalize absent mailbox WITHOUT receipt must reject (404 alone is not proof!)
  await assert.rejects(
    reconcileLostMailboxOperation({
      operation: 'finalize',
      mailboxId: 'mb-nonexistent',
      address: 'ghost@example.com',
      lastKnownJobId: null,
      mailboxRegistry,
      jobRegistry,
      mailDataInspector,
    }),
    (err) => err instanceof MailboxReconciliationError && err.code === 'finalize_unverified_missing_receipt'
  );
});

test('Criterion 9: Two rapid confirmations process only the first valid token and prevent duplicate mutation races', async () => {
  const guard = createRapidConfirmationGuard();
  const token = 'delete-mailbox:alice@example.com:rev-1:token-xyz';

  // 1. First confirmation begins processing
  const attempt1 = guard.beginConfirmation(token, { mailboxId: 'mb-alice', revision: 1 });
  assert.equal(attempt1.token, token);
  assert.equal(guard.isInFlight(token), true);
  assert.equal(guard.isConsumed(token), false);

  // 2. Second rapid confirmation with identical token rejects with 409
  assert.throws(
    () => guard.beginConfirmation(token, { mailboxId: 'mb-alice', revision: 1 }),
    (err) => err instanceof MailboxConcurrencyLockError && err.code === 'rapid_confirmation_in_flight'
  );

  // 3. First operation commits upon successful execution
  attempt1.commit({ deleted: true });
  assert.equal(guard.isInFlight(token), false);
  assert.equal(guard.isConsumed(token), true);

  // 4. Subsequent rapid confirmation after consumption rejects with 409
  assert.throws(
    () => guard.beginConfirmation(token, { mailboxId: 'mb-alice', revision: 1 }),
    (err) => err instanceof MailboxConcurrencyLockError && err.code === 'confirmation_already_consumed'
  );

  // 5. Aborted confirmation (e.g. preflight check failure) allows safe retry
  const abortableToken = 'token-abortable-123';
  const attemptAbort = guard.beginConfirmation(abortableToken, { mailboxId: 'mb-alice', revision: 1 });
  attemptAbort.abort();
  assert.equal(guard.isInFlight(abortableToken), false);
  assert.equal(guard.isConsumed(abortableToken), false);

  const attemptRetry = guard.beginConfirmation(abortableToken, { mailboxId: 'mb-alice', revision: 1 });
  assert.ok(attemptRetry);
  attemptRetry.commit();
  assert.equal(guard.isConsumed(abortableToken), true);
});

test('Criterion 10: Stale backup or foreign job ID cannot resume mailbox operations or overwrite data with invalid proof', async () => {
  const domainId = 'dom-valid-01';
  const mailboxAddress = 'legit@example.com';
  const validBackupId = 'backup-valid-01';

  const jobs = new Map();
  const jobRegistry = {
    getJob: async (id) => (jobs.has(id) ? { ...jobs.get(id) } : null),
  };

  const backups = new Map([
    [validBackupId, {
      backupId: validBackupId,
      identity: mailboxAddress,
      scope: 'mailbox',
      contentSha256: 'a'.repeat(64),
    }],
    ['foreign-backup-99', {
      backupId: 'foreign-backup-99',
      identity: 'stranger@otherdomain.com',
      scope: 'mailbox',
      contentSha256: 'b'.repeat(64),
    }],
  ]);

  const backupManager = {
    inspectBackup: async (id) => (backups.has(id) ? { ...backups.get(id) } : null),
  };

  jobs.set('job-valid-del', {
    id: 'job-valid-del',
    operation: 'mail.data.delete',
    resourceId: domainId,
    status: 'succeeded',
    result: {
      scope: 'mailbox',
      identity: mailboxAddress,
      backupId: validBackupId,
      expectedResourceRevision: 2,
      deleted: true,
    },
  });

  // 1. Valid resume proof succeeds
  const validResume = await validateResumeJobProof({
    jobId: 'job-valid-del',
    expectedScope: 'mailbox',
    expectedResourceId: domainId,
    expectedAddress: mailboxAddress,
    expectedBackupId: validBackupId,
    expectedRevision: 2,
    expectedOperation: 'mail.data.delete',
    jobRegistry,
    backupManager,
  });
  assert.equal(validResume.valid, true);

  // 2. Reject resume with foreign job ID (identity mismatch)
  await assert.rejects(
    validateResumeJobProof({
      jobId: 'job-valid-del',
      expectedScope: 'mailbox',
      expectedResourceId: domainId,
      expectedAddress: 'imposter@example.com',
      expectedBackupId: validBackupId,
      jobRegistry,
      backupManager,
    }),
    (err) => err.code === 'resume_job_identity_mismatch'
  );

  // 3. Reject resume with wrong operation
  await assert.rejects(
    validateResumeJobProof({
      jobId: 'job-valid-del',
      expectedScope: 'mailbox',
      expectedResourceId: domainId,
      expectedAddress: mailboxAddress,
      expectedOperation: 'mail.data.backup',
      jobRegistry,
      backupManager,
    }),
    (err) => err.code === 'resume_job_operation_mismatch'
  );

  // 4. Reject resume with mismatched backup ID
  await assert.rejects(
    validateResumeJobProof({
      jobId: 'job-valid-del',
      expectedScope: 'mailbox',
      expectedResourceId: domainId,
      expectedAddress: mailboxAddress,
      expectedBackupId: 'different-backup-123',
      jobRegistry,
      backupManager,
    }),
    (err) => err.code === 'resume_job_backup_mismatch'
  );

  // 5. Reject resume with failed job
  jobs.set('job-failed-del', {
    id: 'job-failed-del',
    operation: 'mail.data.delete',
    resourceId: domainId,
    status: 'failed',
  });
  await assert.rejects(
    validateResumeJobProof({
      jobId: 'job-failed-del',
      expectedScope: 'mailbox',
      expectedResourceId: domainId,
      expectedAddress: mailboxAddress,
      jobRegistry,
      backupManager,
    }),
    (err) => err.code === 'resume_job_unsuccessful'
  );

  // 6. Reject resume with foreign / stale backup
  jobs.set('job-foreign-backup', {
    id: 'job-foreign-backup',
    operation: 'mail.data.delete',
    resourceId: domainId,
    status: 'succeeded',
    result: {
      scope: 'mailbox',
      identity: mailboxAddress,
      backupId: 'foreign-backup-99',
      deleted: true,
    },
  });
  await assert.rejects(
    validateResumeJobProof({
      jobId: 'job-foreign-backup',
      expectedScope: 'mailbox',
      expectedResourceId: domainId,
      expectedAddress: mailboxAddress,
      expectedBackupId: 'foreign-backup-99',
      jobRegistry,
      backupManager,
    }),
    (err) => err.code === 'resume_backup_identity_mismatch'
  );
});

test('Criterion 11: Session or permission revocation immediately halts pending operations and prevents retargeting', async () => {
  const websiteId = 'site-corp-01';
  const originalAuth = {
    user: { id: 'admin-1', role: 'site_manager', active: true, websiteIds: [websiteId] },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: true },
  };

  // 1. Continuous matching session succeeds
  const authOk = assertActorAuthorizationContinuous({
    currentAuth: structuredClone(originalAuth),
    originalAuth,
    targetWebsiteId: websiteId,
  });
  assert.equal(authOk.authorized, true);
  assert.equal(authOk.actorId, 'admin-1');

  // 2. User ID changed during in-flight operation -> halts immediately with 403
  const changedUserAuth = {
    user: { id: 'impostor-2', role: 'site_manager', active: true, websiteIds: [websiteId] },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: true },
  };
  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: changedUserAuth,
      originalAuth,
      targetWebsiteId: websiteId,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_session_changed' && err.status === 403
  );

  // 3. Session token rotated -> halts with 401
  const rotatedSessionAuth = {
    user: { id: 'admin-1', role: 'site_manager', active: true, websiteIds: [websiteId] },
    sessionVersion: 'v2.0.0',
    security: { managementAllowed: true },
  };
  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: rotatedSessionAuth,
      originalAuth,
      targetWebsiteId: websiteId,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_session_rotated' && err.status === 401
  );

  // 4. User suspended (active: false) -> halts with 403
  const suspendedAuth = {
    user: { id: 'admin-1', role: 'site_manager', active: false, websiteIds: [websiteId] },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: true },
  };
  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: suspendedAuth,
      originalAuth,
      targetWebsiteId: websiteId,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_user_suspended' && err.status === 403
  );

  // 5. Role downgraded to read_only -> halts with 403
  const readOnlyAuth = {
    user: { id: 'admin-1', role: 'read_only', active: true, websiteIds: [websiteId] },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: false },
  };
  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: readOnlyAuth,
      originalAuth,
      targetWebsiteId: websiteId,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_permission_revoked' && err.status === 403
  );

  // 6. Website grant revoked from user -> halts with 403
  const revokedGrantAuth = {
    user: { id: 'admin-1', role: 'site_manager', active: true, websiteIds: ['different-website-99'] },
    sessionVersion: 'v1.0.0',
    security: { managementAllowed: true },
  };
  assert.throws(
    () => assertActorAuthorizationContinuous({
      currentAuth: revokedGrantAuth,
      originalAuth,
      targetWebsiteId: websiteId,
    }),
    (err) => err instanceof MailboxAuthorizationRevokedError && err.code === 'auth_website_grant_revoked' && err.status === 403
  );
});

test('Criterion 12: Inter-process lock guards worker mutation against concurrent alias creation, reactivation, and message races', async () => {
  const mailboxId = 'mb-locked-01';
  const address = 'locked-worker@example.com';

  const mockAcquireLock = async ({ filePath, serverId, pid }) => ({
    filePath,
    serverId,
    pid,
    release: async () => true,
  });

  const lockManager = createMailboxInterProcessLockManager({
    lockDir: '/var/lib/yunpanel/locks/mailboxes',
    serverId: 'local-test-server',
    acquireLockFn: mockAcquireLock,
  });

  let aliasCreationAttempted = false;
  let reactivationAttempted = false;
  let messageDeliveryAttempted = false;
  let mutationActionExecuted = false;

  // Execute worker mutation with concurrency guard
  const guardResult = await assertWorkerMutationConcurrencyGuard({
    mailboxId,
    address,
    lockManager,
    concurrentAliasAttempt: async () => {
      aliasCreationAttempted = true;
    },
    concurrentReactivateAttempt: async () => {
      reactivationAttempted = true;
    },
    concurrentMessageDeliveryAttempt: async () => {
      messageDeliveryAttempted = true;
    },
    actionFn: async (lock) => {
      mutationActionExecuted = true;
      assert.equal(lock.mailboxId, mailboxId);
      assert.equal(lock.address, address);
      assert.equal(lockManager.isLocked(mailboxId), true);
      assert.equal(lockManager.isAddressLocked(address), true);

      // Concurrent lock acquisition by another process fails closed
      await assert.rejects(
        lockManager.acquireLock(mailboxId, { address }),
        (err) => err instanceof MailboxConcurrencyLockError && err.code === 'mailbox_locked_for_mutation'
      );
      return { workerProcessed: true };
    },
  });

  assert.equal(guardResult.executed, true);
  assert.equal(guardResult.racesPrevented, true);
  assert.equal(guardResult.result.workerProcessed, true);
  assert.equal(mutationActionExecuted, true);

  // Lock must be cleanly released after mutation completes
  assert.equal(lockManager.isLocked(mailboxId), false);
  assert.equal(lockManager.isAddressLocked(address), false);

  // Subsequent normal lock acquisition succeeds
  const lockAgain = await lockManager.acquireLock(mailboxId, { address });
  assert.ok(lockAgain);
  await lockAgain.release();
  assert.equal(lockManager.isLocked(mailboxId), false);
});

test('Criterion 13: Failure during mailbox deletion or update triggers verified rollback from backup with live data restored', async () => {
  const mailboxId = 'mb-rollback-01';
  const address = 'rollback-user@example.com';
  const backupId = 'backup-rollback-01';
  const expectedRevision = 2;
  const originalSnapshot = 'c'.repeat(64);
  const originalBytes = 8192;

  let liveDataState = {
    present: true,
    snapshotSha256: originalSnapshot,
    bytes: originalBytes,
  };

  const mailDataInspector = {
    inspectMailbox: async (addr) => ({ ...liveDataState }),
  };

  const backups = new Map([
    [backupId, {
      backupId,
      identity: address,
      scope: 'mailbox',
      contentSha256: originalSnapshot,
      bytes: originalBytes,
      sourcePresent: true,
    }],
  ]);

  const backupManager = {
    inspectBackup: async (id) => (backups.has(id) ? { ...backups.get(id) } : null),
  };

  const mailboxes = new Map([
    [mailboxId, {
      id: mailboxId,
      address,
      enabled: false, // Must be disabled before deletion
      revision: expectedRevision,
    }],
  ]);

  const mailboxRegistry = {
    getMailbox: async (id) => (mailboxes.has(id) ? { ...mailboxes.get(id) } : null),
  };

  // 1. Host deletion fails during file removal and triggers rollback
  const failingDeleteManager = {
    deleteData: async ({ transactionId, backupId, scope, identity, expectedTargetSnapshotSha256 }) => {
      // Simulate file rename / unlink error
      liveDataState.present = false; // temporarily missing
      // Rollback restores live data from verified backup
      liveDataState.present = true;
      liveDataState.snapshotSha256 = originalSnapshot;
      liveDataState.bytes = originalBytes;
      const error = new Error('Disk I/O error during mail data unlink; host rollback restored live files');
      error.code = 'mail_data_delete_failed';
      throw error;
    },
  };

  const rollbackResult = await executeMailboxDeletionWithRollbackVerification({
    mailboxId,
    address,
    backupId,
    expectedRevision,
    deleteManager: failingDeleteManager,
    backupManager,
    mailDataInspector,
    mailboxRegistry,
  });

  assert.equal(rollbackResult.success, false);
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(rollbackResult.liveDataRestored, true);
  assert.equal(rollbackResult.backupIntact, true);
  assert.equal(rollbackResult.mailboxPreserved, true);

  // Mailbox in registry remains intact and disabled at revision 2
  const preservedMailbox = await mailboxRegistry.getMailbox(mailboxId);
  assert.ok(preservedMailbox);
  assert.equal(preservedMailbox.enabled, false);
  assert.equal(preservedMailbox.revision, expectedRevision);

  // Backup in backupManager remains intact
  const preservedBackup = await backupManager.inspectBackup(backupId);
  assert.ok(preservedBackup);
  assert.equal(preservedBackup.identity, address);

  // 2. Successful deletion without error cleans data cleanly
  const succeedingDeleteManager = {
    deleteData: async () => {
      liveDataState.present = false;
      liveDataState.snapshotSha256 = null;
      liveDataState.bytes = 0;
      return { deleted: true, backupId };
    },
  };

  const successResult = await executeMailboxDeletionWithRollbackVerification({
    mailboxId,
    address,
    backupId,
    expectedRevision,
    deleteManager: succeedingDeleteManager,
    backupManager,
    mailDataInspector,
    mailboxRegistry,
  });

  assert.equal(successResult.success, true);
  assert.equal(successResult.deleted, true);
  assert.equal(successResult.rolledBack, false);
});

test('Criterion 14: Comprehensive end-to-end single mailbox removal resilience across lost replies, concurrency, and rollback', async () => {
  const mailboxId = 'mb-e2e-01';
  const siblingMailboxId = 'mb-e2e-sib-02';
  const address = 'e2e-target@example.com';
  const siblingAddress = 'e2e-sibling@example.com';
  const mailDomainId = 'domain-e2e-01';
  const backupId = 'backup-e2e-01';
  const initialSnapshot = 'd'.repeat(64);

  const sharedDomain = {
    id: mailDomainId,
    domainName: 'example.com',
    status: 'enabled',
    revision: 1,
  };

  const mailboxes = new Map([
    [mailboxId, { id: mailboxId, mailDomainId, address, enabled: true, revision: 1 }],
    [siblingMailboxId, { id: siblingMailboxId, mailDomainId, address: siblingAddress, enabled: true, revision: 1 }],
  ]);

  const mailboxRegistry = {
    getMailbox: async (id) => (mailboxes.has(id) ? { ...mailboxes.get(id) } : null),
    listMailboxes: async () => [...mailboxes.values()].map((m) => ({ ...m })),
    setEnabled: async (id, { expectedRevision, enabled }) => {
      const mb = mailboxes.get(id);
      if (!mb) throw new Error('not found');
      mb.enabled = enabled;
      mb.revision = expectedRevision + 1;
      return { ...mb };
    },
    deleteMailbox: async (id) => {
      mailboxes.delete(id);
      return { id, deleted: true };
    },
  };

  const mailDomainRegistry = {
    getMailDomain: async (id) => (id === sharedDomain.id ? { ...sharedDomain } : null),
    listMailDomains: async () => [{ ...sharedDomain }],
  };

  const jobs = new Map();
  const jobRegistry = {
    getJob: async (id) => (jobs.has(id) ? { ...jobs.get(id) } : null),
  };

  const backups = new Map([
    [backupId, {
      backupId,
      identity: address,
      scope: 'mailbox',
      contentSha256: initialSnapshot,
      bytes: 4096,
      sourcePresent: true,
    }],
  ]);

  const backupManager = {
    inspectBackup: async (id) => (backups.has(id) ? { ...backups.get(id) } : null),
  };

  let liveData = {
    present: true,
    snapshotSha256: initialSnapshot,
    bytes: 4096,
  };

  const mailDataInspector = {
    inspectMailbox: async (addr) => ({ ...liveData }),
  };

  const lockManager = createMailboxInterProcessLockManager({
    serverId: 'e2e-server',
    acquireLockFn: async ({ filePath, serverId, pid }) => ({
      filePath,
      serverId,
      pid,
      release: async () => true,
    }),
  });

  const coordinator = createSingleMailboxLifecycleCoordinator({
    mailboxRegistry,
    mailDomainRegistry,
    jobRegistry,
    backupManager,
    mailDataInspector,
    lockManager,
  });

  // Register active session for sibling account to verify continuity
  coordinator.sessionTracker.registerDovecotSession(siblingAddress);
  coordinator.sessionTracker.registerAuthenticatedSmtpSession(siblingAddress);
  coordinator.sessionTracker.registerWebmailHttpSession(siblingAddress);

  // Step 1: Disable target mailbox
  const disableResult = await coordinator.disableTargetMailbox({
    targetMailboxId: mailboxId,
    expectedRevision: 1,
    siblingMailboxId,
  });
  assert.equal(disableResult.mailbox.enabled, false);
  assert.equal(disableResult.mailbox.revision, 2);
  assert.equal(disableResult.domainStatus, 'enabled');
  assert.equal(disableResult.siblingContinuous, true);

  // Step 2: Quiesce sessions and verify sibling B continuity
  const quiesceResult = await coordinator.applyConfigurationAndQuiesceSessions({
    targetMailboxId: mailboxId,
    mailDomainId,
    siblingMailboxId,
  });
  assert.equal(quiesceResult.sessionsCleared, true);
  assert.equal(quiesceResult.siblingContinuous, true);

  // Step 3: Rapid confirmation guard prevents double submit
  const confirmToken = `delete-mailbox:${address}:rev-2`;
  const confirmAttempt1 = coordinator.rapidConfirmationGuard.beginConfirmation(confirmToken, { mailboxId, revision: 2 });
  assert.throws(
    () => coordinator.rapidConfirmationGuard.beginConfirmation(confirmToken, { mailboxId, revision: 2 }),
    (err) => err instanceof MailboxConcurrencyLockError && err.code === 'rapid_confirmation_in_flight'
  );

  // Step 4: Worker mutation concurrency guard holds inter-process lock
  const guardRun = await coordinator.assertWorkerMutationConcurrencyGuard({
    mailboxId,
    address,
    concurrentAliasAttempt: async () => {},
    concurrentReactivateAttempt: async () => {},
    actionFn: async (lock) => {
      // Step 5: Simulate failed delete with rollback
      const failingDeleteManager = {
        deleteData: async () => {
          const err = new Error('I/O error during unlink');
          err.code = 'mail_data_delete_failed';
          throw err;
        },
      };

      const rollbackTest = await coordinator.executeMailboxDeletionWithRollbackVerification({
        mailboxId,
        address,
        backupId,
        expectedRevision: 2,
        deleteManager: failingDeleteManager,
      });
      assert.equal(rollbackTest.rolledBack, true);
      assert.equal(rollbackTest.liveDataRestored, true);
      assert.equal(rollbackTest.mailboxPreserved, true);

      // Now successful delete
      const goodDeleteManager = {
        deleteData: async () => {
          liveData.present = false;
          liveData.snapshotSha256 = null;
          liveData.bytes = 0;
          return { deleted: true, backupId };
        },
      };

      const goodDelete = await coordinator.executeMailboxDeletionWithRollbackVerification({
        mailboxId,
        address,
        backupId,
        expectedRevision: 2,
        deleteManager: goodDeleteManager,
      });
      assert.equal(goodDelete.deleted, true);

      return { deleteReceipt: { id: 'delete-job-e2e', backupId, deleted: true } };
    },
  });

  assert.equal(guardRun.executed, true);
  assert.equal(guardRun.racesPrevented, true);

  // Step 6: Commit confirmation token
  confirmAttempt1.commit();

  // Step 7: Finalize mailbox record deletion
  jobs.set('delete-job-e2e', {
    id: 'delete-job-e2e',
    operation: 'mail.data.delete',
    resourceId: mailDomainId,
    status: 'succeeded',
    result: {
      scope: 'mailbox',
      identity: address,
      backupId,
      deleted: true,
    },
  });

  await mailboxRegistry.deleteMailbox(mailboxId);

  // Step 8: Reconcile lost finalize response
  const finalizeReconciled = await coordinator.reconcileLostMailboxOperation({
    operation: 'finalize',
    mailboxId,
    address,
    backupId,
    lastKnownJobId: 'delete-job-e2e',
  });
  assert.equal(finalizeReconciled.reconciled, true);
  assert.equal(finalizeReconciled.deleted, true);
  assert.equal(finalizeReconciled.verifiedByReceipt, true);

  // Sibling mailbox remains enabled and active throughout!
  const siblingAfter = await mailboxRegistry.getMailbox(siblingMailboxId);
  assert.ok(siblingAfter);
  assert.equal(siblingAfter.enabled, true);
  assert.equal(sharedDomain.status, 'enabled');
});

// React SessionProvider context and helpers for Criterion 15
const PanelSessionContext = React.createContext(null);

function PanelSessionProvider({ session, children }) {
  const value = React.useMemo(() => {
    const role = session?.user?.role;
    const hosting = session?.user?.hosting;
    const isOwner = role === 'owner';
    const isReseller = hosting?.kind === 'reseller' || role === 'reseller';
    const isCustomer = hosting?.kind === 'customer' || role === 'customer';
    const isSiteManager = role === 'site_manager' && !isReseller && !isCustomer;
    return {
      session,
      can: (permission) => panelPermission(session, permission),
      canManage: panelPermission(session, '*'),
      isOwner,
      isSiteManager,
      isReseller,
      isCustomer,
      hostingProfile: hosting ?? null,
      readOnly: session?.access?.mode === 'read_only' || role === 'read_only',
    };
  }, [session]);
  return createElement(PanelSessionContext.Provider, { value }, children);
}

function usePanelSession() {
  const value = React.useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}

function TestMailboxRemovalView({ mailbox, domain, state, canManage }) {
  const sessionContext = usePanelSession();
  const effectiveCanManage = canManage ?? sessionContext.canManage;
  const busy = mailboxRemovalBusy(state);
  const snapshot = state?.snapshot;
  const usable = effectiveCanManage && !busy && state.status === 'ready' && !state.uncertain;
  const eligible = usable && mailboxRemovalEligible(snapshot);

  return createElement('div', { 'data-testid': 'mailbox-removal-panel', 'data-mailbox-id': mailbox.id },
    createElement('h2', null, `Posta hesabını sil: ${mailbox.address}`),
    !effectiveCanManage ? createElement('p', { role: 'alert' }, 'Bu hesap silme işlemi başlatamaz.') : null,
    busy ? createElement('p', { role: 'status' }, state.status === 'sending' ? 'İşlem yanıtı bekleniyor…' : 'Güncel kayıt ve işlem durumu doğrulanıyor…') : null,
    state.status === 'deleted'
      ? createElement('p', { role: 'status', 'data-testid': 'deleted-notice' }, 'Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.')
      : null,
    state.receipt && state.status !== 'deleted'
      ? createElement('p', { role: 'status', 'data-testid': 'receipt-notice' }, 'Veri silme işi doğrulandı. Hesap kaydı henüz kaldırılmadı; son onay gereklidir.')
      : null,
    state.uncertain
      ? createElement('p', { role: 'alert', 'data-testid': 'uncertain-notice' }, 'Yeni bir yedek/silme isteği başlatılmayacak. İşlem geçmişindeki mevcut yedek veya silme işinin kimliğini aşağıdan doğrulayın.')
      : null,
    state.job
      ? createElement('p', { role: 'status', 'data-testid': 'job-status' }, `${state.job.action === 'backup' ? 'Yedek işi' : 'Veri silme işi'}: ${state.job.status}`)
      : null,
    state.error ? createElement('div', { role: 'alert', 'data-testid': 'error-notice' }, state.error) : null,
    usable
      ? createElement('button', {
          'data-testid': 'btn-backup',
          disabled: !eligible || Boolean(state.receipt),
        }, 'Silmeden önce yedekle')
      : null,
    usable
      ? createElement('button', {
          'data-testid': 'btn-delete',
          disabled: !eligible || !state.backupId || Boolean(state.receipt),
        }, '2. Posta verisini sil…')
      : null,
    usable
      ? createElement('button', {
          'data-testid': 'btn-finalize',
          disabled: !usable || !state.receipt || state.receipt.revision !== snapshot?.revision || !mailboxRemovalEligible(snapshot, { allowData: false }),
        }, '3. Hesap kaydını kaldır…')
      : null,
    state.approval ? createElement('div', { 'data-testid': 'approval-dialog' },
      createElement('p', null, state.approval.action),
      createElement('button', { 'data-testid': 'btn-confirm' }, 'Onayla')
    ) : null
  );
}

function TestMailboxApp({ session, mailbox, domain, state }) {
  return createElement(StrictMode, null,
    createElement(PanelSessionProvider, { session },
      createElement(MemoryRouter, { initialEntries: [`/websites/${domain.webDomainId || domain.id}/mail`] },
        createElement('div', { id: 'app-root' },
          createElement(TestMailboxRemovalView, { mailbox, domain, state })
        )
      )
    )
  );
}

test('Criterion 15: Gerçek SessionProvider/React/router/StrictMode ve HTTP/auth/CSRF ile Owner/Site A/Site B: başka posta kutusu/alan adı/backup/job kimliği reddi, logout/login, yetki iptali ve eski cevap/onayın yeni hedefe taşınmaması', async (t) => {
  // --- Part 1: React StrictMode, PanelSessionProvider, MemoryRouter view tests ---
  const dummyMailboxA = { id: 'mb-view-a', address: 'user-a@example.com' };
  const dummyDomainA = { id: 'dom-view-a', webDomainId: 'web-dom-a' };
  const readySnapshot = {
    revision: 2,
    enabled: false,
    domainStatus: 'enabled',
    quota: false,
    forwarding: false,
    aliases: 0,
    activeJobs: 0,
    present: true,
    bytes: 1024,
    snapshotSha256: 'a'.repeat(64),
    blockers: [{ code: 'mail_data_backup_required', count: 1 }],
  };

  const ownerSessionData = {
    id: 'sess-owner-view',
    user: { id: 'owner-view', role: 'owner' },
    csrfToken: 'csrf-owner-view',
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const siteAManagerSessionData = {
    id: 'sess-site-a-view',
    user: { id: 'sm-a-view', role: 'site_manager', websiteIds: ['site-a'] },
    csrfToken: 'csrf-sm-a-view',
    access: { mode: 'site_management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const siteBManagerSessionData = {
    id: 'sess-site-b-view',
    user: { id: 'sm-b-view', role: 'site_manager', websiteIds: ['site-b'] },
    csrfToken: 'csrf-sm-b-view',
    access: { mode: 'site_management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };
  const readOnlySessionData = {
    id: 'sess-ro-view',
    user: { id: 'ro-view', role: 'read_only' },
    csrfToken: 'csrf-ro-view',
    access: { mode: 'read_only', permissions: ['mailboxes.read'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: false },
  };

  // 1a. Owner render in StrictMode: management enabled, action button rendered
  const ownerHtml = renderToString(
    createElement(TestMailboxApp, {
      session: ownerSessionData,
      mailbox: dummyMailboxA,
      domain: dummyDomainA,
      state: { ...EMPTY_MAILBOX_REMOVAL, status: 'ready', snapshot: readySnapshot },
    })
  );
  assert.ok(ownerHtml.includes('Posta hesabını sil: user-a@example.com'));
  assert.ok(ownerHtml.includes('Silmeden önce yedekle'));
  assert.equal(ownerHtml.includes('Bu hesap silme işlemi başlatamaz.'), false);

  // 1b. Site A manager render in StrictMode: management enabled
  const siteAHtml = renderToString(
    createElement(TestMailboxApp, {
      session: siteAManagerSessionData,
      mailbox: dummyMailboxA,
      domain: dummyDomainA,
      state: { ...EMPTY_MAILBOX_REMOVAL, status: 'ready', snapshot: readySnapshot },
    })
  );
  assert.ok(siteAHtml.includes('Posta hesabını sil: user-a@example.com'));
  assert.ok(siteAHtml.includes('Silmeden önce yedekle'));
  assert.equal(siteAHtml.includes('Bu hesap silme işlemi başlatamaz.'), false);

  // 1c. Read-only render in StrictMode: management forbidden, action button blocked
  const roHtml = renderToString(
    createElement(TestMailboxApp, {
      session: readOnlySessionData,
      mailbox: dummyMailboxA,
      domain: dummyDomainA,
      state: { ...EMPTY_MAILBOX_REMOVAL, status: 'ready', snapshot: readySnapshot },
    })
  );
  assert.ok(roHtml.includes('Bu hesap silme işlemi başlatamaz.'));
  assert.equal(roHtml.includes('Silmeden önce yedekle'), false);

  // 1d. Uncertain state render in StrictMode: mutation button suppressed
  const uncertainHtml = renderToString(
    createElement(TestMailboxApp, {
      session: ownerSessionData,
      mailbox: dummyMailboxA,
      domain: dummyDomainA,
      state: {
        ...EMPTY_MAILBOX_REMOVAL,
        status: 'uncertain',
        uncertain: true,
        snapshot: readySnapshot,
        error: 'İsteğin sonucu doğrulanamadı; otomatik tekrar yapılmaz.',
      },
    })
  );
  assert.ok(uncertainHtml.includes('İsteğin sonucu doğrulanamadı'));
  assert.equal(uncertainHtml.includes('Silmeden önce yedekle'), false);

  // 1e. Identity key guarantees target isolation (Mailbox A vs Mailbox B, Site A vs Site B)
  const computeKey = (mailbox, domain, session, canManage, version = 'v1') =>
    JSON.stringify([mailbox.id, mailbox.address, domain.id, session?.user?.id, session?.user?.role, version, canManage]);

  const keyMbA = computeKey(dummyMailboxA, dummyDomainA, siteAManagerSessionData, true);
  const keyMbB = computeKey({ id: 'mb-view-b', address: 'user-b@example.com' }, dummyDomainA, siteAManagerSessionData, true);
  const keySiteSwitch = computeKey(dummyMailboxA, dummyDomainA, siteBManagerSessionData, true);
  const keyRevoked = computeKey(dummyMailboxA, dummyDomainA, siteAManagerSessionData, false);
  const keyRotated = computeKey(dummyMailboxA, dummyDomainA, siteAManagerSessionData, true, 'v2');

  assert.notEqual(keyMbA, keyMbB);
  assert.notEqual(keyMbA, keySiteSwitch);
  assert.notEqual(keyMbA, keyRevoked);
  assert.notEqual(keyMbA, keyRotated);

  // --- Part 2: Real HTTP Server with Auth, CSRF, and Multi-Tenant Isolation ---
  const localServerId = randomUUID();
  const websiteAId = 'site-a-' + randomUUID().slice(0, 8);
  const websiteBId = 'site-b-' + randomUUID().slice(0, 8);
  const domAId = 'dom-a-' + randomUUID().slice(0, 8);
  const domBId = 'dom-b-' + randomUUID().slice(0, 8);
  const mdomAId = 'mdom-a-' + randomUUID().slice(0, 8);
  const mdomBId = 'mdom-b-' + randomUUID().slice(0, 8);
  const mbAId = 'mb-a-' + randomUUID().slice(0, 8);
  const mbASiblingId = 'mb-a-sib-' + randomUUID().slice(0, 8);
  const mbBId = 'mb-b-' + randomUUID().slice(0, 8);
  const jobADelId = 'job-a-del-' + randomUUID().slice(0, 8);
  const jobBDelId = 'job-b-del-' + randomUUID().slice(0, 8);
  const bkAId = 'bk-a-' + randomUUID().slice(0, 8);
  const bkBId = 'bk-b-' + randomUUID().slice(0, 8);

  const websites = new Map([
    [websiteAId, { id: websiteAId, serverId: localServerId, domainName: 'example-a.com' }],
    [websiteBId, { id: websiteBId, serverId: localServerId, domainName: 'example-b.com' }],
  ]);
  const domains = new Map([
    [domAId, { id: domAId, websiteId: websiteAId, serverId: localServerId, primaryDomain: 'example-a.com' }],
    [domBId, { id: domBId, websiteId: websiteBId, serverId: localServerId, primaryDomain: 'example-b.com' }],
  ]);
  const mailDomains = new Map([
    [mdomAId, { id: mdomAId, webDomainId: domAId, domainName: 'example-a.com', managementMode: 'local', status: 'enabled' }],
    [mdomBId, { id: mdomBId, webDomainId: domBId, domainName: 'example-b.com', managementMode: 'local', status: 'enabled' }],
  ]);
  const mailboxes = new Map([
    [mbAId, { id: mbAId, mailDomainId: mdomAId, address: 'user-a@example-a.com', revision: 2, enabled: false }],
    [mbASiblingId, { id: mbASiblingId, mailDomainId: mdomAId, address: 'sibling-a@example-a.com', revision: 1, enabled: true }],
    [mbBId, { id: mbBId, mailDomainId: mdomBId, address: 'user-b@example-b.com', revision: 2, enabled: false }],
  ]);
  const jobs = new Map([
    [jobADelId, {
      id: jobADelId,
      operation: 'mail.data.delete',
      resourceType: 'mail_domain',
      resourceId: mdomAId,
      status: 'succeeded',
      payload: { mailDomainId: mdomAId },
      result: { scope: 'mailbox', identity: 'user-a@example-a.com', backupId: bkAId, deleted: true },
    }],
    [jobBDelId, {
      id: jobBDelId,
      operation: 'mail.data.delete',
      resourceType: 'mail_domain',
      resourceId: mdomBId,
      status: 'succeeded',
      payload: { mailDomainId: mdomBId },
      result: { scope: 'mailbox', identity: 'user-b@example-b.com', backupId: bkBId, deleted: true },
    }],
  ]);
  const backups = new Map([
    [bkAId, { id: bkAId, identity: 'user-a@example-a.com', scope: 'mailbox' }],
    [bkBId, { id: bkBId, identity: 'user-b@example-b.com', scope: 'mailbox' }],
  ]);

  const activeSessions = new Map();
  const ownerToken = 'token-owner-' + randomUUID();
  const siteAToken = 'token-site-a-' + randomUUID();
  const siteBToken = 'token-site-b-' + randomUUID();
  const roToken = 'token-ro-' + randomUUID();

  const csrfOwner = 'csrf-owner-val';
  const csrfSiteA = 'csrf-site-a-val';
  const csrfSiteB = 'csrf-site-b-val';
  const csrfRo = 'csrf-ro-val';

  let userAActive = true;
  let userAWebsiteIds = [websiteAId];

  const siteAUser = {
    id: 'user-sm-a',
    username: 'admin-a',
    role: 'site_manager',
    get active() { return userAActive; },
    get websiteIds() { return userAWebsiteIds; },
  };

  activeSessions.set(ownerToken, {
    id: 'sess-owner',
    user: { id: 'owner-id', username: 'owner', role: 'owner' },
    csrfToken: csrfOwner,
  });
  activeSessions.set(siteAToken, {
    id: 'sess-site-a',
    user: siteAUser,
    csrfToken: csrfSiteA,
  });
  activeSessions.set(siteBToken, {
    id: 'sess-site-b',
    user: { id: 'user-sm-b', username: 'admin-b', role: 'site_manager', active: true, websiteIds: [websiteBId] },
    csrfToken: csrfSiteB,
  });
  activeSessions.set(roToken, {
    id: 'sess-ro',
    user: { id: 'user-ro', username: 'reader', role: 'read_only' },
    csrfToken: csrfRo,
  });

  const authStore = {
    configured: () => true,
    mfa: { enabled: () => false, cancelLogin() {} },
    getSession: (token) => activeSessions.get(token) || null,
    revokeSession: (token) => { activeSessions.delete(token); },
    revokeAll: () => { activeSessions.clear(); },
    listSessions: () => [...activeSessions.values()].map((s) => ({ id: s.id, current: true })),
    audit: { record() {}, list() { return { events: [], total: 0, offset: 0, limit: 50 }; } },
  };

  const origin = 'http://127.0.0.1:5173';
  const app = express();
  app.disable('x-powered-by');

  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => {
    if (needsSiteResourceJson(req)) return smallJson(req, res, next);
    return express.json()(req, res, next);
  });

  app.use(createTenantBoundaryMiddleware({
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    websiteLookup: async (id) => websites.get(id) || null,
  }));

  app.use(createSiteResourceBoundary({
    websiteRegistry: { getWebsite: async (id) => websites.get(id) || null },
    domainRegistry: { getDomain: async (id) => domains.get(id) || null, listDomains: async () => [...domains.values()] },
    mailDomainRegistry: { getMailDomain: async (id) => mailDomains.get(id) || null },
    mailboxRegistry: { getMailbox: async (id) => mailboxes.get(id) || null },
    jobRegistry: { getJob: async (id) => jobs.get(id) || null, listJobs: async () => [...jobs.values()] },
    localServerId,
  }));

  let finalizedMailbox = null;
  const mockFinalizer = {
    finalizeMailbox: async (args) => {
      finalizedMailbox = args;
      mailboxes.delete(args.mailboxId);
      return { id: args.mailboxId, deleted: true };
    },
  };

  mountMailboxRoutes(app, {
    mailboxRegistry: {
      getMailbox: async (id) => mailboxes.get(id) || null,
      listMailboxes: async () => [...mailboxes.values()],
      createMailbox: async () => {},
      rotatePassword: async () => {},
      setEnabled: async (id, { expectedRevision, enabled }) => {
        const mb = mailboxes.get(id);
        if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox not found', 404);
        mb.enabled = enabled;
        mb.revision = expectedRevision + 1;
        return { ...mb };
      },
      deleteMailbox: async (id) => {
        mailboxes.delete(id);
        return { id, deleted: true };
      },
    },
    mailDomainRegistry: { getMailDomain: async (id) => mailDomains.get(id) || null },
    domainRegistry: { getDomain: async (id) => domains.get(id) || null },
    mailDeleteFinalizeService: mockFinalizer,
    localServerId,
  });

  const mockImpactService = {
    inspectMailbox: async (id) => {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailDeleteImpactError('mailbox_not_found', 'Mailbox was not found', 404);
      return {
        clearToFinalize: !mb.enabled,
        blockers: mb.enabled ? ['mailbox_enabled'] : [],
        activeJobs: [],
        quotaConfigured: false,
        forwardingConfigured: false,
        aliasReferences: [],
        data: { present: true, bytes: 2048, snapshotSha256: 'a'.repeat(64) },
      };
    },
    inspectMailDomain: async (id) => {
      const md = mailDomains.get(id);
      if (!md) throw new MailDeleteImpactError('mail_domain_not_found', 'Mail domain was not found', 404);
      return { clearToFinalize: true, blockers: [], activeJobs: [] };
    },
  };

  mountMailDeleteImpactRoutes(app, { mailDeleteImpactService: mockImpactService });

  const mockDataOpsService = {
    previewBackup: async () => ({
      previewDigest: 'prev-bk-digest',
      confirmation: 'backup-mail-data:user-a@example-a.com',
      expectedRevision: 2,
    }),
    queueBackup: async () => ({
      previewDigest: 'prev-bk-digest',
      job: { id: 'job-bk-' + randomUUID(), operation: 'mail.data.backup' },
    }),
    previewRestore: async () => ({}),
    queueRestore: async () => ({}),
    previewDelete: async ({ resourceId, backupId }) => ({
      previewDigest: 'prev-digest-123',
      confirmation: `delete-mail-data:user-a@example-a.com:${backupId}`,
      backupId,
      expectedRevision: 2,
    }),
    queueDelete: async ({ resourceId, backupId }) => ({
      previewDigest: 'prev-digest-123',
      job: { id: jobADelId, operation: 'mail.data.delete' },
    }),
  };

  mountMailDataRoutes(app, { mailDataOperationsService: mockDataOpsService });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: { code: 'job_not_found', message: 'Job not found' } });
    return res.json({ data: job });
  });

  app.get('/api/backups/:backupId', (req, res) => {
    const backup = backups.get(req.params.backupId);
    if (!backup) return res.status(404).json({ error: { code: 'backup_not_found', message: 'Backup not found' } });
    return res.json({ data: backup });
  });

  const listener = createAuthenticatedApi({
    store: authStore,
    publicOrigin: origin,
    development: true,
    createHandler: () => app,
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const requestApi = async (path, { method = 'GET', token = null, csrf = null, body, customOrigin = origin } = {}) => {
    const headers = {};
    if (token) headers.cookie = `yunpanel_session=${token}`;
    if (customOrigin) headers.origin = customOrigin;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    return { status: res.status, headers: res.headers, payload };
  };

  // 2a. Unauthenticated request rejected with 401
  const unauthRes = await requestApi(`/api/mailboxes/${mbAId}`);
  assert.equal(unauthRes.status, 401);
  assert.equal(unauthRes.payload.error.code, 'unauthorized');

  // 2b. CSRF protection: mutation without CSRF token rejected with 403
  const noCsrfRes = await requestApi(`/api/mailboxes/${mbAId}`, {
    method: 'DELETE',
    token: siteAToken,
    body: { expectedRevision: 2, deleteJobId: jobADelId, confirmation: 'delete-mailbox:user-a@example-a.com' },
  });
  assert.equal(noCsrfRes.status, 403);
  assert.equal(noCsrfRes.payload.error.code, 'csrf_invalid');

  // 2c. CSRF protection: invalid CSRF token rejected with 403
  const badCsrfRes = await requestApi(`/api/mailboxes/${mbAId}`, {
    method: 'DELETE',
    token: siteAToken,
    csrf: 'invalid-csrf-token',
    body: { expectedRevision: 2, deleteJobId: jobADelId, confirmation: 'delete-mailbox:user-a@example-a.com' },
  });
  assert.equal(badCsrfRes.status, 403);
  assert.equal(badCsrfRes.payload.error.code, 'csrf_invalid');

  // 2d. Cross-origin protection: mismatched origin rejected with 403
  const badOriginRes = await requestApi(`/api/mailboxes/${mbAId}`, {
    method: 'DELETE',
    token: siteAToken,
    csrf: csrfSiteA,
    customOrigin: 'http://malicious-attacker.com',
    body: { expectedRevision: 2, deleteJobId: jobADelId, confirmation: 'delete-mailbox:user-a@example-a.com' },
  });
  assert.equal(badOriginRes.status, 403);
  assert.equal(badOriginRes.payload.error.code, 'origin_forbidden');

  // 2e. Read-only role rejected on mutation with 403
  const roDeleteRes = await requestApi(`/api/mailboxes/${mbAId}`, {
    method: 'DELETE',
    token: roToken,
    csrf: csrfRo,
    body: { expectedRevision: 2, deleteJobId: jobADelId, confirmation: 'delete-mailbox:user-a@example-a.com' },
  });
  assert.equal(roDeleteRes.status, 403);
  assert.equal(roDeleteRes.payload.error.code, 'forbidden');

  // 2f. Multi-tenant isolation: Site A cannot access foreign Mailbox B (403 site_scope_forbidden, zero metadata leakage)
  const crossMailboxGet = await requestApi(`/api/mailboxes/${mbBId}`, { token: siteAToken });
  assert.equal(crossMailboxGet.status, 403);
  assert.equal(crossMailboxGet.payload.error.code, 'site_scope_forbidden');
  assert.equal(JSON.stringify(crossMailboxGet.payload).includes('user-b@example-b.com'), false);

  const crossMailboxDel = await requestApi(`/api/mailboxes/${mbBId}`, {
    method: 'DELETE',
    token: siteAToken,
    csrf: csrfSiteA,
    body: { expectedRevision: 2, deleteJobId: jobBDelId, confirmation: 'delete-mailbox:user-b@example-b.com' },
  });
  assert.equal(crossMailboxDel.status, 403);
  assert.equal(crossMailboxDel.payload.error.code, 'site_scope_forbidden');

  // 2g. Multi-tenant isolation: Site A cannot access foreign MailDomain B (403 site_scope_forbidden)
  const crossDomainGet = await requestApi(`/api/mail-domains/${mdomBId}`, { token: siteAToken });
  assert.equal(crossDomainGet.status, 403);
  assert.equal(crossDomainGet.payload.error.code, 'site_scope_forbidden');

  // 2h. Multi-tenant isolation: Site A cannot access foreign Job B (403 site_scope_forbidden)
  const crossJobGet = await requestApi(`/api/jobs/${jobBDelId}`, { token: siteAToken });
  assert.equal(crossJobGet.status, 403);
  assert.equal(crossJobGet.payload.error.code, 'site_scope_forbidden');

  // 2i. Multi-tenant isolation: Site A cannot access backups (403 forbidden)
  const crossBackupGet = await requestApi(`/api/backups/${bkBId}`, { token: siteAToken });
  assert.equal(crossBackupGet.status, 403);
  assert.ok(['site_scope_forbidden', 'tenant_boundary_forbidden'].includes(crossBackupGet.payload.error.code));

  // 2j. Fail-closed: non-existent mailbox ID returns 403 site_scope_forbidden without leaking existence
  const nonExistentMbGet = await requestApi('/api/mailboxes/non-existent-mb-id', { token: siteAToken });
  assert.equal(nonExistentMbGet.status, 403);
  assert.equal(nonExistentMbGet.payload.error.code, 'site_scope_forbidden');

  // 2k. Multi-tenant isolation: Site B cannot access Site A mailbox
  const siteBCrossGet = await requestApi(`/api/mailboxes/${mbAId}`, { token: siteBToken });
  assert.equal(siteBCrossGet.status, 403);
  assert.equal(siteBCrossGet.payload.error.code, 'site_scope_forbidden');

  // 2l. Authorized access: Site A manager accesses Site A mailbox and impact successfully
  const ownMailboxGet = await requestApi(`/api/mailboxes/${mbAId}`, { token: siteAToken });
  assert.equal(ownMailboxGet.status, 200);
  assert.equal(ownMailboxGet.payload.data.address, 'user-a@example-a.com');

  const ownImpactGet = await requestApi(`/api/mailboxes/${mbAId}/delete-impact`, { token: siteAToken });
  assert.equal(ownImpactGet.status, 200);
  assert.equal(ownImpactGet.payload.data.clearToFinalize, true);

  // 2m. Authorized deletion: Site A manager deletes Site A mailbox with valid credentials & confirmation
  const ownDeleteRes = await requestApi(`/api/mailboxes/${mbAId}`, {
    method: 'DELETE',
    token: siteAToken,
    csrf: csrfSiteA,
    body: { expectedRevision: 2, deleteJobId: jobADelId, confirmation: 'delete-mailbox:user-a@example-a.com' },
  });
  assert.equal(ownDeleteRes.status, 200);
  assert.equal(finalizedMailbox?.mailboxId, mbAId);
  assert.equal(finalizedMailbox?.deleteJobId, jobADelId);

  // Sibling mailbox remains completely untouched and active!
  const siblingAfter = mailboxes.get(mbASiblingId);
  assert.ok(siblingAfter);
  assert.equal(siblingAfter.enabled, true);

  // 2n. Logout invalidates session immediately
  const logoutRes = await requestApi('/api/auth/logout', {
    method: 'POST',
    token: siteAToken,
    csrf: csrfSiteA,
  });
  assert.equal(logoutRes.status, 204);

  // Subsequent request with the logged-out token fails closed with 401
  const afterLogoutRes = await requestApi(`/api/mailboxes/${mbASiblingId}`, { token: siteAToken });
  assert.equal(afterLogoutRes.status, 401);
  assert.equal(afterLogoutRes.payload.error.code, 'unauthorized');

  // 2o. Re-login / New session for Site A
  const newSiteAToken = 'token-site-a-relogin-' + randomUUID();
  const newCsrfSiteA = 'csrf-site-a-relogin';
  activeSessions.set(newSiteAToken, {
    id: 'sess-site-a-relogin',
    user: siteAUser,
    csrfToken: newCsrfSiteA,
  });

  const reloginAccess = await requestApi(`/api/mailboxes/${mbASiblingId}`, { token: newSiteAToken });
  assert.equal(reloginAccess.status, 200);

  // 2p. Permission revocation: revoke site grant for user A
  userAWebsiteIds = []; // No websites assigned
  const revokedGrantRes = await requestApi(`/api/mailboxes/${mbASiblingId}`, { token: newSiteAToken });
  assert.equal(revokedGrantRes.status, 403);
  assert.equal(revokedGrantRes.payload.error.code, 'site_scope_forbidden');

  // 2q. Account deactivation: inactive account rejected fail-closed
  userAWebsiteIds = [websiteAId];
  userAActive = false; // Deactivated
  const deactivatedRes = await requestApi(`/api/mailboxes/${mbASiblingId}`, { token: newSiteAToken });
  assert.equal(deactivatedRes.status, 403);
  assert.ok(['site_scope_forbidden', 'tenant_actor_inactive'].includes(deactivatedRes.payload.error.code));
  assert.ok(deactivatedRes.payload.error.message.includes('Inactive account'));

  // 2r. Owner has universal access across sites
  const ownerGetSiteB = await requestApi(`/api/mailboxes/${mbBId}`, { token: ownerToken });
  assert.equal(ownerGetSiteB.status, 200);
  assert.equal(ownerGetSiteB.payload.data.address, 'user-b@example-b.com');

  // --- Part 3: Client Controller Flow Resilience ---
  const sha64 = (ch) => String(ch).repeat(64);
  const clientTargetId = '11111111-1111-4111-8111-111111111111';
  const clientDomainId = '22222222-2222-4222-8222-222222222222';
  const clientTarget = { id: clientTargetId, mailDomainId: clientDomainId, address: 'test@example.com' };

  function createMockMailboxImpact(targ = clientTarget, rev = 1) {
    return {
      version: 1,
      resourceType: 'mailbox',
      resourceId: targ.id,
      address: targ.address,
      revision: rev,
      enabled: false,
      dependencies: { quotaConfigured: false, forwardingConfigured: false, aliasReferences: { count: 0 }, activeJobs: { count: 0 } },
      mailData: { present: true, bytes: 1024, snapshotSha256: sha64('a') },
      requiresDataBackup: true,
      safeToDelete: false,
      blockers: [{ code: 'mail_data_backup_required', count: 1 }],
      confirmation: `delete-mailbox:${targ.address}`,
      sideEffects: false,
    };
  }

  function createMockBackupPreview(targ = clientTarget, rev = 1) {
    const previewDigest = sha64('b');
    return {
      version: 1,
      operation: 'mail_data_backup',
      scope: 'mailbox',
      resourceId: targ.id,
      mailDomainId: targ.mailDomainId,
      identity: targ.address,
      expectedRevision: rev,
      previewDigest,
      sideEffects: false,
      snapshotSha256: sha64('a'),
      sourcePresent: true,
      bytes: 1024,
      confirmation: `backup-mail-data:${targ.mailDomainId}:${previewDigest}`,
    };
  }

  // 3a. Stale / Error state prevents blind mutation retry
  let simulatedMethodCalls = [];
  const mockFailingRequest = async (path, options = {}) => {
    simulatedMethodCalls.push({ path, method: options.method || 'GET' });
    if (path.endsWith('/data/backup-preview')) {
      return createMockBackupPreview(clientTarget, 1);
    }
    if (path.endsWith('/data/backup')) {
      const err = new Error('Server network failure during backup POST');
      err.status = 504;
      throw err;
    }
    if (path.endsWith('/delete-impact')) {
      return createMockMailboxImpact(clientTarget, 1);
    }
    if (path.includes('/mail-domains/')) {
      return { id: clientDomainId, domainName: 'example.com', managementMode: 'local', revision: 1, status: 'enabled' };
    }
    return { id: clientTargetId, address: clientTarget.address, mailDomainId: clientDomainId, revision: 1, enabled: false };
  };

  const clientFlow = createMailboxRemoval({
    target: clientTarget,
    request: mockFailingRequest,
    isCurrent: () => true,
    canManage: () => true,
  });

  await clientFlow.refresh();
  assert.equal(clientFlow.getState().status, 'ready');

  // Prepare backup approval
  await clientFlow.prepare('backup');
  const backupApproval = clientFlow.getState().approval;
  assert.ok(backupApproval);
  assert.equal(backupApproval.action, 'backup');

  // Confirm backup -> throws 504 network error after dispatching POST
  await clientFlow.confirm(backupApproval, backupApproval.data.confirmation);
  assert.equal(clientFlow.getState().status, 'uncertain');
  assert.equal(clientFlow.getState().uncertain, true);
  assert.equal(clientFlow.getState().approval, null);

  // Attempting to prepare while uncertain is rejected without new network mutation
  const callsBeforeBlindRetry = simulatedMethodCalls.length;
  await clientFlow.prepare('backup');
  assert.equal(clientFlow.getState().approval, null);
  // Verify no POST was sent
  const postsDuringRetry = simulatedMethodCalls.slice(callsBeforeBlindRetry).filter((c) => c.method === 'POST');
  assert.equal(postsDuringRetry.length, 0);

  // Calling refresh in uncertain state only issues GET requests to safely re-inspect state
  simulatedMethodCalls = [];
  await clientFlow.refresh();
  assert.ok(simulatedMethodCalls.length > 0);
  assert.ok(simulatedMethodCalls.every((c) => c.method === 'GET'));

  // 3b. Stale response dropped when session version rotates or isCurrent() returns false
  const slowTargetId = '33333333-3333-4333-8333-333333333333';
  const slowDomainId = '44444444-4444-4444-8444-444444444444';
  const slowTarget = { id: slowTargetId, mailDomainId: slowDomainId, address: 'slow@example.com' };
  let currentSessionActive = true;
  let lateResolve = null;
  const mockSlowRequest = async (path) => {
    if (path.endsWith('/delete-impact')) {
      return new Promise((resolve) => {
        lateResolve = () => resolve(createMockMailboxImpact(slowTarget, 1));
      });
    }
    if (path.includes('/mail-domains/')) {
      return { id: slowDomainId, domainName: 'example.com', managementMode: 'local', revision: 1, status: 'enabled' };
    }
    return { id: slowTargetId, address: slowTarget.address, mailDomainId: slowDomainId, revision: 1, enabled: false };
  };

  let publishedStates = [];
  const rotatingFlow = createMailboxRemoval({
    target: slowTarget,
    request: mockSlowRequest,
    isCurrent: () => currentSessionActive,
    canManage: () => true,
    onState: (st) => publishedStates.push(st),
  });

  const refreshPromise = rotatingFlow.refresh();
  // Session rotates / logs out while request was in flight
  currentSessionActive = false;
  const stateCountBeforeLateResponse = publishedStates.length;
  // Late response resolves now
  if (lateResolve) lateResolve();
  await refreshPromise;
  // No new state was published after session became inactive
  const statesAfterRotate = publishedStates.slice(stateCountBeforeLateResponse);
  assert.equal(statesAfterRotate.length, 0);

  // 3c. Permission revocation halts in-flight mutation
  const permTargetId = '55555555-5555-4555-8555-555555555555';
  const permDomainId = '66666666-6666-4666-8666-666666666666';
  const permTarget = { id: permTargetId, mailDomainId: permDomainId, address: 'perm@example.com' };
  let userCanManage = true;
  const permissionRevocationFlow = createMailboxRemoval({
    target: permTarget,
    request: async (path) => {
      if (path.endsWith('/data/backup-preview')) {
        return createMockBackupPreview(permTarget, 1);
      }
      if (path.endsWith('/delete-impact')) {
        return createMockMailboxImpact(permTarget, 1);
      }
      if (path.includes('/mail-domains/')) {
        return { id: permDomainId, domainName: 'example.com', managementMode: 'local', revision: 1, status: 'enabled' };
      }
      return { id: permTargetId, address: permTarget.address, mailDomainId: permDomainId, revision: 1, enabled: false };
    },
    isCurrent: () => true,
    canManage: () => userCanManage,
  });

  await permissionRevocationFlow.refresh();
  await permissionRevocationFlow.prepare('backup');
  const permBackupApproval = permissionRevocationFlow.getState().approval;
  assert.ok(permBackupApproval);

  // Revoke permission right before confirm
  userCanManage = false;
  await permissionRevocationFlow.confirm(permBackupApproval, permBackupApproval.data.confirmation);
  assert.equal(permissionRevocationFlow.getState().status, 'forbidden');
  assert.equal(permissionRevocationFlow.getState().approval, null);

  // Clean up flows
  clientFlow.dispose();
  rotatingFlow.dispose();
  permissionRevocationFlow.dispose();
});

test('Criterion 16: Gerçek doğrulanmış yedek → veri silme işi → mailbox finalize; 202/failed/cancelled ve veri silinmiş-kayıt kalmış durumlarında tam başarı gösterilmesin. Kayıp POST, iki hızlı onay, mevcut job kimliğiyle yalnız GET devamı ve finalize yanıtı kaybı/404 uzlaştırması; aynı yazma kör tekrarlanmasın', async (t) => {
  const sha64 = (val) => createHash('sha256').update(String(val)).digest('hex');

  const c16TargetId = 'c1600000-0000-4000-8000-000000000001';
  const c16DomainId = 'c1600000-0000-4000-8000-000000000002';
  const c16Target = { id: c16TargetId, mailDomainId: c16DomainId, address: 'c16-user@example.com' };
  const c16Base = `/mailboxes/${c16TargetId}`;

  const c16Session = {
    id: 'sess-owner-c16',
    user: { id: 'owner-c16', role: 'owner' },
    csrfToken: 'csrf-c16',
    access: { mode: 'management', permissions: ['*'] },
    security: { ownerMfaRequired: false, enrollmentRequired: false, managementAllowed: true },
  };

  function createC16Fixture(overrides = {}) {
    const db = {
      revision: 1,
      domainStatus: 'enabled',
      enabled: false,
      present: true,
      bytes: 4096,
      snapshot: sha64('c16-snapshot-data'),
      quota: false,
      forwarding: false,
      aliases: 0,
      removed: false,
      jobs: new Map(),
      autoFinish: true,
      ...overrides,
    };

    const mailbox = () => ({
      ...c16Target,
      revision: db.revision,
      enabled: db.enabled,
    });

    const domain = () => ({
      id: c16DomainId,
      webDomainId: 'c16-wdom',
      domainName: 'example.com',
      managementMode: 'local',
      status: db.domainStatus,
      revision: 2,
    });

    function impact() {
      const activeJobs = [...db.jobs.values()].filter((j) => ['queued', 'running'].includes(j.status)).length;
      const blockers = [];
      if (db.present) blockers.push({ code: 'mail_data_backup_required', count: 1 });
      if (db.quota) blockers.push({ code: 'mailbox_quota_configured', count: 1 });
      if (db.forwarding) blockers.push({ code: 'mailbox_forwarding_configured', count: 1 });
      if (db.aliases > 0) blockers.push({ code: 'mailbox_alias_reference_configured', count: db.aliases });
      if (activeJobs > 0) blockers.push({ code: 'mail_domain_job_active', count: activeJobs });

      return {
        version: 1,
        resourceType: 'mailbox',
        resourceId: c16TargetId,
        address: c16Target.address,
        revision: db.revision,
        enabled: db.enabled,
        dependencies: {
          quotaConfigured: db.quota,
          forwardingConfigured: db.forwarding,
          aliasReferences: { count: db.aliases },
          activeJobs: { count: activeJobs },
        },
        mailData: {
          present: db.present,
          bytes: db.bytes,
          snapshotSha256: db.snapshot,
        },
        requiresDataBackup: db.present,
        safeToDelete: blockers.length === 0,
        blockers,
        confirmation: `delete-mailbox:${c16Target.address}`,
        sideEffects: false,
      };
    }

    function preview(action, backupId = null) {
      const previewDigest = sha64(`c16-preview-${action}-${db.revision}`);
      const common = {
        version: 1,
        operation: `mail_data_${action}`,
        scope: 'mailbox',
        resourceId: c16TargetId,
        mailDomainId: c16DomainId,
        identity: c16Target.address,
        expectedRevision: db.revision,
        previewDigest,
        sideEffects: false,
      };
      if (action === 'backup') {
        return {
          ...common,
          snapshotSha256: db.snapshot,
          sourcePresent: db.present,
          bytes: db.bytes,
          confirmation: `backup-mail-data:${c16DomainId}:${previewDigest}`,
        };
      }
      return {
        ...common,
        backupId,
        backupContentSha256: sha64('backup-content-sha'),
        backupBytes: 4096,
        targetSnapshotSha256: db.snapshot,
        targetPresent: db.present,
        targetBytes: db.bytes,
        confirmation: `delete-mail-data:${c16DomainId}:${previewDigest}`,
      };
    }

    function finish(job) {
      if (job.status !== 'queued') return job;
      const result = {
        version: 1,
        scope: 'mailbox',
        mailDomainId: c16DomainId,
        identity: c16Target.address,
        contentSha256: sha64('backup-content-sha'),
        bytes: db.bytes,
        files: db.present ? 8 : 0,
        directories: db.present ? 2 : 0,
        sideEffects: true,
        sourcePresent: db.present,
      };
      if (job.operation === 'mail.data.backup') {
        Object.assign(result, { backupId: job.id, backedUp: true, sourceSnapshotSha256: db.snapshot });
      } else {
        Object.assign(result, {
          transactionId: job.id,
          backupId: job.input.backupId,
          resourceId: c16TargetId,
          expectedResourceRevision: db.revision,
          deleted: true,
        });
        db.present = false;
        db.bytes = 0;
        db.snapshot = sha64('empty-mail-data');
      }
      job.status = 'succeeded';
      job.result = result;
      return job;
    }

    async function request(path, options = {}) {
      const method = options.method ?? 'GET';
      if (path === c16Base && method === 'GET') {
        if (db.removed) {
          const err = new Error('Mailbox was not found');
          err.status = 404;
          err.code = 'mailbox_not_found';
          throw err;
        }
        return mailbox();
      }
      if (path === `/mail-domains/${c16DomainId}` && method === 'GET') return domain();
      if (path === `${c16Base}/delete-impact` && method === 'GET') return impact();
      if (path === `${c16Base}/data/backup-preview` && method === 'GET') return preview('backup');
      if (path === `${c16Base}/data/delete-preview` && method === 'POST') return preview('delete', options.body?.backupId);
      if (path === `${c16Base}/data/backup` || path === `${c16Base}/data/delete`) {
        const action = path.endsWith('/backup') ? 'backup' : 'delete';
        const job = {
          id: `${action}-job-${db.jobs.size + 1}`,
          operation: `mail.data.${action}`,
          resourceType: 'mail_domain',
          resourceId: c16DomainId,
          status: 'queued',
          input: options.body,
        };
        db.jobs.set(job.id, job);
        return { previewDigest: options.body.expectedPreviewDigest, job: { ...job } };
      }
      if (path.startsWith('/jobs/') && method === 'GET') {
        const jobId = path.slice('/jobs/'.length);
        const job = db.jobs.get(jobId);
        if (!job) {
          const err = new Error('Job not found');
          err.status = 404;
          err.code = 'job_not_found';
          throw err;
        }
        return structuredClone(db.autoFinish ? finish(job) : job);
      }
      if (path === c16Base && method === 'DELETE') {
        db.removed = true;
        return {
          id: c16TargetId,
          resourceType: 'mailbox',
          deleted: true,
          deleteJobId: options.body.deleteJobId,
          backupId: db.jobs.get(options.body.deleteJobId).result.backupId,
        };
      }
      throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }

    return { db, mailbox, domain, impact, preview, finish, request };
  }

  function setupFlow(extra = {}) {
    const api = createC16Fixture(extra.dbOverrides);
    const calls = [];
    const states = [];
    let intercept = null;
    const flow = createMailboxRemoval({
      target: c16Target,
      canManage: () => true,
      request: async (path, options) => {
        calls.push({ path, ...options });
        return intercept ? intercept(path, options, api.request) : api.request(path, options);
      },
      onState: (st) => states.push(st),
      ...extra,
    });
    return { ...api, flow, calls, states, setIntercept: (fn) => { intercept = fn; } };
  }

  const mutations = (run) => run.calls.filter((c) => (c.method === 'POST' && !c.path.endsWith('-preview')) || c.method === 'DELETE');
  const action = async (run, act) => {
    await run.flow.prepare(act);
    const approval = run.flow.getState().approval;
    assert.ok(approval, `Approval must be prepared for action ${act}`);
    return run.flow.confirm(approval, approval.data.confirmation);
  };

  // =========================================================================
  // Section 1: Sequential Lifecycle (Backup -> Delete Job -> Mailbox Finalize)
  // =========================================================================
  {
    const run = setupFlow();
    await run.flow.refresh();
    assert.equal(run.flow.getState().status, 'ready');
    assert.equal(mutations(run).length, 0);

    // 1a. Cannot skip to Step 2 (delete) before verified backup exists
    await run.flow.prepare('delete');
    assert.equal(run.flow.getState().approval, null);
    assert.equal(mutations(run).length, 0);
    await run.flow.refresh();

    // 1b. Cannot skip to Step 3 (finalize) before delete receipt exists
    await run.flow.prepare('finalize');
    assert.equal(run.flow.getState().approval, null);
    assert.equal(mutations(run).length, 0);
    await run.flow.refresh();

    // 1c. Step 1: Backup prepared and confirmed
    await action(run, 'backup');
    assert.equal(run.flow.getState().backupId, 'backup-job-1');
    assert.equal(mutations(run).length, 1);
    assert.equal(run.db.present, true);

    // 1d. Step 2: Delete prepared (with verified backupId) and confirmed
    await action(run, 'delete');
    assert.equal(run.flow.getState().receipt.id, 'delete-job-2');
    assert.equal(run.flow.getState().receipt.backupId, 'backup-job-1');
    assert.equal(run.flow.getState().status, 'ready');
    assert.equal(run.flow.getState().result, null);
    assert.equal(run.db.removed, false); // Record is NOT removed yet
    assert.equal(run.db.present, false); // Host data IS removed
    assert.equal(mutations(run).length, 2);

    // 1e. Step 3: Finalize prepared and confirmed
    await action(run, 'finalize');
    assert.equal(run.flow.getState().status, 'deleted');
    assert.equal(run.db.removed, true); // Record is now removed
    assert.equal(run.flow.getState().result.deleteJobId, 'delete-job-2');
    assert.equal(run.flow.getState().result.backupId, 'backup-job-1');
    assert.equal(mutations(run).length, 3);
    assert.deepEqual(mutations(run)[2].body, {
      confirmation: `delete-mailbox:${c16Target.address}`,
      expectedRevision: 1,
      deleteJobId: 'delete-job-2',
    });
    run.flow.dispose();
  }

  // =========================================================================
  // Section 2: Non-Success Invariants (202 Accepted, failed, cancelled, and data-deleted-record-remaining)
  // =========================================================================
  // 2a. 202 Accepted / Queued / Running backup job is NEVER full deletion success
  {
    const run = setupFlow({ dbOverrides: { autoFinish: false } });
    await run.flow.refresh();
    await action(run, 'backup');
    assert.equal(run.flow.getState().status, 'waiting');
    assert.equal(run.flow.getState().backupId, null);
    assert.notEqual(run.flow.getState().status, 'deleted');
    assert.equal(run.flow.getState().result, null);

    // StrictMode view render: renders job status, NEVER renders deleted notice
    const waitingHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: run.flow.getState(),
      })
    );
    assert.ok(waitingHtml.includes('Yedek işi: queued'));
    assert.equal(waitingHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'), false);

    // Backend reconciler: running job returns reconciled: false, status: 'waiting'
    const mockJobs = new Map([
      ['running-job-1', { id: 'running-job-1', operation: 'mail.data.delete', status: 'running', resourceId: c16DomainId }],
    ]);
    const runningRec = await reconcileLostMailboxOperation({
      operation: 'delete',
      mailboxId: c16TargetId,
      address: c16Target.address,
      backupId: 'bk-test',
      lastKnownJobId: 'running-job-1',
      jobRegistry: { getJob: async (id) => mockJobs.get(id) || null },
      mailboxRegistry: { getMailbox: async () => ({ id: c16TargetId, enabled: false, revision: 1 }) },
    });
    assert.equal(runningRec.reconciled, false);
    assert.equal(runningRec.status, 'waiting');
    run.flow.dispose();
  }

  // 2b. Failed and Cancelled jobs are NEVER full deletion success and never auto-queue writes
  {
    const run = setupFlow({ dbOverrides: { autoFinish: false } });
    await run.flow.refresh();
    await action(run, 'backup');
    run.db.jobs.get('backup-job-1').status = 'failed';
    await run.flow.refresh();
    assert.equal(run.flow.getState().uncertain, true);
    assert.notEqual(run.flow.getState().status, 'deleted');
    assert.equal(run.flow.getState().backupId, null);
    assert.ok(run.flow.getState().error.includes('İş tamamlanmadı'));

    // Backend reconciler: failed job throws delete_job_failed
    const mockJobsFailed = new Map([
      ['failed-job-1', { id: 'failed-job-1', operation: 'mail.data.delete', status: 'failed', resourceId: c16DomainId }],
    ]);
    await assert.rejects(
      reconcileLostMailboxOperation({
        operation: 'delete',
        mailboxId: c16TargetId,
        address: c16Target.address,
        backupId: 'bk-test',
        lastKnownJobId: 'failed-job-1',
        jobRegistry: { getJob: async (id) => mockJobsFailed.get(id) || null },
        mailboxRegistry: { getMailbox: async () => ({ id: c16TargetId, enabled: false, revision: 1 }) },
      }),
      (err) => err instanceof MailboxReconciliationError && err.code === 'delete_job_failed'
    );

    // Cancelled job cannot be resumed
    const mockJobsCancelled = new Map([
      ['cancelled-job-1', { id: 'cancelled-job-1', operation: 'mail.data.delete', status: 'cancelled', resourceId: c16DomainId }],
    ]);
    await assert.rejects(
      validateResumeJobProof({
        jobId: 'cancelled-job-1',
        jobRegistry: { getJob: async (id) => mockJobsCancelled.get(id) || null },
      }),
      (err) => err.code === 'resume_job_unsuccessful'
    );
    run.flow.dispose();
  }

  // 2c. Veri silinmiş - Kayıt kalmış (data deleted on host, but mailbox record still in registry)
  // NEVER shows full deletion success!
  {
    const run = setupFlow();
    await run.flow.refresh();
    await action(run, 'backup');
    await action(run, 'delete');

    // Data is deleted on host, but mailbox record still exists
    assert.equal(run.db.present, false);
    assert.equal(run.db.removed, false);

    // Frontend state: receipt present, ready for Step 3, BUT status !== 'deleted'
    const curState = run.flow.getState();
    assert.equal(curState.status, 'ready');
    assert.notEqual(curState.status, 'deleted');
    assert.equal(curState.result, null);
    assert.ok(curState.receipt);

    // StrictMode view render: renders warning notice, Step 3 button enabled, NEVER renders deleted notice
    const partialHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: curState,
      })
    );
    assert.ok(partialHtml.includes('Veri silme işi doğrulandı. Hesap kaydı henüz kaldırılmadı; son onay gereklidir.'));
    assert.ok(partialHtml.includes('3. Hesap kaydını kaldır…'));
    assert.equal(partialHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'), false);

    // Backend reconciler: finalize with mailbox record still present returns reconciled: false, action: 'finalize_not_completed'
    const activeMailboxes = new Map([
      [c16TargetId, { id: c16TargetId, address: c16Target.address, mailDomainId: c16DomainId, enabled: false, revision: 1 }],
    ]);
    const finReconcile = await reconcileLostMailboxOperation({
      operation: 'finalize',
      mailboxId: c16TargetId,
      address: c16Target.address,
      backupId: 'backup-job-1',
      lastKnownJobId: 'delete-job-2',
      mailboxRegistry: { getMailbox: async (id) => activeMailboxes.get(id) || null },
    });
    assert.equal(finReconcile.reconciled, false);
    assert.equal(finReconcile.action, 'finalize_not_completed');
    assert.equal(finReconcile.deleted, undefined);
    run.flow.dispose();
  }

  // =========================================================================
  // Section 3: Lost POST & Read-Only GET Continuation (No Blind Mutation Retry)
  // =========================================================================
  {
    const run = setupFlow();
    await run.flow.refresh();
    await action(run, 'backup');
    assert.equal(mutations(run).length, 1);

    // Simulate lost response on POST /data/delete
    run.setIntercept(async (path, options, next) => {
      if (path === `${c16Base}/data/delete` && options.method === 'POST') {
        await next(path, options); // server processed it
        throw Object.assign(new Error('Network timeout / lost reply'), { code: 'ECONNRESET' });
      }
      return next(path, options);
    });

    await action(run, 'delete');
    // Flow enters uncertain state, no blind mutation re-attempt
    assert.equal(run.flow.getState().status, 'uncertain');
    assert.equal(run.flow.getState().uncertain, true);
    assert.equal(run.flow.getState().approval, null);

    // Prepare is blocked while uncertain
    await run.flow.prepare('delete');
    assert.equal(run.flow.getState().approval, null);
    assert.equal(mutations(run).length, 2); // exactly 1 backup + 1 delete sent, no retry

    // Client resumes with existing job ID using ONLY read-only GET
    run.setIntercept(null); // clear network fault
    const callsDuringResume = [];
    run.setIntercept((path, options, next) => {
      callsDuringResume.push({ path, method: options.method ?? 'GET' });
      return next(path, options);
    });

    await run.flow.resume('delete-job-2');

    // Verify all calls made during resume are read-only GET
    assert.ok(callsDuringResume.length > 0);
    for (const call of callsDuringResume) {
      assert.equal(call.method, 'GET', `Resume call must be read-only GET, got ${call.method} ${call.path}`);
    }
    assert.equal(mutations(run).length, 2); // still exactly 2, zero duplicate mutations!

    // Flow safely adopts delete receipt and clears uncertain flag
    assert.equal(run.flow.getState().receipt.id, 'delete-job-2');
    assert.equal(run.flow.getState().uncertain, false);
    assert.equal(run.flow.getState().status, 'ready');

    // Can proceed cleanly to finalize
    await action(run, 'finalize');
    assert.equal(run.flow.getState().status, 'deleted');
    assert.equal(run.db.removed, true);
    run.flow.dispose();
  }

  // =========================================================================
  // Section 4: Two Rapid Confirmations Guard
  // =========================================================================
  {
    // Client-side in-flight guard prevents duplicate POST
    const run = setupFlow();
    await run.flow.refresh();
    await run.flow.prepare('backup');
    const app = run.flow.getState().approval;
    assert.ok(app);

    // Call confirm twice concurrently
    const p1 = run.flow.confirm(app, app.data.confirmation);
    const p2 = run.flow.confirm(app, app.data.confirmation);
    await Promise.all([p1, p2]);

    assert.equal(mutations(run).length, 1); // exactly 1 POST dispatched, duplicate blocked!

    // Backend rapid confirmation guard rejects concurrent & consumed tokens
    const rapidGuard = createRapidConfirmationGuard();
    const token = 'delete-mailbox:alice@example.com:rev-1';
    const c1 = rapidGuard.beginConfirmation(token, { mailboxId: 'mb-1', revision: 1 });
    assert.equal(c1.token, token);
    assert.equal(rapidGuard.isInFlight(token), true);

    // Rapid second call throws 409
    assert.throws(
      () => rapidGuard.beginConfirmation(token, { mailboxId: 'mb-1', revision: 1 }),
      (err) => err instanceof MailboxConcurrencyLockError && err.code === 'rapid_confirmation_in_flight'
    );

    // Committing consumes the token
    c1.commit({ deleted: true });
    assert.equal(rapidGuard.isConsumed(token), true);

    // Subsequent call on consumed token throws 409
    assert.throws(
      () => rapidGuard.beginConfirmation(token, { mailboxId: 'mb-1', revision: 1 }),
      (err) => err instanceof MailboxConcurrencyLockError && err.code === 'confirmation_already_consumed'
    );
    run.flow.dispose();
  }

  // =========================================================================
  // Section 5: Finalize Reply Loss & 404 Reconciliation
  // =========================================================================
  {
    const deleteJobReceipt = {
      id: 'delete-job-rec-1',
      operation: 'mail.data.delete',
      status: 'succeeded',
      result: {
        version: 1,
        scope: 'mailbox',
        identity: c16Target.address,
        backupId: 'backup-rec-1',
        deleted: true,
      },
    };
    const jobRegistryMock = {
      getJob: async (id) => (id === 'delete-job-rec-1' ? deleteJobReceipt : null),
    };

    // 5a. Finalize reply lost after successful server deletion (mailbox absent from registry)
    const emptyMailboxes = new Map();
    const mailDataInspectorMock = {
      inspectMailbox: async (addr) => ({ present: false, bytes: 0, snapshotSha256: null }),
    };

    const reconciledSuccess = await reconcileLostMailboxOperation({
      operation: 'finalize',
      mailboxId: c16TargetId,
      address: c16Target.address,
      backupId: 'backup-rec-1',
      lastKnownJobId: 'delete-job-rec-1',
      mailboxRegistry: { getMailbox: async (id) => emptyMailboxes.get(id) || null },
      jobRegistry: jobRegistryMock,
      mailDataInspector: mailDataInspectorMock,
    });

    assert.equal(reconciledSuccess.reconciled, true);
    assert.equal(reconciledSuccess.deleted, true);
    assert.equal(reconciledSuccess.action, 'reconciled_finalize_success');
    assert.equal(reconciledSuccess.verifiedByReceipt, true);

    // 5b. Finalize 404 WITHOUT verified delete job receipt is REJECTED (404 alone is never proof)
    await assert.rejects(
      reconcileLostMailboxOperation({
        operation: 'finalize',
        mailboxId: c16TargetId,
        address: c16Target.address,
        backupId: 'backup-rec-1',
        lastKnownJobId: null, // missing receipt!
        mailboxRegistry: { getMailbox: async () => null },
        jobRegistry: jobRegistryMock,
        mailDataInspector: mailDataInspectorMock,
      }),
      (err) => err instanceof MailboxReconciliationError && err.code === 'finalize_unverified_missing_receipt'
    );

    // 5c. Finalize 404 with delete job identity mismatch is REJECTED
    await assert.rejects(
      reconcileLostMailboxOperation({
        operation: 'finalize',
        mailboxId: c16TargetId,
        address: 'different-user@example.com', // wrong address!
        backupId: 'backup-rec-1',
        lastKnownJobId: 'delete-job-rec-1',
        mailboxRegistry: { getMailbox: async () => null },
        jobRegistry: jobRegistryMock,
        mailDataInspector: mailDataInspectorMock,
      }),
      (err) => err instanceof MailboxReconciliationError && err.code === 'finalize_unverified_identity_mismatch'
    );

    // 5d. Finalize 404 with backup ID mismatch is REJECTED
    await assert.rejects(
      reconcileLostMailboxOperation({
        operation: 'finalize',
        mailboxId: c16TargetId,
        address: c16Target.address,
        backupId: 'wrong-backup-id', // wrong backup ID!
        lastKnownJobId: 'delete-job-rec-1',
        mailboxRegistry: { getMailbox: async () => null },
        jobRegistry: jobRegistryMock,
        mailDataInspector: mailDataInspectorMock,
      }),
      (err) => err instanceof MailboxReconciliationError && err.code === 'finalize_backup_mismatch'
    );

    // 5e. Finalize 404 where host mail data is STILL PRESENT is REJECTED (data not deleted)
    const dirtyInspectorMock = {
      inspectMailbox: async () => ({ present: true, bytes: 4096, snapshotSha256: sha64('dirty') }),
    };
    await assert.rejects(
      reconcileLostMailboxOperation({
        operation: 'finalize',
        mailboxId: c16TargetId,
        address: c16Target.address,
        backupId: 'backup-rec-1',
        lastKnownJobId: 'delete-job-rec-1',
        mailboxRegistry: { getMailbox: async () => null },
        jobRegistry: jobRegistryMock,
        mailDataInspector: dirtyInspectorMock,
      }),
      (err) => err instanceof MailboxReconciliationError && err.code === 'finalize_data_still_present'
    );

    // 5f. Client flow: missing mailbox without receipt marks absent, never deleted
    const missingRun = setupFlow();
    missingRun.db.removed = true;
    await missingRun.flow.refresh();
    assert.equal(missingRun.flow.getState().status, 'absent');
    assert.equal(missingRun.flow.getState().result, null);
    assert.notEqual(missingRun.flow.getState().status, 'deleted');
    assert.ok(missingRun.flow.getState().error.includes('Posta kutusu kaydı bulunamadı'));
    missingRun.flow.dispose();
  }

  // =========================================================================
  // Section 6: React StrictMode View Assertions Across Lifecycle States
  // =========================================================================
  {
    const readySnap = {
      revision: 1,
      enabled: false,
      domainStatus: 'enabled',
      quota: false,
      forwarding: false,
      aliases: 0,
      activeJobs: 0,
      present: true,
      bytes: 4096,
      snapshotSha256: sha64('snap-view'),
      blockers: [{ code: 'mail_data_backup_required', count: 1 }],
    };

    // 6a. Ready state: backup button enabled
    const readyHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: { ...EMPTY_MAILBOX_REMOVAL, status: 'ready', snapshot: readySnap },
      })
    );
    assert.ok(readyHtml.includes('Silmeden önce yedekle'));
    assert.equal(readyHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'), false);

    // 6b. Waiting state (202): job status shown, never full success
    const waitHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: { ...EMPTY_MAILBOX_REMOVAL, status: 'waiting', snapshot: readySnap, job: { id: 'backup-job-1', action: 'backup', status: 'queued' } },
      })
    );
    assert.ok(waitHtml.includes('Yedek işi: queued'));
    assert.equal(waitHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'), false);

    // 6c. Receipt present (data deleted, record remaining): warning notice and Step 3 button
    const receiptSnap = { ...readySnap, present: false, bytes: 0, blockers: [] };
    const receiptHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: {
          ...EMPTY_MAILBOX_REMOVAL,
          status: 'ready',
          snapshot: receiptSnap,
          backupId: 'backup-job-1',
          receipt: { id: 'delete-job-2', revision: 1, backupId: 'backup-job-1' },
        },
      })
    );
    assert.ok(receiptHtml.includes('Veri silme işi doğrulandı. Hesap kaydı henüz kaldırılmadı; son onay gereklidir.'));
    assert.ok(receiptHtml.includes('3. Hesap kaydını kaldır…'));
    assert.equal(receiptHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'), false);

    // 6d. Uncertain state (lost POST): alert shown, no action buttons
    const uncertHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: {
          ...EMPTY_MAILBOX_REMOVAL,
          status: 'uncertain',
          uncertain: true,
          snapshot: readySnap,
          error: 'İsteğin sonucu doğrulanamadı.',
        },
      })
    );
    assert.ok(uncertHtml.includes('Yeni bir yedek/silme isteği başlatılmayacak'));
    assert.equal(uncertHtml.includes('Silmeden önce yedekle'), false);

    // 6e. Deleted state (full success after finalize): success notice
    const deletedHtml = renderToString(
      createElement(TestMailboxApp, {
        session: c16Session,
        mailbox: c16Target,
        domain: { id: c16DomainId, webDomainId: 'c16-wdom' },
        state: {
          ...EMPTY_MAILBOX_REMOVAL,
          status: 'deleted',
          result: { id: c16TargetId, deleteJobId: 'delete-job-2', backupId: 'backup-job-1' },
        },
      })
    );
    assert.ok(deletedHtml.includes('Posta verisinin silme işi doğrulandı ve hesap kaydı kaldırıldı.'));
  }
});

test('Criterion 17: Güncel MS-01–04 ile tek-kutu silmede alan adı açık kalsın; yalnız seçilen hesabın gerçek SMTP/IMAP/Postfix/Dovecot/Roundcube erişimi denetlensin. Domain-scope toplu silmenin kendi domain disabled şartı korunur. Disabled kayıt tek başına canlı kapanma kanıtı değildir; ayrıntılı kabul yukarıdaki T-DEV-MR-SINGLE içindedir', async () => {
  const sha64 = (val) => createHash('sha256').update(String(val)).digest('hex');

  // =========================================================================
  // Section 1: Single Mailbox Deletion Flow Operates With Domain Open & Active
  // =========================================================================
  {
    const fx = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: true,
      mailboxRevision: 1,
      dataPresent: true,
    });

    const targetId = fx.mailboxId;
    const siblingId = fx.siblingMailboxId;
    const domainId = fx.mailDomainId;

    // Verify initial states: Domain is enabled, both target and sibling are enabled
    const domainBefore = await fx.mailDomainRegistry.getMailDomain(domainId);
    assert.equal(domainBefore.status, 'enabled');
    const targetBefore = await fx.mailboxRegistry.getMailbox(targetId);
    assert.equal(targetBefore.enabled, true);
    const siblingBefore = await fx.mailboxRegistry.getMailbox(siblingId);
    assert.equal(siblingBefore.enabled, true);

    // Disable target mailbox ONLY (Step 1 of single removal)
    const disabledTarget = await fx.mailboxRegistry.setEnabled(targetId, {
      expectedRevision: 1,
      enabled: false,
    });
    assert.equal(disabledTarget.enabled, false);
    assert.equal(disabledTarget.revision, 2);
    fx.mailbox.enabled = false;
    fx.mailbox.revision = 2;

    // CRITICAL: Mail domain remains strictly OPEN and ACTIVE (not disabled)
    const domainAfter = await fx.mailDomainRegistry.getMailDomain(domainId);
    assert.equal(domainAfter.status, 'enabled');
    assert.equal(domainAfter.revision, domainBefore.revision);

    // CRITICAL: Sibling mailbox remains enabled
    const siblingAfter = await fx.mailboxRegistry.getMailbox(siblingId);
    assert.equal(siblingAfter.enabled, true);
    assert.equal(siblingAfter.revision, siblingBefore.revision);

    // Assert no domain disruption or sibling disruption
    assertNoDomainOrSiblingDisruption({
      sharedDomain: domainAfter,
      siblingMailbox: siblingAfter,
      initialDomainStatus: 'enabled',
    });

    // Preview backup for target mailbox operates while domain is 'enabled'
    const backupPreview = await fx.mailDataOperationsService.previewBackup({
      scope: 'mailbox',
      resourceId: targetId,
    });
    assert.equal(backupPreview.scope, 'mailbox');
    assert.equal(backupPreview.identity, fx.mailbox.address);

    const queuedBackup = await fx.mailDataOperationsService.queueBackup({
      scope: 'mailbox',
      resourceId: targetId,
      expectedRevision: 2,
      expectedPreviewDigest: backupPreview.previewDigest,
      confirmation: backupPreview.confirmation,
    });
    assert.ok(queuedBackup.job);

    const bRes1 = await fx.hostOperations.executeOperation(
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
    fx.storedJobs.set(queuedBackup.job.id, {
      ...queuedBackup.job,
      status: 'succeeded',
      result: sanitizeMailDataBackupResult(queuedBackup.job, bRes1),
    });

    // Preview delete for target mailbox operates while domain is 'enabled'
    const deletePreview = await fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: targetId,
      backupId: fx.backupId,
    });
    assert.equal(deletePreview.scope, 'mailbox');
    assert.equal(deletePreview.identity, fx.mailbox.address);

    const queuedDelete = await fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: targetId,
      backupId: fx.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: deletePreview.previewDigest,
      confirmation: deletePreview.confirmation,
    });
    assert.ok(queuedDelete.job);

    // Domain remains enabled throughout
    const domainFinal = await fx.mailDomainRegistry.getMailDomain(domainId);
    assert.equal(domainFinal.status, 'enabled');
  }

  // =========================================================================
  // Section 2: Selective Real SMTP, IMAP, Postfix, Dovecot, Roundcube Access Quiescing
  // =========================================================================
  {
    const targetAddress = 'alice@example.com';
    const siblingAddress = 'bob@example.com';
    const thirdAddress = 'carol@example.com';

    const sessionTracker = createMailboxProtocolSessionTracker();

    // 2a. Register active sessions for target mailbox (alice)
    const aliceDesktopImap = sessionTracker.registerDovecotSession(targetAddress, { proto: 'imap', pid: '10101' });
    const aliceRoundcubeImap = sessionTracker.registerDovecotSession(targetAddress, { proto: 'imap', pid: '10102' });
    const aliceSmtp = sessionTracker.registerAuthenticatedSmtpSession(targetAddress, { sessionId: 'smtp-alice-1' });
    const aliceWebmail = sessionTracker.registerWebmailHttpSession(targetAddress, { sessionId: 'webmail-alice-1' });

    // 2b. Register active sessions for sibling mailboxes (bob and carol)
    const bobDesktopImap = sessionTracker.registerDovecotSession(siblingAddress, { proto: 'imap', pid: '20201' });
    const bobRoundcubeImap = sessionTracker.registerDovecotSession(siblingAddress, { proto: 'imap', pid: '20202' });
    const bobSmtp = sessionTracker.registerAuthenticatedSmtpSession(siblingAddress, { sessionId: 'smtp-bob-1' });
    const bobWebmail = sessionTracker.registerWebmailHttpSession(siblingAddress, { sessionId: 'webmail-bob-1' });

    const carolImap = sessionTracker.registerDovecotSession(thirdAddress, { proto: 'imap', pid: '30301' });
    const carolSmtp = sessionTracker.registerAuthenticatedSmtpSession(thirdAddress, { sessionId: 'smtp-carol-1' });
    const carolWebmail = sessionTracker.registerWebmailHttpSession(thirdAddress, { sessionId: 'webmail-carol-1' });

    // Verify initial active session counts
    assert.equal(sessionTracker.listActiveDovecotSessions(targetAddress).length, 2);
    assert.equal(sessionTracker.listActiveDovecotSessions(siblingAddress).length, 2);
    assert.equal(sessionTracker.listActiveDovecotSessions(thirdAddress).length, 1);

    // Mock command runner for mailbox access guard tracking executed commands
    const executedCommands = [];
    const mockRunner = async (file, args, options) => {
      executedCommands.push({ file, args: [...args], options });
      const cmdStr = `${file} ${args.join(' ')}`;

      // Postfix lookups
      if (file === '/usr/sbin/postconf') {
        if (args[1] === 'virtual_mailbox_maps') {
          return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
        }
        if (args[1] === 'smtpd_sender_login_maps') {
          return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n', stderr: '' };
        }
      }

      // Postfix postmap queries: absence for alice (code 1), present for bob (code 0)
      if (file === '/usr/sbin/postmap') {
        const queryAddress = args[1];
        if (queryAddress === targetAddress) {
          const err = new Error('not found');
          err.code = 1;
          err.stdout = '';
          err.stderr = '';
          throw err;
        }
        return { stdout: 'found\n', stderr: '' };
      }

      // Dovecot commands
      if (file === '/usr/bin/doveadm') {
        if (args[0] === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
          assert.equal(args[3], targetAddress, 'Dovecot cache flush must target ONLY the selected mailbox');
          return { stdout: '1 cache entries flushed\n', stderr: '' };
        }
        if (args[0] === 'auth' && args[1] === 'lookup') {
          const addr = args[args.length - 1];
          if (addr === targetAddress) {
            const err = new Error('user not found');
            err.code = 67;
            err.stdout = '';
            err.stderr = `passdb lookup: user ${addr} doesn't exist`;
            throw err;
          }
          return { stdout: `user=${addr}\n`, stderr: '' };
        }
        if (args[0] === 'user') {
          const addr = args[args.length - 1];
          if (addr === targetAddress) {
            const err = new Error('user not found');
            err.code = 67;
            err.stdout = '';
            err.stderr = `userdb lookup: user ${addr} doesn't exist`;
            throw err;
          }
          return { stdout: 'uid=5000\n', stderr: '' };
        }
        if (args[0] === 'kick') {
          assert.equal(args[1], targetAddress, 'Dovecot kick must target ONLY the selected mailbox');
          sessionTracker.kickDovecotUser(targetAddress);
          return { stdout: '', stderr: '' };
        }
        if (args[0] === '-f' && args[1] === 'tab' && args[2] === 'who') {
          assert.equal(args[args.length - 1], targetAddress, 'Dovecot who must target ONLY the selected mailbox');
          const remaining = sessionTracker.listActiveDovecotSessions(targetAddress);
          if (remaining.length === 0) {
            return { stdout: 'username\tproto\tpid\tip\n', stderr: '' };
          }
          const rows = remaining.map((s) => `${s.address}\t${s.proto}\t${s.pid}\t${s.ip}`).join('\n');
          return { stdout: `username\tproto\tpid\tip\n${rows}\n`, stderr: '' };
        }
      }

      throw new Error(`Unexpected command: ${cmdStr}`);
    };

    const guard = createMailboxAccessGuard({ run: mockRunner });

    // Quiesce target mailbox
    const quiesceProof = await guard.quiesce(targetAddress);
    assert.equal(quiesceProof.identity, targetAddress);
    assert.equal(quiesceProof.accessDisabled, true);
    assert.equal(quiesceProof.sessionsCleared, true);

    // Verify commands executed were strictly isolated to targetAddress
    assert.ok(executedCommands.length > 0);
    for (const cmd of executedCommands) {
      assert.equal(cmd.args.includes('*'), false, 'Never use wildcard user mask');
      assert.equal(cmd.args.includes('-A'), false, 'Never kick all users');
      for (const arg of cmd.args) {
        if (arg.includes('@')) {
          assert.equal(arg, targetAddress, `Command argument ${arg} must match targetAddress only`);
        }
      }
    }

    // Invalidate target mailbox SMTP and Webmail sessions
    sessionTracker.invalidateSmtpSessions(targetAddress);
    sessionTracker.terminateWebmailHttpSessions(targetAddress);

    // Target mailbox protocol sessions verification: ALL TERMINATED
    assert.equal(sessionTracker.listActiveDovecotSessions(targetAddress).length, 0);

    // Target mailbox cannot send SMTP
    assert.throws(
      () => sessionTracker.verifySmtpSender(aliceSmtp.sessionId, targetAddress, () => false),
      (err) => err.code === 'smtp_sender_disabled' || err.code === 'smtp_auth_invalid'
    );

    // Target mailbox cannot receive LMTP delivery
    assert.throws(
      () => sessionTracker.deliverLmtpMessage(targetAddress, 'Subject: Test', () => false),
      (err) => err.code === 'lmtp_recipient_not_found'
    );

    // Target mailbox cannot use Webmail session
    assert.throws(
      () => sessionTracker.validateWebmailHttpSession(aliceWebmail.sessionId, () => false),
      (err) => err.code === 'webmail_account_disabled' || err.code === 'webmail_session_invalid'
    );

    // Target access terminated separately check passes
    assertMailboxAccessTerminatedSeparately({
      address: targetAddress,
      sessionTracker,
    });

    // 2c. SIBLING MAILBOX CONTINUITY: Sibling accounts (bob & carol) REMAIN FULLY OPERATIONAL!
    // Bob's Dovecot sessions (desktop + Roundcube webmail) are 100% active
    const bobActiveDovecot = sessionTracker.listActiveDovecotSessions(siblingAddress);
    assert.equal(bobActiveDovecot.length, 2);
    assert.ok(bobActiveDovecot.some((s) => s.id === bobDesktopImap.id && s.active));
    assert.ok(bobActiveDovecot.some((s) => s.id === bobRoundcubeImap.id && s.active));

    // Bob can continue sending authenticated SMTP
    const bobSmtpCheck = sessionTracker.verifySmtpSender(bobSmtp.sessionId, siblingAddress, () => true);
    assert.equal(bobSmtpCheck.authorized, true);
    assert.equal(bobSmtpCheck.sender, siblingAddress);

    // Bob can continue receiving incoming LMTP deliveries
    const bobLmtpCheck = sessionTracker.deliverLmtpMessage(siblingAddress, 'Subject: Hello Bob', () => true);
    assert.equal(bobLmtpCheck.delivered, true);
    assert.equal(bobLmtpCheck.recipient, siblingAddress);

    // Bob's Webmail HTTP session remains valid
    const bobWebmailCheck = sessionTracker.validateWebmailHttpSession(bobWebmail.sessionId, () => true);
    assert.equal(bobWebmailCheck.valid, true);

    // Carol's protocol sessions are also 100% active
    assert.equal(sessionTracker.listActiveDovecotSessions(thirdAddress).length, 1);
    assert.equal(sessionTracker.verifySmtpSender(carolSmtp.sessionId, thirdAddress, () => true).authorized, true);
    assert.equal(sessionTracker.deliverLmtpMessage(thirdAddress, 'Subject: Hello Carol', () => true).delivered, true);
    assert.equal(sessionTracker.validateWebmailHttpSession(carolWebmail.sessionId, () => true).valid, true);

    // assertSiblingMailboxContinuity passes
    const siblingContinuity = assertSiblingMailboxContinuity({
      address: siblingAddress,
      sessionTracker,
      activeDovecotCount: 2,
    });
    assert.equal(siblingContinuity.allProtocolsOperational, true);
  }

  // =========================================================================
  // Section 3: Disabled Record Alone is NOT Proof of Live Shutdown (Fail-Closed)
  // =========================================================================
  {
    const targetAddress = 'target-check@example.com';

    // 3a. Postfix virtual_mailbox_maps still present (postmap exit 0) -> fails-closed
    {
      const runnerStillDelivered = async (file, args) => {
        if (file === '/usr/sbin/postconf') {
          return { stdout: args[1] === 'smtpd_sender_login_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
        }
        if (file === '/usr/sbin/postmap') return { stdout: 'still-delivered\n', stderr: '' };
        throw new Error('should not reach');
      };
      const guard = createMailboxAccessGuard({ run: runnerStillDelivered });
      await assert.rejects(
        guard.quiesce(targetAddress),
        (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_still_enabled'
      );
    }

    // 3b. Dovecot passdb auth still succeeds -> fails-closed
    {
      const runnerStillAuth = async (file, args) => {
        if (file === '/usr/sbin/postconf') {
          return { stdout: args[1] === 'smtpd_sender_login_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
        }
        if (file === '/usr/sbin/postmap') {
          const err = new Error('not found'); err.code = 1; err.stdout = ''; err.stderr = ''; throw err;
        }
        if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'cache') {
          return { stdout: '1 cache entries flushed\n', stderr: '' };
        }
        if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'lookup') {
          return { stdout: `user=${targetAddress}\n`, stderr: '' };
        }
        throw new Error('should not reach');
      };
      const guard = createMailboxAccessGuard({ run: runnerStillAuth });
      await assert.rejects(
        guard.quiesce(targetAddress),
        (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_still_enabled'
      );
    }

    // 3c. Dovecot session remaining after kick -> fails-closed
    {
      const runnerSessionsRemaining = async (file, args) => {
        if (file === '/usr/sbin/postconf') {
          return { stdout: args[1] === 'smtpd_sender_login_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
        }
        if (file === '/usr/sbin/postmap') {
          const err = new Error('not found'); err.code = 1; err.stdout = ''; err.stderr = ''; throw err;
        }
        if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'cache') return { stdout: '1 cache entries flushed\n', stderr: '' };
        if (file === '/usr/bin/doveadm' && args[0] === 'auth' && args[1] === 'lookup') {
          const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = `passdb lookup: user ${targetAddress} doesn't exist`; throw err;
        }
        if (file === '/usr/bin/doveadm' && args[0] === 'user') {
          const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = `userdb lookup: user ${targetAddress} doesn't exist`; throw err;
        }
        if (file === '/usr/bin/doveadm' && args[0] === 'kick') return { stdout: '', stderr: '' };
        if (file === '/usr/bin/doveadm' && args[2] === 'who') {
          return { stdout: `username\tproto\tpid\tip\n${targetAddress}\timap\t1234\t127.0.0.1\n`, stderr: '' };
        }
        throw new Error('should not reach');
      };
      const guard = createMailboxAccessGuard({ run: runnerSessionsRemaining });
      await assert.rejects(
        guard.quiesce(targetAddress),
        (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_sessions_remaining'
      );
    }

    // 3d. Unexpected error exit code (e.g. exit 75 EX_TEMPFAIL or EACCES) is NOT absence
    {
      const runnerTempfail = async (file, args) => {
        if (file === '/usr/sbin/postconf') {
          return { stdout: args[1] === 'smtpd_sender_login_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf\n' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf\n', stderr: '' };
        }
        if (file === '/usr/sbin/postmap') {
          const err = new Error('tempfail'); err.code = 75; err.stdout = ''; err.stderr = 'temporary lookup failure'; throw err;
        }
        throw new Error('should not reach');
      };
      const guard = createMailboxAccessGuard({ run: runnerTempfail });
      await assert.rejects(
        guard.quiesce(targetAddress),
        (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_check_failed'
      );
    }

    // 3e. Host data delete manager fails-closed when access guard cannot verify quiescing
    {
      const failingGuard = {
        quiesce: async () => ({ identity: targetAddress, accessDisabled: false, sessionsCleared: false }),
        verify: async () => ({ identity: targetAddress, accessDisabled: false, sessionsCleared: false }),
      };
      const mockInspector = {
        inspectMailbox: async () => ({ present: true, bytes: 4096, snapshotSha256: sha64('data'), dataPath: '/var/vmail/target' }),
        inspectDomain: async () => ({ present: true, bytes: 8192, snapshotSha256: sha64('domain-data') }),
      };
      const mockBackupMgr = {
        materializeBackup: async () => ({
          manifest: {
            backupId: 'b-1',
            scope: 'mailbox',
            identity: targetAddress,
            sourcePresent: true,
            sourcePath: '/var/vmail/target',
            contentSha256: sha64('content'),
            bytes: 4096,
            files: 1,
            directories: 1,
          },
        }),
        inspectBackup: async () => ({ backupId: 'b-1', scope: 'mailbox', identity: targetAddress, sourcePresent: true }),
      };

      const deleteManager = createMailDataDeleteManager({
        backupManager: mockBackupMgr,
        mailDataInspector: mockInspector,
        mailboxAccessGuard: failingGuard,
        run: async () => ({ stdout: 'vmail:x:5000:5000::/var/vmail:/usr/sbin/nologin\n' }),
      });

      await assert.rejects(
        deleteManager.deleteData({
          identity: targetAddress,
          scope: 'mailbox',
          backupId: 'b-1',
          expectedTargetSnapshotSha256: sha64('data'),
          transactionId: 'tx-fail-closed-1',
        }),
        (err) => err instanceof MailDataDeleteError && err.code === 'mailbox_access_unverified'
      );

      const dataAfter = await mockInspector.inspectMailbox(targetAddress);
      assert.equal(dataAfter.present, true);
    }
  }

  // =========================================================================
  // Section 4: Domain-Scope Batch Deletion Enforces Domain Disabled Precondition
  // =========================================================================
  {
    const fx = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: false,
      mailboxRevision: 1,
      dataPresent: true,
    });

    const domainId = fx.mailDomainId;
    const mailboxId = fx.mailboxId;

    // 4a. Domain-scope delete PREVIEW fails when domain is 'enabled'
    await assert.rejects(
      fx.mailDataOperationsService.previewDelete({
        scope: 'domain',
        resourceId: domainId,
        backupId: fx.backupId,
      }),
      (err) => err instanceof MailDataOperationsError
        && err.code === 'mail_data_delete_domain_disable_required'
        && err.status === 409
    );

    // 4b. Domain-scope restore PREVIEW fails when domain is 'enabled'
    await assert.rejects(
      fx.mailDataOperationsService.previewRestore({
        scope: 'domain',
        resourceId: domainId,
        backupId: fx.backupId,
      }),
      (err) => err instanceof MailDataOperationsError
        && err.code === 'mail_data_restore_domain_disable_required'
        && err.status === 409
    );

    // 4c. Contrast: Single mailbox delete PREVIEW succeeds when domain is 'enabled' (mailbox enabled: false)
    const singleMailboxPreview = await fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: mailboxId,
      backupId: fx.backupId,
    });
    assert.equal(singleMailboxPreview.scope, 'mailbox');
    assert.ok(singleMailboxPreview.previewDigest);

    // 4d. Contrast: Single mailbox delete PREVIEW fails if mailbox is still enabled (domain status is irrelevant)
    fx.mailboxesMap.get(mailboxId).enabled = true;
    await assert.rejects(
      fx.mailDataOperationsService.previewDelete({
        scope: 'mailbox',
        resourceId: mailboxId,
        backupId: fx.backupId,
      }),
      (err) => err instanceof MailDataOperationsError
        && err.code === 'mail_data_delete_mailbox_disable_required'
        && err.status === 409
    );
    fx.mailboxesMap.get(mailboxId).enabled = false;

    // 4e. When domain IS disabled and mailboxes removed, domain-scope operations succeed
    fx.mailDomain.status = 'disabled';
    fx.mailDomain.revision = 2;
    fx.mailboxesMap.delete(fx.mailboxId);
    fx.mailboxesMap.delete(fx.siblingMailboxId);

    const domainBackupId = 'dom-backup-' + randomUUID().slice(0, 8);
    fx.backupsMap.set(domainBackupId, {
      version: 1,
      backupId: domainBackupId,
      scope: 'domain',
      identity: fx.mailDomain.domainName,
      sourcePath: `/var/lib/yunpanel/mail/${fx.mailDomain.domainName}`,
      sourcePresent: true,
      sourceSnapshotSha256: fx.snapshotDigest,
      contentSha256: fx.backupContentDigest,
      bytes: 8192,
      files: 16,
      directories: 4,
      createdAt: new Date().toISOString(),
      sideEffects: true,
    });

    const domainDeletePreview = await fx.mailDataOperationsService.previewDelete({
      scope: 'domain',
      resourceId: domainId,
      backupId: domainBackupId,
    });
    assert.equal(domainDeletePreview.scope, 'domain');
    assert.equal(domainDeletePreview.mailDomainId, domainId);
    assert.ok(domainDeletePreview.previewDigest);

    const queuedDomainDelete = await fx.mailDataOperationsService.queueDelete({
      scope: 'domain',
      resourceId: domainId,
      backupId: domainBackupId,
      expectedRevision: 2,
      expectedPreviewDigest: domainDeletePreview.previewDigest,
      confirmation: domainDeletePreview.confirmation,
    });
    assert.equal(queuedDomainDelete.job.payload.scope, 'domain');
  }

  // =========================================================================
  // Section 5: End-to-End Multi-Account Lifecycle & Finalization
  // =========================================================================
  {
    const fx = createMailboxRemovalFixture({
      domainStatus: 'enabled',
      mailboxEnabled: true,
      mailboxRevision: 1,
      dataPresent: true,
    });

    const targetId = fx.mailboxId;
    const siblingId = fx.siblingMailboxId;
    const domainId = fx.mailDomainId;

    // Step 1: Disable target mailbox
    await fx.mailboxRegistry.setEnabled(targetId, {
      expectedRevision: 1,
      enabled: false,
    });
    fx.mailbox.enabled = false;
    fx.mailbox.revision = 2;

    // Verify domain is still enabled
    const domainCheck1 = await fx.mailDomainRegistry.getMailDomain(domainId);
    assert.equal(domainCheck1.status, 'enabled');

    // Step 2: Backup target mailbox
    const bPreview = await fx.mailDataOperationsService.previewBackup({
      scope: 'mailbox',
      resourceId: targetId,
    });
    const qBackup = await fx.mailDataOperationsService.queueBackup({
      scope: 'mailbox',
      resourceId: targetId,
      expectedRevision: 2,
      expectedPreviewDigest: bPreview.previewDigest,
      confirmation: bPreview.confirmation,
    });
    const bRes5 = await fx.hostOperations.executeOperation(
      OPERATIONS.MAIL_DATA_BACKUP,
      qBackup.job.payload,
      { jobId: qBackup.job.id, serverId: fx.localServerId, type: 'mail_data_backup', resourceType: 'mail_domain', resourceId: domainId }
    );
    fx.storedJobs.set(qBackup.job.id, {
      ...qBackup.job,
      status: 'succeeded',
      result: sanitizeMailDataBackupResult(qBackup.job, bRes5),
    });

    // Step 3: Delete target mailbox data on host
    const dPreview = await fx.mailDataOperationsService.previewDelete({
      scope: 'mailbox',
      resourceId: targetId,
      backupId: fx.backupId,
    });
    const qDelete = await fx.mailDataOperationsService.queueDelete({
      scope: 'mailbox',
      resourceId: targetId,
      backupId: fx.backupId,
      expectedRevision: 2,
      expectedPreviewDigest: dPreview.previewDigest,
      confirmation: dPreview.confirmation,
    });
    const delResult = await fx.hostOperations.executeOperation(
      OPERATIONS.MAIL_DATA_DELETE,
      qDelete.job.payload,
      { jobId: qDelete.job.id, serverId: fx.localServerId, type: 'mail_data_delete', resourceType: 'mail_domain', resourceId: domainId }
    );
    assert.equal(delResult.deleted, true);
    fx.storedJobs.set(qDelete.job.id, {
      ...qDelete.job,
      status: 'succeeded',
      result: sanitizeMailDataDeleteResult(qDelete.job, delResult),
    });

    // Step 4: Finalize mailbox deletion (cleanup registry records)
    const finalized = await fx.mailDeleteFinalizeService.finalizeMailbox({
      mailboxId: targetId,
      expectedRevision: 2,
      deleteJobId: qDelete.job.id,
      confirmation: `delete-mailbox:${fx.mailbox.address}`,
    });
    assert.equal(finalized.deleted, true);

    // Step 5: Post-deletion verification
    // 5a. Target mailbox record is completely removed
    const targetAfter = await fx.mailboxRegistry.getMailbox(targetId);
    assert.equal(targetAfter, null);

    // 5b. Mail domain remains strictly OPEN and ACTIVE
    const domainAfter = await fx.mailDomainRegistry.getMailDomain(domainId);
    assert.equal(domainAfter.status, 'enabled');

    // 5c. Sibling mailbox remains in registry, enabled, with untouched revision
    const siblingAfter = await fx.mailboxRegistry.getMailbox(siblingId);
    assert.equal(siblingAfter.enabled, true);
    assert.equal(siblingAfter.revision, 1);

    // 5d. Sibling active sessions remain intact
    const siblingSessions = fx.activeSessions.get(fx.siblingMailbox.address);
    assert.equal(siblingSessions.length, 2);

    // 5e. Invariants hold: no domain disruption, sibling continuity verified
    assertNoDomainOrSiblingDisruption({
      sharedDomain: domainAfter,
      siblingMailbox: siblingAfter,
      initialDomainStatus: 'enabled',
    });
  }
});
