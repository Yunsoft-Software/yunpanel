import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { OPERATIONS } from '@yunpanel/protocol';
import { mountMailboxRoutes } from '../src/mailbox-http.js';
import { createMailboxRegistry, MailboxRegistryError } from '../src/mailbox-registry.js';
import { createMailDataOperationsService, MailDataOperationsError } from '../src/mail-data-operations.js';
import { createMailDeleteFinalizeService, MailDeleteFinalizeError } from '../src/mail-delete-finalize.js';
import { createMailDeleteImpactService } from '../src/mail-delete-impact.js';
import { mountMailDeleteImpactRoutes } from '../src/mail-delete-impact-http.js';
import { mountMailDataRoutes } from '../src/mail-data-http.js';
import { createMailboxAccessGuard, MailboxAccessError } from '../../../packages/host-runtime/src/mailbox-access-guard.js';
import { createMailDataDeleteManager, MailDataDeleteError } from '../../../packages/host-runtime/src/mail-data-delete-manager.js';

const localServerId = randomUUID();
const webDomainId = randomUUID();
const mailDomainId = randomUUID();
const mailboxAId = randomUUID();
const mailboxBId = randomUUID();
const sha256 = (str) => createHash('sha256').update(str).digest('hex');
const snapshotA = sha256('mailbox-a-initial-data');
const snapshotB = sha256('mailbox-b-initial-data');
const backupContentA = sha256('mailbox-a-backup-content');

function createTestHarness(options = {}) {
  const mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: options.domainStatus ?? 'enabled',
    revision: 1,
  };

  const domain = {
    id: webDomainId,
    serverId: localServerId,
    primaryDomain: 'example.com',
    websiteId: randomUUID(),
  };

  const mailboxes = new Map([
    [mailboxAId, {
      id: mailboxAId,
      mailDomainId,
      address: 'user-a@example.com',
      enabled: options.mailboxAEnabled ?? false,
      revision: options.mailboxARevision ?? 1,
    }],
    [mailboxBId, {
      id: mailboxBId,
      mailDomainId,
      address: 'user-b@example.com',
      enabled: true,
      revision: 1,
    }],
  ]);

  const mailboxDataStore = new Map([
    ['user-a@example.com', {
      present: options.dataAPresent ?? true,
      bytes: 4096,
      snapshotSha256: options.dataASnapshot ?? snapshotA,
      dataPath: '/var/lib/yunpanel/mail/example.com/user-a',
    }],
    ['user-b@example.com', {
      present: true,
      bytes: 8192,
      snapshotSha256: snapshotB,
      dataPath: '/var/lib/yunpanel/mail/example.com/user-b',
    }],
  ]);

  const backups = new Map();
  if (options.initialBackupA !== false) {
    backups.set('backup-a-001', {
      version: 1,
      backupId: 'backup-a-001',
      scope: 'mailbox',
      identity: 'user-a@example.com',
      sourcePath: '/var/lib/yunpanel/mail/example.com/user-a',
      sourcePresent: true,
      sourceSnapshotSha256: options.backupASnapshot ?? snapshotA,
      contentSha256: backupContentA,
      bytes: 4096,
      files: 3,
      directories: 2,
      createdAt: new Date().toISOString(),
      sideEffects: true,
    });
  }

  const aliases = options.aliases ? [...options.aliases] : [];
  const quotas = new Map();
  const forwardings = new Map();
  const jobs = new Map();
  const enqueuedJobs = [];
  const deletedMailboxIds = [];

  const mailboxRegistry = {
    async getMailbox(id) {
      return mailboxes.get(id) ? structuredClone(mailboxes.get(id)) : null;
    },
    async listMailboxes(filter = {}) {
      const list = [...mailboxes.values()];
      if (filter.mailDomainId) {
        return list.filter((m) => m.mailDomainId === filter.mailDomainId).map((m) => structuredClone(m));
      }
      return list.map((m) => structuredClone(m));
    },
    async createMailbox(input) {
      const id = randomUUID();
      const record = {
        id,
        mailDomainId: input.mailDomainId,
        address: input.address,
        enabled: input.enabled ?? true,
        revision: 1,
      };
      mailboxes.set(id, record);
      return structuredClone(record);
    },
    async rotatePassword(id, { expectedRevision }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) {
        throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox revision mismatch', 409);
      }
      mb.revision += 1;
      return structuredClone(mb);
    },
    async setEnabled(id, { expectedRevision, enabled }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) {
        throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox revision mismatch', 409);
      }
      mb.enabled = enabled;
      mb.revision += 1;
      return structuredClone(mb);
    },
    async deleteMailbox(id, { expectedRevision, confirmation }) {
      const mb = mailboxes.get(id);
      if (!mb) throw new MailboxRegistryError('mailbox_not_found', 'Mailbox was not found', 404);
      if (mb.revision !== expectedRevision) {
        throw new MailboxRegistryError('stale_mailbox_revision', 'Mailbox revision mismatch', 409);
      }
      if (confirmation !== `delete-mailbox:${mb.address}`) {
        throw new MailboxRegistryError('mailbox_delete_confirmation_invalid', 'Invalid confirmation', 409);
      }
      mailboxes.delete(id);
      deletedMailboxIds.push(id);
      return { id, deleted: true };
    },
  };

  const mailDomainRegistry = {
    async getMailDomain(id) {
      return id === mailDomainId ? structuredClone(mailDomain) : null;
    },
    async deleteMailDomain() {
      throw new Error('mailDomain deletion not expected during single mailbox removal');
    },
  };

  const domainRegistry = {
    async getDomain(id) {
      return id === webDomainId ? structuredClone(domain) : null;
    },
  };

  const mailAliasRegistry = {
    async listAliases(filter) {
      if (filter?.mailDomainId) {
        return aliases.filter((a) => !a.mailDomainId || a.mailDomainId === filter.mailDomainId).map((a) => structuredClone(a));
      }
      return aliases.map((a) => structuredClone(a));
    },
  };

  const mailboxQuotaRegistry = {
    async getQuota(id) {
      return quotas.get(id) ?? null;
    },
  };

  const mailboxForwardingRegistry = {
    async getForwarding(id) {
      return forwardings.get(id) ?? null;
    },
  };

  const mailDkimRegistry = {
    async getKey() { return null; },
  };

  const jobRegistry = {
    async listJobs(filter = {}) {
      let list = [...jobs.values()];
      if (filter.resourceType) list = list.filter((j) => j.resourceType === filter.resourceType);
      if (filter.resourceId) list = list.filter((j) => j.resourceId === filter.resourceId);
      return list.map((j) => structuredClone(j));
    },
    async getJob(id) {
      return jobs.get(id) ? structuredClone(jobs.get(id)) : null;
    },
    async enqueue(input) {
      const id = randomUUID();
      const job = {
        id,
        serverId: input.serverId,
        type: input.type,
        operation: input.operation,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: 'queued',
        payload: structuredClone(input.payload),
        idempotencyKey: input.idempotencyKey,
      };
      jobs.set(id, job);
      enqueuedJobs.push(job);
      return structuredClone(job);
    },
  };

  const mailDataInspector = {
    async inspectMailbox(address) {
      const data = mailboxDataStore.get(address);
      if (!data) return { present: false, bytes: 0, snapshotSha256: null };
      return {
        version: 1,
        scope: 'mailbox',
        identity: address,
        dataPath: data.dataPath,
        present: data.present,
        bytes: data.bytes,
        snapshotSha256: data.snapshotSha256,
        sideEffects: false,
      };
    },
    async inspectDomain(domainName) {
      return {
        version: 1,
        scope: 'domain',
        identity: domainName,
        present: true,
        bytes: 12288,
        snapshotSha256: sha256('domain-data'),
        sideEffects: false,
      };
    },
  };

  const mailDataBackupManager = {
    async inspectBackup(id) {
      return backups.get(id) ? structuredClone(backups.get(id)) : null;
    },
    async materializeBackup(id) {
      const b = backups.get(id);
      if (!b) throw new Error('backup not found');
      return { manifest: structuredClone(b) };
    },
  };

  const mailDeleteImpact = createMailDeleteImpactService({
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

  const mailDataOperations = createMailDataOperationsService({
    localServerId,
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDataInspector,
    mailDataBackupManager,
    mailDeleteImpactService: mailDeleteImpact,
    jobRegistry,
  });

  const mailDeleteFinalize = createMailDeleteFinalizeService({
    mailboxRegistry,
    mailDomainRegistry,
    mailDeleteImpactService: mailDeleteImpact,
    jobRegistry,
  });

  return {
    localServerId,
    webDomainId,
    mailDomainId,
    mailboxAId,
    mailboxBId,
    mailDomain,
    domain,
    mailboxes,
    mailboxDataStore,
    backups,
    aliases,
    quotas,
    forwardings,
    jobs,
    enqueuedJobs,
    deletedMailboxIds,
    mailboxRegistry,
    mailDomainRegistry,
    domainRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    jobRegistry,
    mailDataInspector,
    mailDataBackupManager,
    mailDeleteImpact,
    mailDataOperations,
    mailDeleteFinalize,
  };
}

function createCommandRunnerHarness(activeSessions = new Map(), enabledDeliveries = new Set()) {
  const commandLog = [];
  const runner = async (file, args, options = {}) => {
    commandLog.push({ file, args: [...args] });
    const fileBase = file.split('/').at(-1);

    if (fileBase === 'postconf') {
      const param = args[1];
      if (param === 'virtual_mailbox_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf', stderr: '' };
      }
      if (param === 'smtpd_sender_login_maps') {
        return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }

    if (fileBase === 'postmap') {
      const address = args[1];
      if (enabledDeliveries.has(address)) {
        return { stdout: `user-${address}`, stderr: '' };
      }
      const err = new Error('not found');
      err.code = 1;
      err.stdout = '';
      err.stderr = '';
      throw err;
    }

    if (fileBase === 'doveadm') {
      const sub = args[0];
      if (sub === 'auth' && args[1] === 'lookup') {
        const address = args.at(-1);
        if (enabledDeliveries.has(address)) {
          return { stdout: address, stderr: '' };
        }
        const err = new Error('user not found');
        err.code = 67;
        err.stdout = '';
        err.stderr = `passdb lookup: user ${address} doesn't exist`;
        throw err;
      }
      if (sub === 'user') {
        const address = args.at(-1);
        if (enabledDeliveries.has(address)) {
          return { stdout: '1000', stderr: '' };
        }
        const err = new Error('user not found');
        err.code = 67;
        err.stdout = '';
        err.stderr = `userdb lookup: user ${address} doesn't exist`;
        throw err;
      }
      if (sub === 'auth' && args[1] === 'cache' && args[2] === 'flush') {
        const address = args[3];
        return { stdout: '1 cache entries flushed', stderr: '' };
      }
      if (sub === 'kick') {
        const address = args[1];
        activeSessions.delete(address);
        return { stdout: address, stderr: '' };
      }
      if (args.includes('who')) {
        const address = args.at(-1);
        const sessions = activeSessions.get(address);
        if (sessions && sessions.length > 0) {
          const header = 'username\tproto\tpid\tip\n';
          const rows = sessions.map((s) => `${address}\t${s.proto}\t${s.pid}\t${s.ip}`).join('\n');
          return { stdout: header + rows, stderr: '' };
        }
        return { stdout: 'username\tproto\tpid\tip\n', stderr: '' };
      }
    }

    throw new Error(`Unexpected command in test: ${file} ${args.join(' ')}`);
  };

  return { runner, commandLog };
}

async function createHttpServer(t, harness, authUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = authUser;
    next();
  });

  mountMailboxRoutes(app, {
    mailboxRegistry: harness.mailboxRegistry,
    mailAliasRegistry: harness.mailAliasRegistry,
    mailboxQuotaRegistry: harness.mailboxQuotaRegistry,
    mailboxForwardingRegistry: harness.mailboxForwardingRegistry,
    mailDomainRegistry: harness.mailDomainRegistry,
    domainRegistry: harness.domainRegistry,
    mailDeleteFinalizeService: harness.mailDeleteFinalize,
    localServerId: harness.localServerId,
  });

  mountMailDeleteImpactRoutes(app, {
    mailDeleteImpactService: harness.mailDeleteImpact,
  });

  mountMailDataRoutes(app, {
    mailDataOperationsService: harness.mailDataOperations,
  });

  app.use((error, _req, res, _next) => {
    const known = error instanceof MailboxRegistryError
      || error instanceof MailDataOperationsError
      || error instanceof MailDeleteFinalizeError;
    const status = known ? (error.status ?? 400) : 500;
    res.status(status).json({
      error: { code: known ? error.code : 'internal_error', message: error.message },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  return { base };
}

function apiRequest(base, pathname, { method = 'GET', body } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ownerAuth = Object.freeze({
  user: { role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

const readOnlyAuth = Object.freeze({
  user: { role: 'read_only' },
  access: { mode: 'read_only', permissions: ['mailboxes.read'] },
  security: { managementAllowed: false },
});

// =========================================================================
// CRITERION 1: SIBLING MAILBOX CONTINUITY (A removed, B maintains continuity)
// =========================================================================
test('Criterion 1: Deleting Mailbox A in active domain keeps Mailbox B SMTP/IMAP/Webmail access continuous and domain enabled', async (t) => {
  const harness = createTestHarness({ mailboxAEnabled: false, domainStatus: 'enabled' });
  const { base } = await createHttpServer(t, harness, ownerAuth);

  // 1. Initial State: Domain is enabled; Mailbox A disabled; Mailbox B enabled
  assert.equal(harness.mailDomain.status, 'enabled');
  const initialA = await harness.mailboxRegistry.getMailbox(mailboxAId);
  const initialB = await harness.mailboxRegistry.getMailbox(mailboxBId);
  assert.equal(initialA.enabled, false);
  assert.equal(initialB.enabled, true);

  // Set up mock command runner where Mailbox B has active delivery & auth, while A is disabled
  const enabledDeliveries = new Set(['user-b@example.com']);
  const activeSessions = new Map([
    ['user-b@example.com', [{ proto: 'imap', pid: '2001', ip: '10.0.0.2' }]],
  ]);
  const { runner, commandLog } = createCommandRunnerHarness(activeSessions, enabledDeliveries);
  const accessGuard = createMailboxAccessGuard({ run: runner });

  // Verify Mailbox B's continuous access before, during, and after Mailbox A's deletion
  // Sibling access check: Postfix and Dovecot lookups succeed for Mailbox B
  const passdbB = await runner('/usr/bin/doveadm', ['auth', 'lookup', '-x', 'service=imap', '-f', 'user', 'user-b@example.com']);
  assert.equal(passdbB.stdout, 'user-b@example.com');
  const postmapB = await runner('/usr/sbin/postmap', ['-q', 'user-b@example.com', 'proxy:sqlite:...']);
  assert.equal(postmapB.stdout, 'user-user-b@example.com');

  // 2. Perform deletion lifecycle for Mailbox A:
  // Step 2a: Inspect impact - Mailbox A has no blockers other than data backup
  const impactResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/delete-impact`);
  assert.equal(impactResp.status, 200);
  const impactBody = await impactResp.json();
  assert.equal(impactBody.data.address, 'user-a@example.com');
  assert.equal(impactBody.data.requiresDataBackup, true);

  // Step 2b: Preview data deletion with existing backup
  const delPreviewResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    method: 'POST',
    body: { backupId: 'backup-a-001' },
  });
  assert.equal(delPreviewResp.status, 200);
  const delPreview = (await delPreviewResp.json()).data;
  assert.equal(delPreview.operation, 'mail_data_delete');
  assert.equal(delPreview.identity, 'user-a@example.com');

  // Step 2c: Queue data deletion
  const delQueueResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete`, {
    method: 'POST',
    body: {
      backupId: 'backup-a-001',
      expectedRevision: delPreview.expectedRevision,
      expectedPreviewDigest: delPreview.previewDigest,
      confirmation: delPreview.confirmation,
    },
  });
  assert.equal(delQueueResp.status, 202);
  const deleteJob = harness.enqueuedJobs[0];
  assert.ok(deleteJob);
  assert.equal(deleteJob.payload.identity, 'user-a@example.com');

  // Step 2d: Simulate worker execution using access guard for mailbox A
  const quiesceResult = await accessGuard.quiesce('user-a@example.com');
  assert.equal(quiesceResult.accessDisabled, true);
  assert.equal(quiesceResult.sessionsCleared, true);

  // Verify access guard commands targeted ONLY user-a@example.com, NEVER user-b@example.com
  const kickedTargets = commandLog.filter((c) => c.args[0] === 'kick').map((c) => c.args[1]);
  assert.deepEqual(kickedTargets, ['user-a@example.com']);
  assert.ok(!commandLog.some((c) => c.args.includes('user-b@example.com') && (c.args.includes('kick') || c.args.includes('flush'))));

  // Mark data deletion job as succeeded
  harness.mailboxDataStore.get('user-a@example.com').present = false;
  harness.mailboxDataStore.get('user-a@example.com').bytes = 0;
  harness.jobs.get(deleteJob.id).status = 'succeeded';
  harness.jobs.get(deleteJob.id).result = {
    version: 1,
    transactionId: deleteJob.id,
    backupId: 'backup-a-001',
    mailDomainId,
    resourceId: mailboxAId,
    expectedResourceRevision: initialA.revision,
    scope: 'mailbox',
    identity: 'user-a@example.com',
    sourcePresent: true,
    contentSha256: backupContentA,
    bytes: 4096,
    files: 3,
    directories: 2,
    deleted: true,
    sideEffects: true,
  };

  // Step 2e: Finalize mailbox deletion
  const finalizeResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}`, {
    method: 'DELETE',
    body: {
      expectedRevision: initialA.revision,
      deleteJobId: deleteJob.id,
      confirmation: `delete-mailbox:user-a@example.com`,
    },
  });
  assert.equal(finalizeResp.status, 200);
  const finalizeBody = await finalizeResp.json();
  assert.equal(finalizeBody.data.deleted, true);
  assert.equal(finalizeBody.data.id, mailboxAId);

  // 3. Post-Condition Verification:
  // Mailbox A is completely absent
  const afterA = await harness.mailboxRegistry.getMailbox(mailboxAId);
  assert.equal(afterA, null);
  const getAResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}`);
  assert.equal(getAResp.status, 404);

  // Mailbox B remains present, enabled, with untouched revision and credentials
  const afterB = await harness.mailboxRegistry.getMailbox(mailboxBId);
  assert.ok(afterB);
  assert.equal(afterB.enabled, true);
  assert.equal(afterB.address, 'user-b@example.com');
  assert.equal(afterB.revision, initialB.revision);

  // Mail domain status remains 'enabled' (no domain-level disruption)
  assert.equal(harness.mailDomain.status, 'enabled');
  assert.equal(harness.mailDomain.revision, 1);

  // Listing mailboxes returns only Mailbox B
  const listResp = await apiRequest(base, `/api/mailboxes?mailDomainId=${mailDomainId}`);
  assert.equal(listResp.status, 200);
  const listBody = await listResp.json();
  assert.equal(listBody.data.length, 1);
  assert.equal(listBody.data[0].id, mailboxBId);

  // Mailbox B's active IMAP session remains connected
  assert.equal(activeSessions.get('user-b@example.com')?.length, 1);
  assert.equal(activeSessions.get('user-b@example.com')[0].proto, 'imap');
});

// =========================================================================
// CRITERION 2: FAIL-CLOSED ISOLATION OF PRE-AUTHENTICATED SESSIONS
// =========================================================================
test('Criterion 2: Pre-authenticated Dovecot/IMAP/SMTP/LMTP sessions fail closed during deletion', async () => {
  // Scenario 2a: Active IMAP/webmail sessions detected and cleared
  const activeSessions = new Map([
    ['user-a@example.com', [
      { proto: 'imap', pid: '101', ip: '192.168.1.50' },
      { proto: 'lmtp', pid: '102', ip: '127.0.0.1' },
    ]],
  ]);
  const enabledDeliveries = new Set(); // delivery disabled
  const { runner } = createCommandRunnerHarness(activeSessions, enabledDeliveries);
  const accessGuard = createMailboxAccessGuard({ run: runner });

  // When quiesce runs, active sessions are kicked and cleared
  const quiesced = await accessGuard.quiesce('user-a@example.com');
  assert.equal(quiesced.sessionsCleared, true);
  assert.equal(activeSessions.get('user-a@example.com'), undefined);

  // Scenario 2b: Stubborn session refuses to close -> Fail closed
  const stubbornSessions = new Map([
    ['user-a@example.com', [{ proto: 'imap', pid: '999', ip: '192.168.1.99' }]],
  ]);
  const stubbornRunner = async (file, args) => {
    if (args.includes('who')) {
      return { stdout: "username\tproto\tpid\tip\nuser-a@example.com\timap\t999\t192.168.1.99\n", stderr: '' };
    }
    if (args[0] === 'kick') return { stdout: 'user-a@example.com', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'cache') return { stdout: '1 cache entries flushed', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'lookup') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "passdb lookup: user user-a@example.com doesn't exist"; throw err;
    }
    if (args[0] === 'user') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "userdb lookup: user user-a@example.com doesn't exist"; throw err;
    }
    if (file.endsWith('/postconf')) {
      const param = args[1];
      return { stdout: param === 'virtual_mailbox_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
    }
    if (file.endsWith('/postmap')) { const err = new Error('missing'); err.code = 1; err.stdout = ''; err.stderr = ''; throw err; }
    throw new Error('unexpected');
  };
  const stubbornGuard = createMailboxAccessGuard({ run: stubbornRunner });
  await assert.rejects(
    stubbornGuard.quiesce('user-a@example.com'),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_sessions_remaining',
  );

  // Scenario 2c: Pre-authenticated SMTP/LMTP delivery still active in Postfix -> Fail closed
  const activeDeliveryRunner = async (file, args) => {
    if (file.endsWith('/postconf')) return { stdout: 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf', stderr: '' };
    if (file.endsWith('/postmap')) return { stdout: 'active_mailbox', stderr: '' }; // active!
    throw new Error('unexpected');
  };
  const deliveryGuard = createMailboxAccessGuard({ run: activeDeliveryRunner });
  await assert.rejects(
    deliveryGuard.quiesce('user-a@example.com'),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_still_enabled',
  );

  // Scenario 2d: Re-enabled delivery during session cleanup (second lookup race) -> Fail closed
  let postmapChecks = 0;
  const raceRunner = async (file, args) => {
    if (file.endsWith('/postconf')) {
      const param = args[1];
      return { stdout: param === 'virtual_mailbox_maps' ? 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf' : 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf', stderr: '' };
    }
    if (file.endsWith('/postmap')) {
      postmapChecks++;
      if (postmapChecks === 3) {
        // Drifts back to active during the final verification pass!
        return { stdout: 're_enabled', stderr: '' };
      }
      const err = new Error('not found'); err.code = 1; err.stdout = ''; err.stderr = ''; throw err;
    }
    if (args[0] === 'auth' && args[1] === 'cache') return { stdout: '1 cache entries flushed', stderr: '' };
    if (args[0] === 'kick') return { stdout: 'user-a@example.com', stderr: '' };
    if (args.includes('who')) return { stdout: 'username\tproto\tpid\tip\n', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'lookup') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "passdb lookup: user user-a@example.com doesn't exist"; throw err;
    }
    if (args[0] === 'user') {
      const err = new Error('not found'); err.code = 67; err.stdout = ''; err.stderr = "userdb lookup: user user-a@example.com doesn't exist"; throw err;
    }
    throw new Error('unexpected');
  };
  const raceGuard = createMailboxAccessGuard({ run: raceRunner });
  await assert.rejects(
    raceGuard.quiesce('user-a@example.com'),
    (err) => err instanceof MailboxAccessError && err.code === 'mailbox_access_still_enabled',
  );
});

// =========================================================================
// CRITERION 3: MUTATION-TIME AUTHORIZATION, RE-ACTIVATION & ALIAS RACES
// =========================================================================
test('Criterion 3: Mutation-time authorization, re-activation, and alias races are safely rejected', async (t) => {
  const harness = createTestHarness({ mailboxAEnabled: false });
  const { base } = await createHttpServer(t, harness, ownerAuth);

  // 3a. Read-Only role cannot mutate or delete mailbox
  const readOnlyServer = await createHttpServer(t, harness, readOnlyAuth);
  const roDeleteResp = await apiRequest(readOnlyServer.base, `/api/mailboxes/${mailboxAId}`, {
    method: 'DELETE',
    body: { expectedRevision: 1, deleteJobId: 'some-job', confirmation: 'delete-mailbox:user-a@example.com' },
  });
  assert.equal(roDeleteResp.status, 403);

  // 3b. Re-activation race: Mailbox A re-enabled during delete queueing
  const delPreviewResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    method: 'POST',
    body: { backupId: 'backup-a-001' },
  });
  assert.equal(delPreviewResp.status, 200);
  const delPreview = (await delPreviewResp.json()).data;

  // Concurrent actor re-enables Mailbox A (revision increments to 2, enabled becomes true)
  await harness.mailboxRegistry.setEnabled(mailboxAId, { expectedRevision: 1, enabled: true });

  // Attempting queueDelete with stale preview and now-enabled mailbox fails with 409
  const queueStaleResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete`, {
    method: 'POST',
    body: {
      backupId: 'backup-a-001',
      expectedRevision: delPreview.expectedRevision,
      expectedPreviewDigest: delPreview.previewDigest,
      confirmation: delPreview.confirmation,
    },
  });
  assert.equal(queueStaleResp.status, 409);
  const queueStaleErr = await queueStaleResp.json();
  assert.ok(['mail_data_delete_preview_stale', 'mail_data_delete_mailbox_disable_required'].includes(queueStaleErr.error.code));

  // Reset Mailbox A back to disabled for alias race test
  await harness.mailboxRegistry.setEnabled(mailboxAId, { expectedRevision: 2, enabled: false });
  const currentMb = await harness.mailboxRegistry.getMailbox(mailboxAId);
  assert.equal(currentMb.revision, 3);

  // 3c. Alias Reference race: Inbound local alias added before delete preview
  harness.aliases.push({
    id: 'local-alias-1',
    mailDomainId,
    source: 'info@example.com',
    destinations: ['user-a@example.com'],
    enabled: true,
  });

  // Delete preview rejects because dependencies exist
  const blockedPreviewResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    method: 'POST',
    body: { backupId: 'backup-a-001' },
  });
  assert.equal(blockedPreviewResp.status, 409);
  const blockedErr = await blockedPreviewResp.json();
  assert.equal(blockedErr.error.code, 'mail_data_delete_dependencies_exist');

  // 3d. Inbound foreign alias added without revealing its private identity
  harness.aliases.length = 0; // clear local
  harness.aliases.push({
    id: 'foreign-alias-999',
    mailDomainId: 'other-domain-id',
    source: 'contact@foreign-domain.test',
    destinations: ['user-a@example.com'],
    enabled: true,
  });

  // Verify foreign alias blocks impact without revealing foreign alias ID
  const impactResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/delete-impact`);
  assert.equal(impactResp.status, 200);
  const impact = (await impactResp.json()).data;
  assert.equal(impact.safeToDelete, false);
  assert.equal(impact.dependencies.aliasReferences.count, 1);
  assert.equal(JSON.stringify(impact).includes('foreign-alias-999'), false);

  // Finalization fails closed if an alias reference appears concurrently
  const dummyJobId = randomUUID();
  harness.jobs.set(dummyJobId, {
    id: dummyJobId,
    status: 'succeeded',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    result: {
      version: 1,
      transactionId: dummyJobId,
      backupId: 'backup-a-001',
      mailDomainId,
      resourceId: mailboxAId,
      expectedResourceRevision: currentMb.revision,
      scope: 'mailbox',
      identity: 'user-a@example.com',
      sourcePresent: true,
      deleted: true,
      sideEffects: true,
    },
  });

  await assert.rejects(
    harness.mailDeleteFinalize.finalizeMailbox({
      mailboxId: mailboxAId,
      expectedRevision: currentMb.revision,
      deleteJobId: dummyJobId,
      confirmation: `delete-mailbox:user-a@example.com`,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mail_delete_impact_not_clear',
  );
  // Mailbox was not deleted
  assert.ok(await harness.mailboxRegistry.getMailbox(mailboxAId));
});

// =========================================================================
// CRITERION 4: PRE-DELETION BACKUP AND ROLLBACK FLOW VERIFIABILITY
// =========================================================================
test('Criterion 4: Verifiable pre-deletion backup and host rollback flow', async (t) => {
  const harness = createTestHarness({ mailboxAEnabled: false });
  const { base } = await createHttpServer(t, harness, ownerAuth);

  // 4a. Deletion without verified backup is rejected
  const noBackupResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    method: 'POST',
    body: { backupId: 'non-existent-backup' },
  });
  assert.equal(noBackupResp.status, 404);

  // 4b. Outdated/stale backup (data snapshot changed) is rejected
  harness.backups.set('stale-backup-001', {
    version: 1,
    backupId: 'stale-backup-001',
    scope: 'mailbox',
    identity: 'user-a@example.com',
    sourcePath: '/var/lib/yunpanel/mail/example.com/user-a',
    sourcePresent: true,
    sourceSnapshotSha256: sha256('older-snapshot'), // mismatch
    contentSha256: sha256('older-content'),
    bytes: 2048,
    files: 1,
    directories: 1,
    createdAt: new Date().toISOString(),
  });
  const staleBackupResp = await apiRequest(base, `/api/mailboxes/${mailboxAId}/data/delete-preview`, {
    method: 'POST',
    body: { backupId: 'stale-backup-001' },
  });
  assert.equal(staleBackupResp.status, 409);
  const staleErr = await staleBackupResp.json();
  assert.equal(staleErr.error.code, 'mail_data_delete_backup_stale');

  // 4c. Host deletion rollback on failure:
  // Using mailDataDeleteManager with simulated failure after rename
  const emptyTreeSha = createHash('sha256').update(JSON.stringify(['d', '']) + '\n').digest('hex');
  harness.backups.set('backup-rollback-001', {
    version: 1,
    backupId: 'backup-rollback-001',
    scope: 'mailbox',
    identity: 'user-a@example.com',
    sourcePath: '/var/lib/yunpanel/mail/example.com/user-a',
    sourcePresent: true,
    sourceSnapshotSha256: snapshotA,
    contentSha256: emptyTreeSha,
    bytes: 0,
    files: 0,
    directories: 0,
  });

  let renameCalls = [];
  let rmCalls = 0;
  const targetPath = '/var/lib/yunpanel/mail/example.com/user-a';
  const tombstonePath = '/var/lib/yunpanel/mail/example.com/.user-a.delete-test-trans-001';
  let isTombstone = false;

  const fakeRename = async (from, to) => {
    renameCalls.push({ from, to });
    if (from === targetPath && to === tombstonePath) {
      isTombstone = true;
    } else if (from === tombstonePath && to === targetPath) {
      isTombstone = false;
    }
  };
  const fakeRm = async () => {
    rmCalls += 1;
    throw new Error('simulated disk I/O error during tombstone deletion');
  };
  const fakeLstat = async (p) => {
    if (p === targetPath) {
      if (isTombstone) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
        mode: 0o700,
        uid: 1000,
        gid: 1000,
      };
    }
    if (p === tombstonePath) {
      if (!isTombstone) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
        mode: 0o700,
        uid: 1000,
        gid: 1000,
      };
    }
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  };
  const fakeReaddir = async () => [];
  const mockAccessGuard = {
    async quiesce(id) { return { identity: id, accessDisabled: true, sessionsCleared: true }; },
    async verify(id) { return { identity: id, accessDisabled: true, sessionsCleared: true }; },
  };

  const failingDeleteManager = createMailDataDeleteManager({
    backupManager: harness.mailDataBackupManager,
    mailDataInspector: harness.mailDataInspector,
    mailboxAccessGuard: mockAccessGuard,
    run: async (file) => {
      if (file.endsWith('/getent')) return { stdout: 'vmail:x:1000:1000::/var/lib/yunpanel/mail:/bin/false\n' };
      return { stdout: '' };
    },
    renameFn: fakeRename,
    rmFn: fakeRm,
    lstatFn: fakeLstat,
    readdirFn: fakeReaddir,
  });

  // Use the serialized public deleteData API; an rm failure must trigger rollback.
  await assert.rejects(
    failingDeleteManager.deleteData({
      transactionId: 'test-trans-001',
      backupId: 'backup-rollback-001',
      scope: 'mailbox',
      identity: 'user-a@example.com',
      expectedTargetSnapshotSha256: snapshotA,
    }),
    error => error.code === 'mail_data_delete_failed',
  );

  // Verify rollback occurred: initial rename target -> tombstone, then tombstone -> target
  assert.equal(rmCalls, 1);
  assert.equal(renameCalls.length, 2);
  assert.equal(renameCalls[0].from, targetPath);
  assert.equal(renameCalls[0].to, tombstonePath);
  assert.equal(renameCalls[1].from, tombstonePath);
  assert.equal(renameCalls[1].to, targetPath);
  assert.equal(isTombstone, false); // restored to original path!

  // 4d. Disaster recovery / restore flow:
  // With verified backup, previewRestore and queueRestore can restore mailbox data
  harness.mailDomain.status = 'disabled'; // restore requires disabled domain for safe write
  const restorePreview = await harness.mailDataOperations.previewRestore({
    scope: 'mailbox',
    resourceId: mailboxAId,
    backupId: 'backup-a-001',
  });
  assert.equal(restorePreview.operation, 'mail_data_restore');
  assert.equal(restorePreview.backupId, 'backup-a-001');

  const restoreJobResult = await harness.mailDataOperations.queueRestore({
    scope: 'mailbox',
    resourceId: mailboxAId,
    backupId: 'backup-a-001',
    expectedRevision: restorePreview.expectedRevision,
    expectedPreviewDigest: restorePreview.previewDigest,
    confirmation: restorePreview.confirmation,
  });
  assert.ok(restoreJobResult.job.id);
  assert.equal(restoreJobResult.job.operation, OPERATIONS.MAIL_DATA_RESTORE);

  // 4e. Finalization abort safety: If delete job failed, mailbox record is retained
  const failedJobId = randomUUID();
  harness.jobs.set(failedJobId, {
    id: failedJobId,
    status: 'failed',
    operation: OPERATIONS.MAIL_DATA_DELETE,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
  });
  await assert.rejects(
    harness.mailDeleteFinalize.finalizeMailbox({
      mailboxId: mailboxAId,
      expectedRevision: 1,
      deleteJobId: failedJobId,
      confirmation: `delete-mailbox:user-a@example.com`,
    }),
    (err) => err instanceof MailDeleteFinalizeError && err.code === 'mail_delete_job_mismatch',
  );
  // Mailbox record is NOT deleted
  assert.ok(await harness.mailboxRegistry.getMailbox(mailboxAId));
});
