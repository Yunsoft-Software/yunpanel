import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createMailDeleteImpactService,
  MailDeleteImpactError,
} from '../src/mail-delete-impact.js';

const serverId = randomUUID();
const remoteServerId = randomUUID();
const webDomain = Object.freeze({ id: randomUUID(), serverId, primaryDomain: 'example.com' });
const remoteWebDomain = Object.freeze({ id: randomUUID(), serverId: remoteServerId, primaryDomain: 'remote.example.com' });
const mailDomain = Object.freeze({
  id: randomUUID(),
  webDomainId: webDomain.id,
  domainName: 'example.com',
  managementMode: 'local',
  status: 'disabled',
  revision: 7,
});
const enabledMailDomain = Object.freeze({ ...mailDomain, status: 'enabled' });
const remoteMailDomain = Object.freeze({
  id: randomUUID(),
  webDomainId: remoteWebDomain.id,
  domainName: remoteWebDomain.primaryDomain,
  managementMode: 'local',
  status: 'disabled',
  revision: 1,
});
const mailbox = Object.freeze({
  id: randomUUID(),
  mailDomainId: mailDomain.id,
  address: 'owner@example.com',
  enabled: false,
  revision: 4,
});

function createService({
  currentMailDomain = mailDomain,
  currentMailbox = mailbox,
  mailboxes = [mailbox],
  aliases = [],
  quota = null,
  forwarding = null,
  dkim = null,
  jobs = [],
  mailboxData = { present: false, bytes: 0, snapshotSha256: 'a'.repeat(64) },
  domainData = { present: false, bytes: 0, snapshotSha256: 'b'.repeat(64) },
  domainOverride = null,
} = {}) {
  const domains = new Map([
    [webDomain.id, webDomain],
    [remoteWebDomain.id, remoteWebDomain],
  ]);
  if (domainOverride) domains.set(currentMailDomain.webDomainId, domainOverride);
  return createMailDeleteImpactService({
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain(id) {
        if (id === currentMailDomain.id) return currentMailDomain;
        if (id === mailDomain.id) return mailDomain;
        if (id === remoteMailDomain.id) return remoteMailDomain;
        return null;
      },
    },
    domainRegistry: {
      async getDomain(id) { return domains.get(id) ?? null; },
    },
    mailboxRegistry: {
      async getMailbox(id) { return id === currentMailbox?.id ? currentMailbox : null; },
      async listMailboxes({ mailDomainId } = {}) {
        return mailDomainId === currentMailDomain.id ? mailboxes : [];
      },
    },
    mailAliasRegistry: {
      async listAliases({ mailDomainId } = {}) {
        return mailDomainId === currentMailDomain.id ? aliases : [];
      },
    },
    mailboxQuotaRegistry: {
      async getQuota(id) { return id === currentMailbox?.id ? quota : null; },
    },
    mailboxForwardingRegistry: {
      async getForwarding(id) { return id === currentMailbox?.id ? forwarding : null; },
    },
    mailDkimRegistry: {
      async getKey(id) { return id === currentMailDomain.id ? dkim : null; },
    },
    jobRegistry: {
      async listJobs(filter) {
        assert.deepEqual(filter, { resourceType: 'mail_domain', resourceId: currentMailDomain.id });
        return jobs;
      },
    },
    mailDataInspector: {
      async inspectMailbox(address) {
        assert.equal(address, currentMailbox.address);
        return { version: 1, scope: 'mailbox', identity: address, sideEffects: false, ...mailboxData };
      },
      async inspectDomain(domainName) {
        assert.equal(domainName, currentMailDomain.domainName);
        return { version: 1, scope: 'domain', identity: domainName, sideEffects: false, ...domainData };
      },
    },
  });
}

test('mailbox delete impact reports quota, forwarding, alias, active job and data backup blockers', async () => {
  const aliases = [{
    id: randomUUID(),
    source: 'info@example.com',
    destinations: ['owner@example.com', 'outside@example.net'],
  }];
  const jobs = [
    { id: randomUUID(), status: 'queued' },
    { id: randomUUID(), status: 'running' },
    { id: randomUUID(), status: 'succeeded' },
  ];
  const service = createService({
    aliases,
    quota: { mailboxId: mailbox.id, quotaBytes: 1024 },
    forwarding: { mailboxId: mailbox.id, destinations: ['outside@example.net'] },
    jobs,
    mailboxData: { present: true, bytes: 8192, snapshotSha256: 'c'.repeat(64) },
  });
  const result = await service.inspectMailbox(mailbox.id);

  assert.equal(result.safeToDelete, false);
  assert.equal(result.requiresDataBackup, true);
  assert.equal(result.mailData.bytes, 8192);
  assert.deepEqual(result.blockers.map((entry) => entry.code), [
    'mailbox_quota_configured',
    'mailbox_forwarding_configured',
    'mailbox_alias_reference_configured',
    'mail_domain_job_active',
    'mail_data_backup_required',
  ]);
  assert.equal(result.dependencies.aliasReferences.count, 1);
  assert.equal(result.dependencies.activeJobs.count, 2);
  assert.equal(result.confirmation, 'delete-mailbox:owner@example.com');
  assert.equal(result.sideEffects, false);
  assert.doesNotMatch(JSON.stringify(result), /password|hash|ciphertext|outside@example\.net/);
});

test('mailbox delete impact is safe only when dependencies and mail data are absent', async () => {
  const service = createService({ mailboxes: [mailbox] });
  const result = await service.inspectMailbox(mailbox.id);
  assert.equal(result.safeToDelete, true);
  assert.equal(result.requiresDataBackup, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.dependencies.aliasReferences.count, 0);
  assert.equal(result.dependencies.activeJobs.count, 0);
});

test('mailbox alias references are bounded to fifty public identities', async () => {
  const aliases = Array.from({ length: 73 }, (_, index) => ({
    id: `alias-${String(index).padStart(3, '0')}`,
    source: `source${index}@example.com`,
    destinations: [mailbox.address],
  }));
  const result = await createService({ aliases }).inspectMailbox(mailbox.id);
  assert.equal(result.dependencies.aliasReferences.count, 73);
  assert.equal(result.dependencies.aliasReferences.ids.length, 50);
  assert.equal(result.dependencies.aliasReferences.truncated, true);
});

test('mail-domain delete impact requires disabled empty state, no DKIM or job, and backed-up data', async () => {
  const aliases = [{ id: randomUUID(), source: 'info@example.com', destinations: ['outside@example.net'] }];
  const jobs = [{ id: randomUUID(), status: 'running' }];
  const service = createService({
    currentMailDomain: enabledMailDomain,
    mailboxes: [mailbox],
    aliases,
    dkim: { selector: 'mail-2026' },
    jobs,
    domainData: { present: true, bytes: 65_536, snapshotSha256: 'd'.repeat(64) },
  });
  const result = await service.inspectMailDomain(enabledMailDomain.id);

  assert.equal(result.safeToDelete, false);
  assert.equal(result.requiresDataBackup, true);
  assert.deepEqual(result.blockers.map((entry) => entry.code), [
    'mail_domain_disable_required',
    'mail_domain_mailboxes_exist',
    'mail_domain_aliases_exist',
    'mail_domain_dkim_key_exists',
    'mail_domain_job_active',
    'mail_data_backup_required',
  ]);
  assert.equal(result.dependencies.mailboxes.count, 1);
  assert.equal(result.dependencies.aliases.count, 1);
  assert.equal(result.dependencies.dkimConfigured, true);
  assert.equal(result.confirmation, `delete-mail-domain:${enabledMailDomain.id}:${enabledMailDomain.revision}`);
});

test('mail-domain delete impact is safe only for local disabled empty state with no data', async () => {
  const result = await createService({ mailboxes: [] }).inspectMailDomain(mailDomain.id);
  assert.equal(result.safeToDelete, true);
  assert.equal(result.requiresDataBackup, false);
  assert.deepEqual(result.blockers, []);
});

test('impact rejects remote host scope before inspecting mail data', async () => {
  let dataCalls = 0;
  const service = createMailDeleteImpactService({
    localServerId: serverId,
    mailDomainRegistry: {
      async getMailDomain() { return remoteMailDomain; },
    },
    domainRegistry: {
      async getDomain() { return remoteWebDomain; },
    },
    mailboxRegistry: {
      async getMailbox() { return { ...mailbox, mailDomainId: remoteMailDomain.id }; },
      async listMailboxes() { return []; },
    },
    mailAliasRegistry: { async listAliases() { return []; } },
    mailboxQuotaRegistry: { async getQuota() { return null; } },
    mailboxForwardingRegistry: { async getForwarding() { return null; } },
    mailDkimRegistry: { async getKey() { return null; } },
    jobRegistry: { async listJobs() { return []; } },
    mailDataInspector: {
      async inspectMailbox() { dataCalls += 1; return {}; },
      async inspectDomain() { dataCalls += 1; return {}; },
    },
  });

  await assert.rejects(
    service.inspectMailbox(mailbox.id),
    (error) => error instanceof MailDeleteImpactError && error.code === 'mail_domain_not_found' && error.status === 404,
  );
  assert.equal(dataCalls, 0);
});
