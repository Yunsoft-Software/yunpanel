import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  previewPhpMyAdminFpmPool,
  previewPhpMyAdminNginxConfig,
  previewPhpMyAdminSignonBridge,
  previewPhpMyAdminSignonConfig,
  renderPhpMyAdminFpmPool,
  renderPhpMyAdminNginxConfig,
  renderPhpMyAdminSignonBridge,
  renderPhpMyAdminSignonConfig,
} from '@yunpanel/config-templates';
import {
  createPhpMyAdminConfigManager,
  PhpMyAdminConfigManagerError,
} from '../src/phpmyadmin-config-manager.js';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-phpmyadmin-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('stages exact phpMyAdmin FPM and Nginx artifacts in digest-scoped private storage', async () => {
  await withTempDirectory(async (root) => {
    const stagingRoot = path.join(root, 'staging');
    const manager = createPhpMyAdminConfigManager({ stagingRoot });
    const fpmPreview = previewPhpMyAdminFpmPool();
    const nginxPreview = previewPhpMyAdminNginxConfig();
    const signonConfigPreview = previewPhpMyAdminSignonConfig();
    const signonBridgePreview = previewPhpMyAdminSignonBridge();
    const fpmContent = renderPhpMyAdminFpmPool();
    const nginxContent = renderPhpMyAdminNginxConfig();
    const signonConfigContent = renderPhpMyAdminSignonConfig();
    const signonBridgeContent = renderPhpMyAdminSignonBridge();
    const fpmResult = await manager.stageFpmPool(fpmPreview, fpmContent);
    const nginxResult = await manager.stageNginxConfig(nginxPreview, nginxContent);
    const signonConfigResult = await manager.stageSignonConfig(signonConfigPreview, signonConfigContent);
    const signonBridgeResult = await manager.stageSignonBridge(signonBridgePreview, signonBridgeContent);

    assert.equal(fpmResult.previewSha256, fpmPreview.sha256);
    assert.equal(fpmResult.fpmSha256, fpmPreview.artifact.sha256);
    assert.equal(nginxResult.previewSha256, nginxPreview.sha256);
    assert.equal(nginxResult.nginxSha256, nginxPreview.artifact.sha256);
    assert.equal(signonConfigResult.signonConfigSha256, signonConfigPreview.artifact.sha256);
    assert.equal(signonBridgeResult.signonBridgeSha256, signonBridgePreview.artifact.sha256);
    assert.equal((await stat(stagingRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(manager.stageDirectory(fpmPreview.sha256))).mode & 0o777, 0o700);
    assert.equal((await stat(manager.stagedFpmPath(fpmPreview.sha256))).mode & 0o777, 0o640);
    assert.equal((await stat(manager.stagedNginxPath(nginxPreview.sha256))).mode & 0o777, 0o640);
    assert.equal((await stat(manager.stagedSignonConfigPath(signonConfigPreview.sha256))).mode & 0o777, 0o640);
    assert.equal((await stat(manager.stagedSignonBridgePath(signonBridgePreview.sha256))).mode & 0o777, 0o640);
    assert.equal(await readFile(manager.stagedFpmPath(fpmPreview.sha256), 'utf8'), fpmContent);
    assert.equal(await readFile(manager.stagedNginxPath(nginxPreview.sha256), 'utf8'), nginxContent);
    assert.equal(await readFile(manager.stagedSignonConfigPath(signonConfigPreview.sha256), 'utf8'), signonConfigContent);
    assert.equal(await readFile(manager.stagedSignonBridgePath(signonBridgePreview.sha256), 'utf8'), signonBridgeContent);
    assert.equal((await manager.inspectStagedFpmPool(fpmPreview)).satisfied, true);
    assert.equal((await manager.inspectStagedNginxConfig(nginxPreview)).satisfied, true);
    assert.equal((await manager.inspectStagedSignonConfig(signonConfigPreview)).satisfied, true);
    assert.equal((await manager.inspectStagedSignonBridge(signonBridgePreview)).satisfied, true);
  });
});

test('staging rejects content and preview metadata outside the approved template contract', async () => {
  await withTempDirectory(async (root) => {
    const manager = createPhpMyAdminConfigManager({ stagingRoot: path.join(root, 'staging') });
    const fpmPreview = previewPhpMyAdminFpmPool();
    const nginxPreview = previewPhpMyAdminNginxConfig();
    const signonConfigPreview = previewPhpMyAdminSignonConfig();
    const signonBridgePreview = previewPhpMyAdminSignonBridge();
    await assert.rejects(
      manager.stageFpmPool(fpmPreview, `${renderPhpMyAdminFpmPool()}\n`),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_fpm_material_mismatch',
    );
    await assert.rejects(
      manager.stageNginxConfig(nginxPreview, `${renderPhpMyAdminNginxConfig()}\n`),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_nginx_material_mismatch',
    );
    await assert.rejects(
      manager.stageFpmPool({ ...fpmPreview, runtimeUser: 'root' }, renderPhpMyAdminFpmPool()),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_fpm_preview_invalid',
    );
    await assert.rejects(
      manager.stageFpmPool({ ...fpmPreview, documentRoot: '/usr/share/phpmyadmin' }, renderPhpMyAdminFpmPool()),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_fpm_preview_invalid',
    );
    await assert.rejects(
      manager.stageNginxConfig({ ...nginxPreview, gatewaySocketGroup: 'www-data' }, renderPhpMyAdminNginxConfig()),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_nginx_preview_invalid',
    );
    await assert.rejects(
      manager.stageSignonConfig(signonConfigPreview, `${renderPhpMyAdminSignonConfig()}\n`),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_signon_config_material_mismatch',
    );
    await assert.rejects(
      manager.stageSignonBridge(
        { ...signonBridgePreview, handoffSocketPath: '/tmp/handoff.sock' },
        renderPhpMyAdminSignonBridge(),
      ),
      (error) => error instanceof PhpMyAdminConfigManagerError
        && error.code === 'phpmyadmin_signon_bridge_preview_invalid',
    );
  });
});

test('staged inspection fails closed for content, mode and symlink drift', async () => {
  await withTempDirectory(async (root) => {
    const manager = createPhpMyAdminConfigManager({ stagingRoot: path.join(root, 'staging') });
    const fpmPreview = previewPhpMyAdminFpmPool();
    const fpmContent = renderPhpMyAdminFpmPool();
    await manager.stageFpmPool(fpmPreview, fpmContent);
    const stagedPath = manager.stagedFpmPath(fpmPreview.sha256);

    await writeFile(stagedPath, 'changed', { mode: 0o640 });
    assert.equal((await manager.inspectStagedFpmPool(fpmPreview)).satisfied, false);

    await manager.stageFpmPool(fpmPreview, fpmContent);
    await chmod(stagedPath, 0o600);
    assert.equal((await manager.inspectStagedFpmPool(fpmPreview)).satisfied, false);

    await rm(stagedPath, { force: true });
    const target = path.join(root, 'target');
    await writeFile(target, fpmContent, { mode: 0o640 });
    await symlink(target, stagedPath);
    assert.equal((await manager.inspectStagedFpmPool(fpmPreview)).satisfied, false);
  });
});
