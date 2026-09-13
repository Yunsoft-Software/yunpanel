import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDatabaseDumpManager,
  DatabaseDumpError,
  databaseDumpManagerInternals,
} from '../src/database-dump-manager.js';

async function fixture(t, { databases = [{ name: 'app_main', sizeBytes: 1024 }] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-db-dump-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const manager = createDatabaseDumpManager({
    root,
    databaseManager: {
      async inspect() {
        calls.push(['inspect']);
        return { engine: 'mariadb', version: '10.11.13-MariaDB', databases };
      },
    },
    dumpToFile: async (input) => {
      calls.push(['dump', input]);
      await writeFile(input.outputPath, '-- private SQL dump fixture\nCREATE TABLE t (id INT);\n', { mode: 0o600 });
    },
    now: () => Date.parse('2026-09-13T03:30:00.000Z'),
    randomSuffix: () => '0123456789abcdef',
  });
  return { root, calls, manager };
}

test('backup commits a private verified artifact and returns only safe metadata', async (t) => {
  const fx = await fixture(t);
  const result = await fx.manager.backup({ backupId: 'backup-0001', databaseName: 'app_main' });

  assert.deepEqual(Object.keys(result).sort(), [
    'backedUp', 'backupId', 'createdAt', 'databaseName', 'databaseVersion',
    'dumpBytes', 'dumpSha256', 'engine', 'sideEffects', 'version',
  ].sort());
  assert.equal(result.backedUp, true);
  assert.equal(result.sideEffects, true);
  assert.equal(result.databaseName, 'app_main');
  assert.match(result.dumpSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, 'dumpPath'), false);
  assert.equal(JSON.stringify(result).includes('CREATE TABLE'), false);

  const directory = fx.manager.directoryFor('backup-0001');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'dump.sql'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'manifest.json'))).mode & 0o777, 0o600);

  const inspected = await fx.manager.inspectBackup('backup-0001');
  assert.deepEqual(inspected, result);
  const materialized = await fx.manager.materializeBackup('backup-0001');
  assert.equal(materialized.dumpPath, path.join(directory, 'dump.sql'));
  assert.equal(materialized.dumpSha256, result.dumpSha256);
  assert.equal(fx.calls.filter(([name]) => name === 'dump').length, 1);
});

test('same backup identity is idempotent but cannot be rebound to another schema', async (t) => {
  const fx = await fixture(t, {
    databases: [{ name: 'app_main', sizeBytes: 1 }, { name: 'analytics', sizeBytes: 2 }],
  });
  const first = await fx.manager.backup({ backupId: 'backup-0002', databaseName: 'app_main' });
  const second = await fx.manager.backup({ backupId: 'backup-0002', databaseName: 'app_main' });
  assert.deepEqual(second, first);
  assert.equal(fx.calls.filter(([name]) => name === 'dump').length, 1);

  await assert.rejects(
    fx.manager.backup({ backupId: 'backup-0002', databaseName: 'analytics' }),
    (error) => error instanceof DatabaseDumpError && error.code === 'database_backup_identity_conflict',
  );
});

test('missing or unsafe schema fails before dump execution', async (t) => {
  const fx = await fixture(t, { databases: [] });
  await assert.rejects(
    fx.manager.backup({ backupId: 'backup-0003', databaseName: 'app_main' }),
    (error) => error instanceof DatabaseDumpError && error.code === 'database_backup_database_not_found',
  );
  await assert.rejects(
    fx.manager.backup({ backupId: 'backup-0004', databaseName: 'mysql' }),
    (error) => error instanceof DatabaseDumpError && error.code === 'database_backup_name_invalid',
  );
  assert.equal(fx.calls.some(([name]) => name === 'dump'), false);
});

test('checksum, size and permissions are revalidated before materialization', async (t) => {
  const fx = await fixture(t);
  await fx.manager.backup({ backupId: 'backup-0005', databaseName: 'app_main' });
  const dumpPath = path.join(fx.manager.directoryFor('backup-0005'), 'dump.sql');
  await writeFile(dumpPath, 'tampered\n', { mode: 0o600 });
  await assert.rejects(
    fx.manager.materializeBackup('backup-0005'),
    (error) => error instanceof DatabaseDumpError && error.code === 'database_backup_integrity_failed',
  );

  await rm(fx.manager.directoryFor('backup-0005'), { recursive: true, force: true });
  await fx.manager.backup({ backupId: 'backup-0005', databaseName: 'app_main' });
  await chmod(path.join(fx.manager.directoryFor('backup-0005'), 'manifest.json'), 0o644);
  await assert.rejects(
    fx.manager.inspectBackup('backup-0005'),
    (error) => error instanceof DatabaseDumpError && error.code === 'database_backup_permissions_invalid',
  );
});

test('default dump arguments stay socket-only and credential-free', () => {
  const args = databaseDumpManagerInternals.dumpArgs('app_main');
  assert.ok(args.includes('--protocol=socket'));
  assert.ok(args.includes('--single-transaction'));
  assert.deepEqual(args.slice(-2), ['--databases', 'app_main']);
  assert.equal(args.some((value) => /password|user=|host=|socket=/i.test(value)), false);
  assert.deepEqual(databaseDumpManagerInternals.dumpPrograms, ['/usr/bin/mariadb-dump', '/usr/bin/mysqldump']);
});
