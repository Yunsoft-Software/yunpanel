import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mailSqlTemplatePolicy } from '@yunpanel/config-templates';
import { createMailboxRegistry } from '../src/mailbox-registry.js';
import { createMailAliasRegistry } from '../src/mail-alias-registry.js';
import { createMailboxQuotaRegistry } from '../src/mailbox-quota-registry.js';
import { createMailboxForwardingRegistry } from '../src/mailbox-forwarding-registry.js';
import { createMailConfigurationService } from '../src/mail-configuration.js';
import { createWebsiteMailBackupAdapter } from '../src/website-mail-backup-adapter.js';
import { createWebsiteResourceBackupCodec } from '../src/website-resource-backup-codec.js';
import { verifyMailboxPassword } from '../src/mailbox-password.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-mail-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const masterKey = randomBytes(32);
  const website = { id: randomUUID(), serverId: randomUUID() };
  const webDomain = { id: randomUUID(), websiteId: website.id, serverId: website.serverId };
  const domain = { id: randomUUID(), webDomainId: webDomain.id, domainName: 'owned.example', managementMode: 'local', status: 'enabled', revision: 1 };
  const sibling = { ...domain, id: randomUUID(), domainName: 'sibling.example', webDomainId: randomUUID() };
  const mailDomainRegistry = {
    getMailDomain: async id => [domain, sibling].find(item => item.id === id) ?? null,
    listMailDomains: async () => [domain, sibling],
  };
  const mailboxRegistry = createMailboxRegistry({ filePath: path.join(root, 'mailboxes.json'), masterKey, getMailDomain: mailDomainRegistry.getMailDomain });
  await mailboxRegistry.init();
  const first = await mailboxRegistry.createMailbox({ mailDomainId: domain.id, address: 'first@owned.example', password: 'first original password' });
  const second = await mailboxRegistry.createMailbox({ mailDomainId: domain.id, address: 'second@owned.example', password: 'second original password' });
  const other = await mailboxRegistry.createMailbox({ mailDomainId: sibling.id, address: 'other@sibling.example', password: 'sibling original password' });
  const mailboxQuotaRegistry = createMailboxQuotaRegistry({ getMailbox: mailboxRegistry.getMailbox });
  const mailboxForwardingRegistry = createMailboxForwardingRegistry({ getMailbox: mailboxRegistry.getMailbox });
  const mailAliasRegistry = createMailAliasRegistry({ getMailDomain: mailDomainRegistry.getMailDomain, listMailboxes: mailboxRegistry.listMailboxes });
  await mailboxQuotaRegistry.setQuota(first.id, { expectedRevision: 0, quotaBytes: 128 * 1024 * 1024 });
  await mailboxForwardingRegistry.setForwarding(first.id, { expectedRevision: 0, mode: 'copy', destinations: ['second@owned.example'] });
  const alias = await mailAliasRegistry.createAlias({ mailDomainId: domain.id, source: 'info@owned.example', destinations: ['first@owned.example'] });
  const service = createMailConfigurationService({ mailDomainRegistry, mailboxRegistry, mailAliasRegistry, mailboxQuotaRegistry, mailboxForwardingRegistry });
  const sqlPath = path.join(root, 'virtual.sqlite3');
  const db = new DatabaseSync(sqlPath);
  t.after(() => db.close());
  await chmod(sqlPath, 0o600);
  async function synchronize() {
    const input = { mailDomainId: domain.id, expectedRevision: domain.revision, status: domain.status };
    const preview = await service.previewCurrent(input);
    const bundle = await service.materializeCurrent(input, { expectedConfigurationSha256: preview.configurationSha256 });
    db.exec(bundle.sensitiveArtifacts.find(item => item.path === mailSqlTemplatePolicy.seedPath).content);
  }
  await synchronize();
  let staged;
  const calls = [];
  const nativeData = { backupId: `website-${domain.id}`, scope: 'domain', identity: domain.domainName,
    sourcePresent: true, sourceSnapshotSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), files: 1, directories: 1, bytes: 4 };
  const dataCalls = [];
  const adapter = createWebsiteMailBackupAdapter({
    domainRegistry: { getDomain: async id => id === webDomain.id ? webDomain : null },
    mailDomainRegistry, mailboxRegistry, mailAliasRegistry, mailboxQuotaRegistry, mailboxForwardingRegistry,
    mailConfigurationService: service, codec: createWebsiteResourceBackupCodec({ masterKey }), sqlPath,
    mailDataInspector: { inspectDomain: async identity => { assert.equal(identity, domain.domainName); return { present: true, snapshotSha256: nativeData.sourceSnapshotSha256 }; } },
    dataBackupFactory: ({ backupRoot }) => {
      assert.equal(backupRoot, path.join(root, 'staged', 'mail-data'));
      return {
        backup: async request => { assert.deepEqual(request, { backupId: nativeData.backupId, scope: 'domain', identity: domain.domainName, expectedSnapshotSha256: nativeData.sourceSnapshotSha256 }); return nativeData; },
        materializeBackup: async backupId => { assert.equal(backupId, nativeData.backupId); return { manifest: nativeData, dataPath: '/private-fixture/data' }; },
      };
    },
    dataRestoreFactory: () => ({ restore: async request => { dataCalls.push(request); return { applied: true, contentSha256: nativeData.contentSha256 }; }, inspectRestored: async () => ({ satisfied: true }) }),
    accessGuard: { quiesce: async address => { dataCalls.push({ quiesce: address }); return { accessDisabled: true, sessionsCleared: true }; } },
    configManager: { stageConfiguration: async (preview, options) => { staged = { preview, ...options }; calls.push('stage'); } },
    backupManager: { backupConfiguration: async () => { calls.push('backup'); return { planSha256: 'fixture-plan' }; } },
    activator: { activateConfiguration: async preview => {
      calls.push('apply'); db.exec(staged.sensitiveArtifacts.find(item => item.path === mailSqlTemplatePolicy.seedPath).content);
      return { applied: true, sideEffects: true, previewSha256: preview.sha256, planSha256: 'fixture-plan' };
    } },
  });
  const stagedRoot = path.join(root, 'staged');
  const mail = { mailDomainId: domain.id, domainName: domain.domainName, webDomainId: webDomain.id, managementMode: 'local',
    storagePath: '/var/lib/yunpanel/mail/owned.example', virtualMailDbSnapshot: path.join(stagedRoot, 'mail', 'owned.example-virtual.json'),
    stagedDataDirectory: path.join(stagedRoot, 'mail-data', nativeData.backupId) };
  const backupSet = { website, stagedRoot, mail: [mail] };
  return { adapter, backupSet, mail, db, mailboxRegistry, mailAliasRegistry, mailboxQuotaRegistry,
    mailboxForwardingRegistry, domain, sibling, first, second, other, alias, calls, synchronize, masterKey, root, dataCalls };
}

test('protected mail catalog restores real SQLite rows, passwords, quotas and forwarding while preserving siblings', async t => {
  const fx = await fixture(t);
  const beforeSibling = fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName);
  const siblingRecord = await fx.mailboxRegistry.getMailbox(fx.other.id);
  await fx.adapter.capture(fx.backupSet, fx.mail);
  const raw = await readFile(fx.mail.virtualMailDbSnapshot, 'utf8');
  assert.doesNotMatch(raw, /first original password|argon2id|first@owned/);
  assert.equal((await stat(fx.mail.virtualMailDbSnapshot)).mode & 0o777, 0o600);
  const changed = await fx.mailboxRegistry.rotatePassword(fx.first.id, { expectedRevision: 1, password: 'changed account password' });
  await fx.mailboxQuotaRegistry.setQuota(fx.first.id, { expectedRevision: 1, quotaBytes: 256 * 1024 * 1024 });
  await fx.mailboxForwardingRegistry.clearForwarding(fx.first.id, { expectedRevision: 1, confirmation: `clear-mailbox-forwarding:${fx.first.id}` });
  await fx.mailAliasRegistry.deleteAlias(fx.alias.id, { expectedRevision: 1, confirmation: 'delete-mail-alias:info@owned.example' });
  await fx.synchronize();
  const result = await fx.adapter.restore({ backupSet: fx.backupSet, include: [fx.mail.virtualMailDbSnapshot], operationId: randomUUID() });
  assert.equal(result[0].verified, true);
  assert.deepEqual(fx.calls, ['stage', 'backup', 'apply']);
  const restored = await fx.mailboxRegistry.getMailbox(fx.first.id);
  assert.ok(restored.revision > changed.revision);
  const hash = fx.db.prepare('SELECT password FROM virtual_mailboxes WHERE address = ?').get(fx.first.address).password;
  assert.equal(await verifyMailboxPassword('first original password', hash.replace(/^\{ARGON2ID\}/, '')), true);
  assert.equal((await fx.mailboxQuotaRegistry.getQuota(fx.first.id)).quotaBytes, 128 * 1024 * 1024);
  assert.equal((await fx.mailboxForwardingRegistry.getForwarding(fx.first.id)).mode, 'copy');
  assert.equal((await fx.mailAliasRegistry.getAlias(fx.alias.id)).source, 'info@owned.example');
  assert.deepEqual(fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName), beforeSibling);
  assert.deepEqual(await fx.mailboxRegistry.getMailbox(fx.other.id), siblingRecord);
  const reopened = createMailboxRegistry({ filePath: path.join(fx.root, 'mailboxes.json'), masterKey: fx.masterKey,
    getMailDomain: async id => [fx.domain, fx.sibling].find(item => item.id === id) });
  await reopened.init();
  assert.deepEqual(await reopened.getMailbox(fx.first.id), restored);
});

test('mail snapshot cannot be rebound to another Website and rejects unapplied catalog drift', async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.adapter.capture({ ...fx.backupSet, website: { ...fx.backupSet.website, id: randomUUID() } }, fx.mail), { code: 'website_mail_backup_scope_invalid' });
  await fx.mailboxRegistry.rotatePassword(fx.first.id, { expectedRevision: 1, password: 'pending not applied password' });
  await assert.rejects(fx.adapter.capture(fx.backupSet, fx.mail), { code: 'website_mail_backup_unapplied_state' });
  assert.deepEqual(fx.calls, []);
});

test('a snapshot missing an empty Maildir directory cannot be reported as a verified mail backup', async t => {
  const fx = await fixture(t);
  await fx.adapter.capture(fx.backupSet, fx.mail);
  const dataRoot = path.join(fx.mail.stagedDataDirectory, 'data');
  const nodes = [
    { path: fx.mail.virtualMailDbSnapshot, type: 'file', size: 1024 },
    { path: path.join(fx.mail.stagedDataDirectory, 'manifest.json'), type: 'file', size: 1024 },
    { path: dataRoot, type: 'dir', size: 0 },
    { path: path.join(dataRoot, 'tmp'), type: 'dir', size: 0 },
    { path: path.join(dataRoot, 'message'), type: 'file', size: 4 },
  ];
  assert.equal((await fx.adapter.verifySnapshot(fx.backupSet, nodes)).verified, true);
  await assert.rejects(fx.adapter.verifySnapshot(fx.backupSet, nodes.filter(node => node.path !== path.join(dataRoot, 'tmp'))), { code: 'website_mail_snapshot_unverified' });
  await assert.rejects(fx.adapter.verifySnapshot(fx.backupSet, nodes.map(node => node.type === 'file' && node.path.endsWith('message') ? { ...node, size: 3 } : node)), { code: 'website_mail_snapshot_unverified' });
});

test('full mail selection disables only the selected Domain before the existing message restore engine runs', async t => {
  const fx = await fixture(t);
  await fx.adapter.capture(fx.backupSet, fx.mail);
  const siblingBefore = fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName);
  await fx.adapter.restore({ backupSet: fx.backupSet, include: [fx.backupSet.stagedRoot], operationId: randomUUID() });
  assert.deepEqual(fx.calls, ['stage', 'backup', 'apply', 'stage', 'backup', 'apply']);
  assert.deepEqual(fx.dataCalls.slice(0, 2).map(call => call.quiesce).sort(), [fx.first.address, fx.second.address].sort());
  assert.equal(fx.dataCalls[2].scope, 'domain');
  assert.equal(fx.dataCalls[2].identity, fx.domain.domainName);
  assert.equal(fx.dataCalls[2].expectedTargetSnapshotSha256, 'a'.repeat(64));
  assert.deepEqual(fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName), siblingBefore);
  assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM virtual_mailboxes WHERE domain = ?').get(fx.domain.domainName).count, 2);
});

test('restoring an older Domain removes several newer account policies together without touching a sibling', async t => {
  const fx = await fixture(t);
  await fx.adapter.capture(fx.backupSet, fx.mail);
  const added = [];
  for (const localPart of ['new-a', 'new-b']) {
    const box = await fx.mailboxRegistry.createMailbox({ mailDomainId: fx.domain.id, address: `${localPart}@owned.example`, password: 'new account password' });
    await fx.mailboxForwardingRegistry.setForwarding(box.id, { expectedRevision: 0, mode: 'copy', destinations: ['second@owned.example'] });
    await fx.mailboxQuotaRegistry.setQuota(box.id, { expectedRevision: 0, quotaBytes: 128 * 1024 * 1024 });
    added.push(box.id);
  }
  await fx.synchronize();
  await fx.adapter.restore({ backupSet: fx.backupSet, include: [fx.mail.virtualMailDbSnapshot], operationId: randomUUID() });
  for (const id of added) assert.equal(await fx.mailboxRegistry.getMailbox(id), null);
  assert.deepEqual((await fx.mailboxForwardingRegistry.listForwardings()).map(policy => policy.mailboxId), [fx.first.id]);
  assert.deepEqual((await fx.mailboxQuotaRegistry.listQuotas()).map(policy => policy.mailboxId), [fx.first.id]);
  assert.equal((await fx.mailboxRegistry.getMailbox(fx.other.id)).revision, 1);
});

test('scoped mailbox recovery recreates a deleted UUID with a fresh revision and rejects a foreign scope', async t => {
  const fx = await fixture(t);
  const snapshot = await fx.mailboxRegistry.exportDomainBackup(fx.domain.id);
  await fx.mailboxRegistry.deleteMailbox(fx.second.id, { expectedRevision: 1, confirmation: `delete-mailbox:${fx.second.address}` });
  await fx.mailboxRegistry.restoreDomainBackup(fx.domain.id, snapshot);
  assert.ok((await fx.mailboxRegistry.getMailbox(fx.second.id)).revision > 1);
  await assert.rejects(fx.mailboxRegistry.restoreDomainBackup(fx.sibling.id, snapshot), { code: 'backup_catalog_scope_invalid' });
  assert.equal((await fx.mailboxRegistry.getMailbox(fx.other.id)).revision, 1);
});

test('a sibling with pending password changes blocks global activation and leaves its actual SQL untouched', async t => {
  const fx = await fixture(t);
  await fx.adapter.capture(fx.backupSet, fx.mail);
  const siblingBefore = fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName);
  await fx.mailboxRegistry.rotatePassword(fx.other.id, { expectedRevision: 1, password: 'sibling pending password' });
  await assert.rejects(fx.adapter.restore({ backupSet: fx.backupSet, include: [fx.mail.virtualMailDbSnapshot], operationId: randomUUID() }), { code: 'website_mail_restore_sibling_drift' });
  assert.deepEqual(fx.calls, []);
  assert.deepEqual(fx.db.prepare('SELECT * FROM virtual_mailboxes WHERE domain = ?').all(fx.sibling.domainName), siblingBefore);
});

test('resource backup authentication binds website, resource and type without exposing plaintext', () => {
  const codec = createWebsiteResourceBackupCodec({ masterKey: randomBytes(32) });
  const identity = { websiteId: randomUUID(), resourceId: randomUUID(), kind: 'mail' };
  const source = codec.encode(identity, { credential: 'private fixture value' });
  assert.equal(codec.decode(identity, source).credential, 'private fixture value');
  assert.doesNotMatch(source, /private fixture value/);
  for (const identityOverride of [{ websiteId: randomUUID() }, { resourceId: randomUUID() }, { kind: 'environment' }]) {
    assert.throws(() => codec.decode({ ...identity, ...identityOverride }, source), { code: 'website_resource_backup_invalid' });
  }
  const tampered = JSON.parse(source); tampered.tag = randomBytes(16).toString('base64');
  assert.throws(() => codec.decode(identity, JSON.stringify(tampered)), { code: 'website_resource_backup_invalid' });
});
