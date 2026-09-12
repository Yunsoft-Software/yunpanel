import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRoundcubeConfigBackupManager,
  RoundcubeConfigBackupError,
} from '../src/roundcube-config-backup.js';

const TX = '12345678-1234-4234-8234-123456789012';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-roundcube-backup-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('backs up and restores exact live config/FPM files and removes newly-created database', async () => withTempDirectory(async (root) => {
  const configPath = path.join(root, 'config.inc.php');
  const fpmPoolPath = path.join(root, 'pool.conf');
  const databasePath = path.join(root, 'roundcube.sqlite');
  const backupRoot = path.join(root, 'backups');
  await writeFile(configPath, 'old-secret-config\n', { mode: 0o640 });
  await writeFile(fpmPoolPath, 'old-fpm\n', { mode: 0o600 });
  await chmod(configPath, 0o640);
  await chmod(fpmPoolPath, 0o600);

  const manager = createRoundcubeConfigBackupManager({
    backupRoot,
    configPath,
    fpmPoolPath,
    databasePath,
    chownFn: async () => {},
  });
  const backup = await manager.backupConfiguration(TX);
  assert.equal(backup.databaseExisted, false);
  assert.equal(backup.files[0].exists, true);
  assert.equal(backup.files[1].exists, true);
  assert.equal((await stat(backupRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(manager.transactionDirectory(TX), 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(manager.transactionDirectory(TX), 'config.inc.php'))).mode & 0o777, 0o600);

  await writeFile(configPath, 'new-config\n');
  await writeFile(fpmPoolPath, 'new-fpm\n');
  await writeFile(databasePath, 'new-database');
  const restored = await manager.restoreConfiguration(TX);
  assert.equal(restored.restored, true);
  assert.equal(restored.databaseRemoved, true);
  assert.equal(await readFile(configPath, 'utf8'), 'old-secret-config\n');
  assert.equal(await readFile(fpmPoolPath, 'utf8'), 'old-fpm\n');
  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.equal((await stat(fpmPoolPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(databasePath), { code: 'ENOENT' });
}));

test('rollback leaves a pre-existing Roundcube database untouched', async () => withTempDirectory(async (root) => {
  const configPath = path.join(root, 'config.inc.php');
  const fpmPoolPath = path.join(root, 'pool.conf');
  const databasePath = path.join(root, 'roundcube.sqlite');
  await writeFile(configPath, 'old-config');
  await writeFile(fpmPoolPath, 'old-fpm');
  await writeFile(databasePath, 'existing-user-data');
  const manager = createRoundcubeConfigBackupManager({
    backupRoot: path.join(root, 'backups'),
    configPath,
    fpmPoolPath,
    databasePath,
    chownFn: async () => {},
  });
  await manager.backupConfiguration(TX);
  await writeFile(databasePath, 'existing-user-data-after-config-change');
  const restored = await manager.restoreConfiguration(TX);
  assert.equal(restored.databaseRemoved, false);
  assert.equal(await readFile(databasePath, 'utf8'), 'existing-user-data-after-config-change');
}));

test('backup rejects symlink live targets and duplicate transaction IDs', async () => withTempDirectory(async (root) => {
  const configPath = path.join(root, 'config.inc.php');
  const target = path.join(root, 'real-config');
  const fpmPoolPath = path.join(root, 'pool.conf');
  await writeFile(target, 'secret');
  await symlink(target, configPath);
  await writeFile(fpmPoolPath, 'fpm');
  const manager = createRoundcubeConfigBackupManager({
    backupRoot: path.join(root, 'backups'),
    configPath,
    fpmPoolPath,
    databasePath: path.join(root, 'db.sqlite'),
  });
  await assert.rejects(
    manager.backupConfiguration(TX),
    (error) => error instanceof RoundcubeConfigBackupError && error.code === 'roundcube_backup_target_unsafe',
  );

  await rm(configPath);
  await writeFile(configPath, 'safe');
  await manager.backupConfiguration(TX);
  await assert.rejects(
    manager.backupConfiguration(TX),
    (error) => error instanceof RoundcubeConfigBackupError && error.code === 'roundcube_backup_exists',
  );
}));