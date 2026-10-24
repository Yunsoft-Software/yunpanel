import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mailSqlTemplatePolicy, mailDomainDataPath } from '@yunpanel/config-templates';
import { createMailConfigManager, createMailConfigBackupManager, createMailConfigActivator, createMailDataBackupManager, createMailDataRestoreManager, createMailDataDeleteManager, createMailDataInspector } from '@yunpanel/host-runtime';
import { createMailboxAccessGuard } from '../../../packages/host-runtime/src/mailbox-access-guard.js';
import { createWebsiteResourceBackupCodec } from './website-resource-backup-codec.js';

const within = (value, root) => value === root || value.startsWith(root + '/');
const fail = code => Object.assign(new Error('Website mail backup could not be applied safely'), { code, status: 409 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function transactionId(operationId, mailDomainId, rollback, phase = 'apply') {
  if (!/^[a-f0-9-]{36}$/.test(operationId ?? '')) throw fail('website_mail_restore_operation_invalid');
  const value = createHash('sha256').update(`${operationId}:${mailDomainId}:mail:${rollback}:${phase}`).digest('hex').slice(0, 32).split('');
  value[12] = '5'; value[16] = '8';
  const hex = value.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sqlRows(db, domainName, siblings = false) {
  const comparison = siblings ? '<>' : '=';
  return {
    domains: db.prepare(`SELECT domain, enabled FROM virtual_domains WHERE domain ${comparison} ? ORDER BY domain`).all(domainName).map(row => ({ ...row })),
    mailboxes: db.prepare(`SELECT address, domain, local_part, password, quota_bytes, enabled FROM virtual_mailboxes WHERE domain ${comparison} ? ORDER BY address`).all(domainName).map(row => ({ ...row })),
    aliases: db.prepare(`SELECT source, domain, destinations, enabled FROM virtual_aliases WHERE domain ${comparison} ? ORDER BY source`).all(domainName).map(row => ({ ...row })),
  };
}
export function createWebsiteMailBackupAdapter({ domainRegistry, mailDomainRegistry, mailboxRegistry, mailAliasRegistry,
  mailboxQuotaRegistry, mailboxForwardingRegistry, mailConfigurationService, codec = createWebsiteResourceBackupCodec(),
  sqlPath = mailSqlTemplatePolicy.databasePath, configManager = createMailConfigManager(),
  backupManager = createMailConfigBackupManager(), activator = createMailConfigActivator({ configManager, backupManager }),
  mailDataInspector = createMailDataInspector(), dataBackupFactory = createMailDataBackupManager,
  dataRestoreFactory = createMailDataRestoreManager, accessGuard = createMailboxAccessGuard(),
  dataDeleteFactory = createMailDataDeleteManager,
} = {}) {
  async function scope(backupSet, mail) {
    const website = backupSet.website;
    const domain = await domainRegistry.getDomain(mail.webDomainId);
    const current = await mailDomainRegistry.getMailDomain(mail.mailDomainId);
    const expected = path.posix.join(backupSet.stagedRoot, 'mail', `${mail.domainName}-virtual.json`);
    if (!website?.id || !domain || domain.websiteId !== website.id || domain.serverId !== website.serverId
      || !current || current.webDomainId !== domain.id || current.domainName !== mail.domainName
      || current.managementMode !== 'local' || mail.virtualMailDbSnapshot !== expected
      || mail.stagedDataDirectory !== path.posix.join(backupSet.stagedRoot, 'mail-data', `website-${current.id}`)
      || mail.storagePath !== mailDomainDataPath(current.domainName) || !codec.configured) throw fail('website_mail_backup_scope_invalid');
    return { current, target: expected, identity: { websiteId: website.id, resourceId: current.id, kind: 'mail' } };
  }
  function dataManager(backupSet) {
    return dataBackupFactory({ backupRoot: path.posix.join(backupSet.stagedRoot, 'mail-data'), mailDataInspector });
  }
  async function applyBundle(bundle, tx) {
    await configManager.stageConfiguration(bundle.preview, { sensitiveArtifacts: bundle.sensitiveArtifacts });
    const prior = await backupManager.backupConfiguration(bundle.preview, { transactionId: tx });
    const applied = await activator.activateConfiguration(bundle.preview, { transactionId: tx });
    if (!applied.applied || !applied.sideEffects || applied.previewSha256 !== bundle.preview.sha256
      || applied.planSha256 !== prior.planSha256) throw fail('website_mail_restore_unverified');
  }
  async function liveSql(domainName, siblings = false) {
    const metadata = await lstat(sqlPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o007) !== 0) throw fail('website_mail_sql_source_unsafe');
    const db = new DatabaseSync(sqlPath, { readOnly: true });
    try { return sqlRows(db, domainName, siblings); } finally { db.close(); }
  }
  async function desiredBundle(current) {
    const input = { mailDomainId: current.id, expectedRevision: current.revision, status: current.status };
    const preview = await mailConfigurationService.previewCurrent(input);
    if (!preview.readyToApply || !preview.configuration?.sha256) throw fail('website_mail_configuration_unavailable');
    return mailConfigurationService.materializeCurrent(input, { expectedConfigurationSha256: preview.configuration.sha256 });
  }
  function expectedSql(bundle, domainName, siblings = false) {
    const seed = bundle.sensitiveArtifacts.find(artifact => artifact.path === mailSqlTemplatePolicy.seedPath);
    if (!seed) throw fail('website_mail_sql_source_unavailable');
    const db = new DatabaseSync(':memory:');
    try { db.exec(seed.content); return sqlRows(db, domainName, siblings); } finally { db.close(); }
  }
  async function capture(backupSet, mail) {
    const target = await scope(backupSet, mail);
    const boxes = await mailboxRegistry.exportDomainBackup(mail.mailDomainId);
    const ids = boxes.records.map(box => box.id);
    const bundle = await desiredBundle(target.current);
    const native = await liveSql(mail.domainName);
    if (digest(native) !== digest(expectedSql(bundle, mail.domainName))
      || digest(await liveSql(mail.domainName, true)) !== digest(expectedSql(bundle, mail.domainName, true))) throw fail('website_mail_backup_unapplied_state');
    const inspectedData = await mailDataInspector.inspectDomain(mail.domainName);
    const dataManifest = await dataManager(backupSet).backup({ backupId: `website-${mail.mailDomainId}`, scope: 'domain',
      identity: mail.domainName, expectedSnapshotSha256: inspectedData.snapshotSha256 });
    if (dataManifest.identity !== mail.domainName || dataManifest.sourceSnapshotSha256 !== inspectedData.snapshotSha256
      || dataManifest.sourcePresent !== inspectedData.present) throw fail('website_mail_backup_data_unverified');
    const state = { version: 1, mailDomainId: target.current.id, domainName: target.current.domainName,
      status: target.current.status, mailboxes: boxes, aliases: await mailAliasRegistry.exportDomainBackup(mail.mailDomainId),
      quotas: await mailboxQuotaRegistry.exportMailboxBackup(ids), forwardings: await mailboxForwardingRegistry.exportMailboxBackup(ids), nativeSql: native, dataManifest };
    await mkdir(path.dirname(target.target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target.target), 0o700);
    const temporary = target.target + '.tmp';
    await writeFile(temporary, codec.encode(target.identity, state), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target.target);
    return { mailDomainId: mail.mailDomainId, verified: true, mailboxCount: ids.length };
  }
  function selected(backupSet, include) {
    return (backupSet.mail ?? []).filter(mail => mail.managementMode === 'local' && mail.virtualMailDbSnapshot
      && include.some(root => within(mail.virtualMailDbSnapshot, root)));
  }
  async function verifySnapshot(backupSet, nodes) {
    if (!Array.isArray(nodes)) throw fail('website_mail_snapshot_unverified');
    for (const mail of backupSet.mail ?? []) {
      if (mail.managementMode !== 'local') continue;
      const target = await scope(backupSet, mail);
      const saved = codec.decode(target.identity, await readFile(target.target, 'utf8'));
      const dataRoot = path.posix.join(mail.stagedDataDirectory, 'data');
      const dataNodes = nodes.filter(node => within(node.path, dataRoot));
      const files = dataNodes.filter(node => node.type === 'file');
      const directories = dataNodes.filter(node => node.type === 'dir' && node.path !== dataRoot);
      if (!nodes.some(node => node.path === target.target && node.type === 'file')
        || !nodes.some(node => node.path === path.posix.join(mail.stagedDataDirectory, 'manifest.json') && node.type === 'file')
        || dataNodes.some(node => !['file', 'dir'].includes(node.type))
        || files.length !== saved.dataManifest.files || directories.length !== saved.dataManifest.directories
        || files.reduce((sum, node) => sum + node.size, 0) !== saved.dataManifest.bytes) throw fail('website_mail_snapshot_unverified');
    }
    return { verified: true };
  }
  async function restore({ backupSet, include, operationId, rollback = false }) {
    const results = [];
    for (const mail of selected(backupSet, include)) {
      const target = await scope(backupSet, mail);
      const metadata = await lstat(target.target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || (metadata.mode & 0o077)) throw fail('website_mail_backup_file_unsafe');
      const saved = codec.decode(target.identity, await readFile(target.target, 'utf8'));
      if (saved.version !== 1 || saved.mailDomainId !== mail.mailDomainId || saved.domainName !== mail.domainName
        || !['enabled', 'disabled'].includes(saved.status) || !saved.nativeSql) throw fail('website_mail_backup_scope_invalid');
      const existingBoxes = await mailboxRegistry.listMailboxes({ mailDomainId: mail.mailDomainId });
      const existingIds = existingBoxes.map(box => box.id);
      await mailboxRegistry.restoreDomainBackup(mail.mailDomainId, saved.mailboxes);
      const ids = saved.mailboxes.records.map(box => box.id);
      const removedIds = existingIds.filter(id => !ids.includes(id));
      await mailAliasRegistry.restoreDomainBackup(mail.mailDomainId, saved.aliases);
      await mailboxQuotaRegistry.restoreMailboxBackup(ids, saved.quotas, { removedIds });
      await mailboxForwardingRegistry.restoreMailboxBackup(ids, saved.forwardings, { removedIds });
      let current = await mailDomainRegistry.getMailDomain(mail.mailDomainId);
      if (current.status !== saved.status) current = await mailDomainRegistry.transitionLocalStatus(current.id, { expectedRevision: current.revision, status: saved.status });
      const bundle = await desiredBundle(current);
      if (digest(expectedSql(bundle, mail.domainName)) !== digest(saved.nativeSql)) throw fail('website_mail_backup_catalog_mismatch');
      const siblingsBefore = await liveSql(mail.domainName, true);
      if (digest(siblingsBefore) !== digest(expectedSql(bundle, mail.domainName, true))) throw fail('website_mail_restore_sibling_drift');
      if (include.some(root => within(mail.stagedDataDirectory, root))) {
        const backupId = `website-${mail.mailDomainId}`;
        const dataBackup = dataManager(backupSet);
        const materialized = await dataBackup.materializeBackup(backupId);
        if (materialized.manifest.contentSha256 !== saved.dataManifest?.contentSha256
          || materialized.manifest.sourcePresent !== saved.dataManifest.sourcePresent) throw fail('website_mail_backup_data_unverified');
        const disabledInput = { mailDomainId: current.id, expectedRevision: current.revision, status: 'disabled' };
        let disabled = bundle;
        if (current.status !== 'disabled') {
          const preview = await mailConfigurationService.previewTransition(disabledInput);
          disabled = await mailConfigurationService.materializeTransition(disabledInput, {
            expectedPreviewDigest: preview.previewDigest, expectedConfigurationSha256: preview.configurationSha256,
          });
        }
        await applyBundle(disabled, transactionId(operationId, mail.mailDomainId, rollback, 'quiesce'));
        const addresses = new Set([...existingBoxes.map(box => box.address), ...saved.mailboxes.records.map(box => box.address)]);
        for (const address of addresses) {
          const proof = await accessGuard.quiesce(address);
          if (!proof.accessDisabled || !proof.sessionsCleared) throw fail('website_mail_restore_access_unverified');
        }
        const targetData = await mailDataInspector.inspectDomain(mail.domainName);
        if (materialized.manifest.sourcePresent) {
          const engine = dataRestoreFactory({ backupManager: dataBackup, mailDataInspector });
          const restored = await engine.restore({ transactionId: transactionId(operationId, mail.mailDomainId, rollback, 'data'),
            backupId, scope: 'domain', identity: mail.domainName, expectedTargetSnapshotSha256: targetData.snapshotSha256 });
          if (!restored.applied || restored.contentSha256 !== saved.dataManifest.contentSha256
            || !(await engine.inspectRestored({ backupId, scope: 'domain', identity: mail.domainName })).satisfied) throw fail('website_mail_restore_data_unverified');
        } else if (targetData.present) {
          const tx = transactionId(operationId, mail.mailDomainId, rollback, 'empty-data');
          const beforeId = `pre-empty-restore:${tx}`;
          await dataBackup.backup({ backupId: beforeId, scope: 'domain', identity: mail.domainName,
            expectedSnapshotSha256: targetData.snapshotSha256 });
          const engine = dataDeleteFactory({ backupManager: dataBackup, mailDataInspector, mailboxAccessGuard: accessGuard });
          const deleted = await engine.deleteData({ transactionId: tx, backupId: beforeId, scope: 'domain',
            identity: mail.domainName, expectedTargetSnapshotSha256: targetData.snapshotSha256 });
          if (!deleted.deleted || !(await engine.inspectDeleted({ transactionId: tx, backupId: beforeId,
            scope: 'domain', identity: mail.domainName })).satisfied) throw fail('website_mail_restore_data_unverified');
        }
      }
      const tx = transactionId(operationId, mail.mailDomainId, rollback);
      await applyBundle(bundle, tx);
      if (digest(await liveSql(mail.domainName)) !== digest(saved.nativeSql)
        || digest(await liveSql(mail.domainName, true)) !== digest(siblingsBefore)) throw fail('website_mail_restore_unverified');
      if (include.some(root => within(mail.stagedDataDirectory, root)) && !saved.dataManifest.sourcePresent
        && (await mailDataInspector.inspectDomain(mail.domainName)).present) throw fail('website_mail_restore_data_unverified');
      results.push({ mailDomainId: mail.mailDomainId, verified: true, mailboxCount: ids.length });
    }
    return results;
  }
  return Object.freeze({ capture, restore, selected, verifySnapshot });
}
