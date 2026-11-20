import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { createResticManager } from '../src/restic-manager.js';

const resticPath = process.env.YUNPANEL_RESTIC_NATIVE_BIN;

test('Restic restores file and SQL data after the original source path disappears', {
  skip: resticPath ? false : 'Set YUNPANEL_RESTIC_NATIVE_BIN to an installed Restic executable',
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yunpanel-restic-native-')));
  try {
    const manager = createResticManager({ resticPath });
    const source = path.join(root, 'source');
    const repository = path.join(root, 'repository');
    const targetDirectory = path.join(root, 'restore');
    const password = randomBytes(32).toString('hex');
    const content = '<h1>YunPanel yerel kurtarma</h1>\n';
    await mkdir(source);
    await writeFile(path.join(source, 'index.html'), content);
    const sourceDatabase = new DatabaseSync(path.join(source, 'data.sqlite'));
    try {
      sourceDatabase.exec("CREATE TABLE page (body text); INSERT INTO page VALUES ('geri geldi');");
    } finally {
      sourceDatabase.close();
    }

    await manager.init({ repository, password });
    const { snapshotId } = await manager.createSnapshot({ repository, password, paths: [source] });
    assert.equal((await manager.check({ repository, password, readDataSubset: '100%' })).healthy, true);
    await rename(source, path.join(root, 'source-offline'));
    await assert.rejects(readFile(path.join(source, 'index.html')), { code: 'ENOENT' });

    assert.equal((await manager.restore({ repository, password, snapshotId, targetDirectory })).verified, true);
    const restored = path.join(targetDirectory, source);
    assert.equal(await readFile(path.join(restored, 'index.html'), 'utf8'), content);
    const restoredDatabase = new DatabaseSync(path.join(restored, 'data.sqlite'), { readOnly: true });
    try {
      assert.equal(restoredDatabase.prepare('SELECT body FROM page').get().body, 'geri geldi');
    } finally {
      restoredDatabase.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a local cache permission error preserves the actual Restic result and erases the password', {
  skip: !resticPath || !process.getuid || process.getuid() === 0,
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yunpanel-restic-native-')));
  const repository = path.join(root, 'repository');
  const password = randomBytes(32).toString('hex');
  const blockedDirectories = [];
  const execFileAsync = promisify(execFile);
  const manager = createResticManager({
    resticPath,
    async runCommand(binary, args, { env, timeout }) {
      try {
        return await execFileAsync(binary, args, { env, timeout, encoding: 'utf8' });
      } finally {
        const blocked = path.join(env.RESTIC_CACHE_DIR, 'permission-test');
        await mkdir(blocked, { recursive: true });
        await writeFile(path.join(blocked, 'marker'), 'cache');
        await chmod(blocked, 0o000);
        blockedDirectories.push({ blocked, passwordFile: env.RESTIC_PASSWORD_FILE });
      }
    },
  });
  try {
    assert.equal((await manager.init({ repository, password })).repository, repository);
    await assert.rejects(manager.check({ repository, password: 'incorrect' }), { code: 'restic_password_invalid' });
    assert.equal(blockedDirectories.length, 2);
    for (const { blocked, passwordFile } of blockedDirectories) {
      await assert.rejects(readFile(path.join(blocked, 'marker')), { code: 'EACCES' });
      await assert.rejects(readFile(passwordFile), { code: 'ENOENT' });
    }
  } finally {
    for (const { blocked, passwordFile } of blockedDirectories) {
      await chmod(blocked, 0o700);
      await rm(path.dirname(passwordFile), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('a private administrator rclone configuration enables a named Restic repository', {
  skip: !resticPath || process.env.YUNPANEL_TEST_NATIVE_RCLONE !== '1',
}, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'yunpanel-restic-native-')));
  try {
    const rcloneConfigPath = path.join(root, 'rclone.conf');
    const linkedConfigPath = path.join(root, 'linked.conf');
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'restored');
    const name = `pilot-${randomBytes(8).toString('hex')}`;
    const repository = `rclone:${name}:${path.join(root, 'repository')}`;
    const password = randomBytes(32).toString('hex');
    const content = 'YunPanel isimli depo denemesi\n';
    await writeFile(rcloneConfigPath, `[${name}]\ntype = local\n`, { mode: 0o600 });
    await writeFile(source, content);
    await symlink(rcloneConfigPath, linkedConfigPath);

    const noConfig = createResticManager({ resticPath, rcloneConfigPath: null });
    await assert.rejects(noConfig.init({ repository, password }), { code: 'restic_rclone_config_required' });
    const explicitLocalBackend = `rclone::local:${path.join(root, 'inline-repository')}`;
    assert.equal((await noConfig.init({ repository: explicitLocalBackend, password })).repository, explicitLocalBackend);

    const invalidLink = createResticManager({ resticPath, rcloneConfigPath: linkedConfigPath });
    await assert.rejects(invalidLink.init({ repository, password }), { code: 'restic_rclone_config_invalid' });

    const operationFiles = [];
    const execFileAsync = promisify(execFile);
    const manager = createResticManager({
      resticPath,
      rcloneConfigPath,
      async runCommand(binary, args, { env, timeout }) {
        assert.notEqual(env.RCLONE_CONFIG, rcloneConfigPath);
        assert.equal(await readFile(env.RCLONE_CONFIG, 'utf8'), await readFile(rcloneConfigPath, 'utf8'));
        operationFiles.push(env.RCLONE_CONFIG, env.RESTIC_PASSWORD_FILE);
        return execFileAsync(binary, args, {
          env: { PATH: '/usr/bin:/bin:/usr/local/bin', ...env },
          timeout,
          encoding: 'utf8',
        });
      },
    });
    await chmod(rcloneConfigPath, 0o644);
    await assert.rejects(manager.init({ repository, password }), { code: 'restic_rclone_config_invalid' });
    await chmod(rcloneConfigPath, 0o600);

    await manager.init({ repository, password });
    const { snapshotId } = await manager.createSnapshot({ repository, password, paths: [source] });
    assert.equal((await manager.check({ repository, password, readDataSubset: '100%' })).healthy, true);
    await rename(source, path.join(root, 'offline.txt'));
    await assert.rejects(readFile(source), { code: 'ENOENT' });
    assert.equal((await manager.restore({ repository, password, snapshotId, targetDirectory: destination })).verified, true);
    assert.equal(await readFile(path.join(destination, source), 'utf8'), content);
    assert.equal(operationFiles.length, 8);
    for (const file of operationFiles) await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
