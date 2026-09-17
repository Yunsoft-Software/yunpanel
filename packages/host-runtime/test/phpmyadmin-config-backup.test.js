import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPhpMyAdminConfigBackupManager,
  PhpMyAdminConfigBackupError,
} from '../src/phpmyadmin-config-backup.js';

const TX = '12345678-1234-4234-8234-123456789012';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-backup-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('backs up and restores exact phpMyAdmin FPM and Nginx state including previous absence', async () => {
  await withTempDirectory(async (root) => {
    const fpmPoolPath = path.join(root, 'pool.conf');
    const nginxConfigPath = path.join(root, 'nginx.conf');
    const backupRoot = path.join(root, 'backups');
    await writeFile(fpmPoolPath, 'old-fpm\n', { mode: 0o640 });
    await chmod(fpmPoolPath, 0o640);
    const manager = createPhpMyAdminConfigBackupManager({
      backupRoot,
      fpmPoolPath,
      nginxConfigPath,
      chownFn: async () => {},
    });

    const backup = await manager.backupConfiguration(TX);
    assert.equal(backup.version, 1);
    assert.equal(backup.files[0].exists, true);
    assert.equal(backup.files[1].exists, false);
    assert.equal((await stat(backupRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(manager.transactionDirectory(TX), 'manifest.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(manager.transactionDirectory(TX), 'yunpanel-phpmyadmin-fpm.conf'))).mode & 0o777, 0o600);

    await writeFile(fpmPoolPath, 'new-fpm\n');
    await writeFile(nginxConfigPath, 'new-nginx\n');
    const restored = await manager.restoreConfiguration(TX);
    assert.equal(restored.restored, true);
    assert.equal(await readFile(fpmPoolPath, 'utf8'), 'old-fpm\n');
    assert.equal((await stat(fpmPoolPath)).mode & 0o777, 0o640);
    await assert.rejects(stat(nginxConfigPath), { code: 'ENOENT' });
  });
});

test('backup rejects symlink live targets and duplicate transactions', async () => {
  await withTempDirectory(async (root) => {
    const fpmPoolPath = path.join(root, 'pool.conf');
    const target = path.join(root, 'real-pool.conf');
    const nginxConfigPath = path.join(root, 'nginx.conf');
    await writeFile(target, 'fpm');
    await symlink(target, fpmPoolPath);
    await writeFile(nginxConfigPath, 'nginx');
    const manager = createPhpMyAdminConfigBackupManager({
      backupRoot: path.join(root, 'backups'),
      fpmPoolPath,
      nginxConfigPath,
    });
    await assert.rejects(
      manager.backupConfiguration(TX),
      (error) => error instanceof PhpMyAdminConfigBackupError
        && error.code === 'phpmyadmin_backup_target_unsafe',
    );

    await rm(fpmPoolPath);
    await writeFile(fpmPoolPath, 'safe');
    await manager.backupConfiguration(TX);
    await assert.rejects(
      manager.backupConfiguration(TX),
      (error) => error instanceof PhpMyAdminConfigBackupError
        && error.code === 'phpmyadmin_backup_exists',
    );
  });
});

test('restore rejects changed backup bytes and expanded manifest state', async () => {
  await withTempDirectory(async (root) => {
    const fpmPoolPath = path.join(root, 'pool.conf');
    const nginxConfigPath = path.join(root, 'nginx.conf');
    await writeFile(fpmPoolPath, 'fpm');
    await writeFile(nginxConfigPath, 'nginx');
    const manager = createPhpMyAdminConfigBackupManager({
      backupRoot: path.join(root, 'backups'),
      fpmPoolPath,
      nginxConfigPath,
      chownFn: async () => {},
    });
    await manager.backupConfiguration(TX);
    const directory = manager.transactionDirectory(TX);
    const fpmBackup = path.join(directory, 'yunpanel-phpmyadmin-fpm.conf');
    await writeFile(fpmBackup, 'tampered', { mode: 0o600 });
    await assert.rejects(
      manager.restoreConfiguration(TX),
      (error) => error instanceof PhpMyAdminConfigBackupError
        && error.code === 'phpmyadmin_backup_file_invalid',
    );

    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.privatePath = '/etc/shadow';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await assert.rejects(
      manager.loadManifest(TX),
      (error) => error instanceof PhpMyAdminConfigBackupError
        && error.code === 'phpmyadmin_backup_manifest_invalid',
    );
  });
});
