import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  previewRoundcubeConfiguration,
  previewRoundcubeFpmPool,
  previewRoundcubeNginxConfig,
  renderRoundcubeConfig,
  renderRoundcubeFpmPool,
  renderRoundcubeNginxConfig,
} from '@yunpanel/config-templates';
import {
  createRoundcubeConfigManager,
  RoundcubeConfigManagerError,
} from '../src/roundcube-config-manager.js';

const input = Object.freeze({
  mailHostname: 'mail.example.com',
  desKey: 'ABCDEFGHIJKLMNOPQRSTUVWX',
});
const nginxInput = Object.freeze({
  webHostname: 'mail.example.com',
  fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
  privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-roundcube-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('stages secret config, FPM pool and Nginx config in digest-scoped storage with exact modes', async () => withTempDirectory(async (root) => {
  const stagingRoot = path.join(root, 'staging');
  const manager = createRoundcubeConfigManager({ stagingRoot });
  const preview = previewRoundcubeConfiguration(input);
  const fpmPreview = previewRoundcubeFpmPool({ temporaryDirectory: preview.temporaryDirectory });
  const nginxPreview = previewRoundcubeNginxConfig(nginxInput);
  const config = renderRoundcubeConfig(input);
  const fpm = renderRoundcubeFpmPool({ temporaryDirectory: preview.temporaryDirectory });
  const nginx = renderRoundcubeNginxConfig(nginxInput);
  const configResult = await manager.stageConfiguration(preview, config);
  const fpmResult = await manager.stageFpmPool(fpmPreview, fpm);
  const nginxResult = await manager.stageNginxConfig(nginxPreview, nginx);

  assert.equal(configResult.previewSha256, preview.sha256);
  assert.equal(configResult.configSha256, preview.artifact.sha256);
  assert.equal(fpmResult.previewSha256, fpmPreview.sha256);
  assert.equal(fpmResult.fpmSha256, fpmPreview.artifact.sha256);
  assert.equal(nginxResult.previewSha256, nginxPreview.sha256);
  assert.equal(nginxResult.nginxSha256, nginxPreview.artifact.sha256);
  assert.equal((await stat(stagingRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(manager.stageDirectory(preview.sha256))).mode & 0o777, 0o700);
  const stagedPath = manager.stagedConfigPath(preview.sha256);
  const stagedFpm = manager.stagedFpmPath(fpmPreview.sha256);
  const stagedNginx = manager.stagedNginxPath(nginxPreview.sha256);
  assert.equal((await stat(stagedPath)).mode & 0o777, 0o600);
  assert.equal((await stat(stagedFpm)).mode & 0o777, 0o640);
  assert.equal((await stat(stagedNginx)).mode & 0o777, 0o640);
  assert.equal(await readFile(stagedPath, 'utf8'), config);
  assert.equal(await readFile(stagedFpm, 'utf8'), fpm);
  assert.equal(await readFile(stagedNginx, 'utf8'), nginx);
  assert.equal((await manager.inspectStagedConfiguration(preview)).satisfied, true);
  assert.equal((await manager.inspectStagedFpmPool(fpmPreview)).satisfied, true);
  assert.equal((await manager.inspectStagedNginxConfig(nginxPreview)).satisfied, true);
}));

test('staging rejects config, FPM or Nginx material that does not match the approved preview', async () => withTempDirectory(async (root) => {
  const manager = createRoundcubeConfigManager({ stagingRoot: path.join(root, 'staging') });
  const preview = previewRoundcubeConfiguration(input);
  const fpmPreview = previewRoundcubeFpmPool({ temporaryDirectory: preview.temporaryDirectory });
  const nginxPreview = previewRoundcubeNginxConfig(nginxInput);
  await assert.rejects(
    manager.stageConfiguration(preview, `${renderRoundcubeConfig(input)}\n`),
    (error) => error instanceof RoundcubeConfigManagerError
      && error.code === 'roundcube_sensitive_material_mismatch',
  );
  await assert.rejects(
    manager.stageFpmPool(fpmPreview, `${renderRoundcubeFpmPool()}\n`),
    (error) => error instanceof RoundcubeConfigManagerError
      && error.code === 'roundcube_fpm_material_mismatch',
  );
  await assert.rejects(
    manager.stageNginxConfig(nginxPreview, `${renderRoundcubeNginxConfig(nginxInput)}\n`),
    (error) => error instanceof RoundcubeConfigManagerError
      && error.code === 'roundcube_nginx_material_mismatch',
  );
}));

test('staged inspection fails closed for mode drift, content drift and symlink replacement', async () => withTempDirectory(async (root) => {
  const manager = createRoundcubeConfigManager({ stagingRoot: path.join(root, 'staging') });
  const preview = previewRoundcubeConfiguration(input);
  const config = renderRoundcubeConfig(input);
  await manager.stageConfiguration(preview, config);
  const stagedPath = manager.stagedConfigPath(preview.sha256);

  await writeFile(stagedPath, 'changed', { mode: 0o600 });
  assert.equal((await manager.inspectStagedConfiguration(preview)).satisfied, false);

  await manager.stageConfiguration(preview, config);
  const { chmod } = await import('node:fs/promises');
  await chmod(stagedPath, 0o644);
  assert.equal((await manager.inspectStagedConfiguration(preview)).satisfied, false);

  await rm(stagedPath, { force: true });
  const target = path.join(root, 'target');
  await writeFile(target, config, { mode: 0o600 });
  await symlink(target, stagedPath);
  assert.equal((await manager.inspectStagedConfiguration(preview)).satisfied, false);
}));