import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDatabaseDumpManager, createDatabaseRestoreManager } from '@yunpanel/host-runtime';
import { createWebsiteDatabaseBackupAdapter } from '../src/website-database-backup-adapter.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

test('website SQL backup reuses native streaming artifacts and restore verifies a fresh live dump', async t => {
  const stagedRoot = await mkdtemp(path.join(os.tmpdir(), 'yp-site-db-'));
  t.after(() => rm(stagedRoot, { recursive: true, force: true }));
  const databaseName = 'owned_schema';
  let liveSql = 'CREATE TABLE owned_table (id INT); INSERT INTO owned_table VALUES (7);\n';
  const original = liveSql;
  const databaseManager = { inspect: async () => ({ engine: 'mariadb', version: '10.11.test', databases: [{ name: databaseName }] }),
    dropDatabase: async name => { assert.equal(name, databaseName); liveSql = ''; } };
  const dumpToFile = async ({ databaseName: name, outputPath }) => { assert.equal(name, databaseName); await writeFile(outputPath, liveSql, { mode: 0o600, flag: 'wx' }); };
  const receipts = [];
  const adapter = createWebsiteDatabaseBackupAdapter({ databaseManager,
    dumpManagerFactory: options => createDatabaseDumpManager({ ...options, dumpToFile }),
    restoreManagerFactory: options => createDatabaseRestoreManager({ ...options, dumpToFile,
      restoreFromFile: async ({ dumpPath }) => { liveSql = await readFile(dumpPath, 'utf8'); } }),
    receiptStoreFactory: () => ({ write: async result => { receipts.push(result); return result; } }),
  });
  const directory = path.join(stagedRoot, 'databases', `website-${bindingId}`);
  const database = { bindingId, databaseName, dumpHook: { stagedBackupDirectory: directory, stagedDumpPath: path.join(directory, 'dump.sql') } };
  const backupSet = { website: { id: websiteId }, stagedRoot, databases: [database] };
  const snapshot = await adapter.backup(backupSet, database);
  assert.equal(snapshot.backedUp, true);
  assert.equal(await readFile(database.dumpHook.stagedDumpPath, 'utf8'), original);
  liveSql = 'INSERT INTO owned_table VALUES (99);\n';
  const results = await adapter.restore({ backupSet, include: [directory], operationId });
  assert.equal(liveSql, original); assert.equal(results[0].dumpSha256, snapshot.dumpSha256);
  assert.equal(receipts[0].verified, true); assert.equal(results[0].verified, true);
  assert.deepEqual(await adapter.restore({ backupSet, include: ['/other-site/files'], operationId }), []);
});

test('website SQL adapter rejects forged binding paths before running a native tool', async () => {
  let calls = 0;
  const adapter = createWebsiteDatabaseBackupAdapter({ databaseManager: { inspect: async () => { calls++; } } });
  const set = { website: { id: websiteId }, stagedRoot: '/var/lib/yunpanel/backups/resources/website/owned' };
  await assert.rejects(adapter.backup(set, { bindingId, databaseName: 'own', dumpHook: { stagedBackupDirectory: '/another/site' } }), error => error.code === 'website_database_backup_scope_invalid');
  assert.equal(calls, 0);
});
