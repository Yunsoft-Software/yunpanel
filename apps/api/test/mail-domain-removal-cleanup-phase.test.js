import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createMailDomainRemovalCleanupPhase,
  MailDomainRemovalCleanupPhaseError,
} from '../src/mail-domain-removal-cleanup-phase.js';

const operationId = randomUUID();
const mailDomainId = randomUUID();
const webDomainId = randomUUID();
const serverId = randomUUID();
const mailboxId = randomUUID();
const aliasId = randomUUID();
const sourceUpdatedAt = '2026-09-19T13:00:00.000Z';
const disabledUpdatedAt = '2026-09-19T13:01:00.000Z';
const dependencyUpdatedAt = '2026-09-19T12:00:00.000Z';

function cleanupPlan() {
  return {
    version: 2,
    mailDomainId,
    mailboxes: [{
      id: mailboxId,
      address: 'owner@example.com',
      enabled: true,
      revision: 3,
      updatedAt: dependencyUpdatedAt,
    }],
    aliases: [{
      id: aliasId,
      source: 'hello@example.com',
      enabled: true,
      revision: 4,
      updatedAt: dependencyUpdatedAt,
    }],
    quotas: [{ mailboxId, revision: 5, updatedAt: dependencyUpdatedAt }],
    forwardings: [{ mailboxId, revision: 6, updatedAt: dependencyUpdatedAt }],
    dkim: {
      mailDomainId,
      domainName: 'example.com',
      selector: 'yunpanel',
      revision: 2,
      updatedAt: dependencyUpdatedAt,
    },
    mailData: { present: true, bytes: 128, snapshotSha256: 'a'.repeat(64) },
    disableConfiguration: {
      previewDigest: 'b'.repeat(64),
      configurationSha256: 'c'.repeat(64),
    },
  };
}

function operation(overrides = {}) {
  const plan = cleanupPlan();
  return {
    id: operationId,
    mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    sourceStatus: 'enabled',
    sourceRevision: 7,
    sourceUpdatedAt,
    planDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    cleanupPlan: plan,
    status: 'cleaning',
    updatedAt: '2026-09-19T13:02:00.000Z',
    disableJobId: 'mail-config-job-1',
    finalRevision: 8,
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
    ...overrides,
  };
}

function fixture({
  mailboxes = [{
    id: mailboxId,
    mailDomainId,
    address: 'owner@example.com',
    enabled: true,
    revision: 3,
    updatedAt: dependencyUpdatedAt,
  }],
  aliases = [{
    id: aliasId,
    mailDomainId,
    source: 'hello@example.com',
    enabled: true,
    revision: 4,
    updatedAt: dependencyUpdatedAt,
  }],
  quotas = [{ mailboxId, revision: 5, updatedAt: dependencyUpdatedAt }],
  forwardings = [{ mailboxId, revision: 6, updatedAt: dependencyUpdatedAt }],
  dkim = {
    mailDomainId,
    domainName: 'example.com',
    selector: 'yunpanel',
    revision: 2,
    updatedAt: dependencyUpdatedAt,
  },
  mailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: 8,
    updatedAt: disabledUpdatedAt,
  },
} = {}) {
  const state = {
    mailboxes: structuredClone(mailboxes),
    aliases: structuredClone(aliases),
    quotas: structuredClone(quotas),
    forwardings: structuredClone(forwardings),
    dkim: structuredClone(dkim),
  };
  const calls = [];
  const phase = createMailDomainRemovalCleanupPhase({
    localServerId: serverId,
    mailDomainRegistry: { async getMailDomain() { return mailDomain; } },
    domainRegistry: {
      async getDomain() {
        return { id: webDomainId, primaryDomain: 'example.com', serverId };
      },
    },
    mailboxRegistry: {
      async listMailboxes(filter) {
        assert.deepEqual(filter, { mailDomainId });
        return state.mailboxes;
      },
    },
    mailAliasRegistry: {
      async listAliases(filter) {
        assert.deepEqual(filter, { mailDomainId });
        return state.aliases;
      },
      async deleteAlias(id, input) {
        calls.push(['alias', id, input]);
        state.aliases = state.aliases.filter((alias) => alias.id !== id);
      },
    },
    mailboxQuotaRegistry: {
      async listQuotas() { return state.quotas; },
      async clearQuota(id, input) {
        calls.push(['quota', id, input]);
        state.quotas = state.quotas.filter((quota) => quota.mailboxId !== id);
      },
    },
    mailboxForwardingRegistry: {
      async listForwardings() { return state.forwardings; },
      async clearForwarding(id, input) {
        calls.push(['forwarding', id, input]);
        state.forwardings = state.forwardings.filter(
          (forwarding) => forwarding.mailboxId !== id,
        );
      },
    },
    mailDkimRegistry: {
      async getKey() { return state.dkim; },
      async deleteKey(id, input) {
        calls.push(['dkim', id, input]);
        state.dkim = null;
      },
    },
  });
  return { phase, state, calls };
}

test('explicit cleanup removes one pinned dependency per continuation before backup', async () => {
  const state = fixture();
  const expectedCalls = [
    ['forwarding', mailboxId, {
      expectedRevision: 6,
      confirmation: `clear-mailbox-forwarding:${mailboxId}`,
    }],
    ['quota', mailboxId, {
      expectedRevision: 5,
      confirmation: `clear-mailbox-quota:${mailboxId}`,
    }],
    ['alias', aliasId, {
      expectedRevision: 4,
      confirmation: 'delete-mail-alias:hello@example.com',
    }],
    ['dkim', mailDomainId, {
      expectedRevision: 2,
      confirmation: `delete-mail-dkim:${mailDomainId}:yunpanel:2`,
    }],
  ];

  for (let index = 0; index < expectedCalls.length; index += 1) {
    const result = await state.phase.execute(operation());
    assert.equal(result.disposition, 'advance');
    assert.equal(result.status, 'cleaning');
    assert.equal(result.evidence.cleanupEvidenceDigest, null);
    assert.deepEqual(state.calls, expectedCalls.slice(0, index + 1));
  }

  const complete = await state.phase.execute(operation());
  assert.equal(complete.disposition, 'advance');
  assert.equal(complete.status, 'backing_up');
  assert.match(complete.evidence.cleanupEvidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(complete.evidence.backupId, null);
  assert.equal(state.state.mailboxes.length, 1);
  assert.equal(state.calls.length, 4);
});

test('startup inspection never mutates incomplete cleanup', async () => {
  const state = fixture();
  const result = await state.phase.inspect(operation());

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_cleanup_retry_required');
  assert.equal(result.sideEffects, false);
  assert.deepEqual(state.calls, []);
  assert.equal(state.state.forwardings.length, 1);
});

test('startup inspection closes exact cleanup post-condition without replay', async () => {
  const state = fixture({ aliases: [], quotas: [], forwardings: [], dkim: null });
  const result = await state.phase.inspect(operation());

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'backing_up');
  assert.match(result.evidence.cleanupEvidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.sideEffects, false);
  assert.deepEqual(state.calls, []);
});

test('changed or missing pinned mailbox fails before dependency mutation', async () => {
  const changed = fixture({
    mailboxes: [{
      id: mailboxId,
      mailDomainId,
      address: 'owner@example.com',
      enabled: false,
      revision: 4,
      updatedAt: disabledUpdatedAt,
    }],
  });
  const changedResult = await changed.phase.execute(operation());
  assert.equal(changedResult.disposition, 'failed');
  assert.equal(changedResult.error.code, 'mail_domain_removal_cleanup_mailbox_drift');
  assert.deepEqual(changed.calls, []);

  const missing = fixture({ mailboxes: [] });
  const missingResult = await missing.phase.execute(operation());
  assert.equal(missingResult.disposition, 'failed');
  assert.equal(missingResult.error.code, 'mail_domain_removal_cleanup_mailbox_drift');
  assert.deepEqual(missing.calls, []);
});

test('unplanned dependency and DKIM drift fail before cleanup mutation', async () => {
  const extra = fixture({
    aliases: [{
      id: randomUUID(),
      mailDomainId,
      source: 'new@example.com',
      enabled: true,
      revision: 1,
      updatedAt: disabledUpdatedAt,
    }],
  });
  const extraResult = await extra.phase.execute(operation());
  assert.equal(extraResult.disposition, 'failed');
  assert.equal(extraResult.error.code, 'mail_domain_removal_cleanup_alias_drift');
  assert.deepEqual(extra.calls, []);

  const changedDkim = fixture({
    dkim: {
      mailDomainId,
      domainName: 'example.com',
      selector: 'rotated',
      revision: 3,
      updatedAt: disabledUpdatedAt,
    },
  });
  const dkimResult = await changedDkim.phase.inspect(operation());
  assert.equal(dkimResult.disposition, 'failed');
  assert.equal(dkimResult.error.code, 'mail_domain_removal_cleanup_dkim_drift');
  assert.deepEqual(changedDkim.calls, []);
});

test('cleanup rejects non-disabled or tampered operation state', async () => {
  const enabled = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'enabled',
      revision: 8,
      updatedAt: disabledUpdatedAt,
    },
  });
  await assert.rejects(
    enabled.phase.execute(operation()),
    (error) => error instanceof MailDomainRemovalCleanupPhaseError
      && error.code === 'mail_domain_removal_cleanup_state_drift',
  );

  const tampered = fixture();
  await assert.rejects(
    tampered.phase.execute(operation({ planDigest: 'f'.repeat(64) })),
    (error) => error instanceof MailDomainRemovalCleanupPhaseError
      && error.code === 'mail_domain_removal_cleanup_operation_invalid',
  );
  assert.deepEqual(tampered.calls, []);
});
