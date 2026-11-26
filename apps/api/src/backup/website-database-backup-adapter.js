import path from 'node:path';
import { createDatabaseDumpManager, createDatabaseRestoreManager, createDatabaseRestoreReceiptStore } from '@yunpanel/host-runtime';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const within = (value, root) => value === root || value.startsWith(root + '/');
const error = (code) => Object.assign(new Error('Site veritabanı yedeği doğrulanamadı'), { code, status: 409 });

export function createWebsiteDatabaseBackupAdapter({ databaseManager,
  dumpManagerFactory = createDatabaseDumpManager, restoreManagerFactory = createDatabaseRestoreManager,
  receiptStoreFactory = createDatabaseRestoreReceiptStore,
} = {}) {
  if (typeof databaseManager?.inspect !== 'function') throw new TypeError('Database backup adapter requires the native database manager');
  function context(backupSet, database) {
    if (!UUID.test(backupSet.website?.id ?? '') || !UUID.test(database.bindingId ?? '')
      || !/^[A-Za-z0-9_]{1,64}$/.test(database.databaseName ?? '') || !backupSet.stagedRoot
      || !path.posix.isAbsolute(backupSet.stagedRoot) || path.posix.normalize(backupSet.stagedRoot) !== backupSet.stagedRoot) throw error('website_database_backup_scope_invalid');
    const root = path.posix.join(backupSet.stagedRoot, 'databases');
    const backupId = `website-${database.bindingId}`;
    const directory = path.posix.join(root, backupId);
    if (database.dumpHook?.stagedBackupDirectory !== directory || database.dumpHook?.stagedDumpPath !== path.posix.join(directory, 'dump.sql')) throw error('website_database_backup_scope_invalid');
    return { root, backupId, directory, manager: dumpManagerFactory({ root, databaseManager }) };
  }
  async function backup(backupSet, database) {
    const target = context(backupSet, database);
    const result = await target.manager.backup({ backupId: target.backupId, databaseName: database.databaseName });
    if (result?.backedUp !== true || !result.dumpSha256 || result.dumpBytes < 1) throw error('website_database_backup_unverified');
    return result;
  }
  function selected(backupSet, include) {
    return (backupSet.databases ?? []).filter((database) => {
      const target = context(backupSet, database);
      return include.some((root) => within(target.directory, root) || within(root, target.directory));
    });
  }
  async function restore({ backupSet, include, operationId, rollback = false }) {
    if (!UUID.test(operationId ?? '')) throw error('website_database_restore_operation_invalid');
    const results = [];
    for (const database of selected(backupSet, include)) {
      const target = context(backupSet, database);
      const source = await target.manager.materializeBackup(target.backupId);
      if (source.databaseName !== database.databaseName) throw error('website_database_backup_scope_invalid');
      // The existing engine snapshots the live schema, restores, and compares a fresh dump checksum.
      const native = restoreManagerFactory({ databaseManager, backupManager: target.manager,
        transactionRoot: path.posix.join(backupSet.stagedRoot, '.database-transactions'),
        receiptStore: receiptStoreFactory({ root: path.posix.join(path.posix.dirname(backupSet.stagedRoot), '.database-restore-receipts') }),
      });
      const result = await native.restore({ transactionId: `${operationId}:${database.bindingId}${rollback ? ':rollback' : ''}`,
        backupId: target.backupId, databaseName: database.databaseName, expectedBackupSha256: source.dumpSha256 });
      if (result?.verified !== true || result.restored !== true || result.dumpSha256 !== source.dumpSha256) throw error('website_database_restore_unverified');
      results.push({ databaseName: database.databaseName, dumpSha256: source.dumpSha256, verified: true });
    }
    return results;
  }
  return Object.freeze({ backup, restore, selected });
}
