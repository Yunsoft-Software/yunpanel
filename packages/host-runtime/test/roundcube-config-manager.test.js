import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewRoundcubeConfiguration, renderRoundcubeConfig } from '@yunpanel/config-templates';
import {
  createRoundcubeConfigManager,
  RoundcubeConfigManagerError,
} from '../src/roundcube-config-manager.js';

const input = Object.freeze({
  mailHostname: 'mail.example.com',
  desKey: 'ABCDEFGHIJKLMNOPQRSTUVWX',
});

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-roundcube-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('stages secret-bearing Roundcube config in private digest-scoped storage', async () => withTempDirectory(async (root) => {
  const stagingRoot = path.join(root, 'staging');
  const manager = createRoundcubeConfigManager({ stagingRoot });
  const preview = previewRoundcubeConfiguration(input);
  const config = renderRoundcubeConfig(input);
  const result = await manager.stageConfiguration(preview, config);

  assert.equal(result.previewSha256, preview.sha256);
  assert.equal(result.configSha256, preview.artifact.sha256);
  assert.equal(result.staged, true);
  assert.equal((await stat(stagingRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(manager.stageDirectory(preview.sha256))).mode & 0o777, 0o700);
  const stagedPath = manager.stagedConfigPath(preview.sha256);
  assert.equal((await stat(stagedPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(stagedPath, 'utf8'), config);
  assert.deepEqual(await manager.inspectStagedConfiguration(preview), {
    satisfied: true,
    result: {
      version: 1,
      previewSha256: preview.sha256,
      configSha256: preview.artifact.sha256,
      bytes: preview.artifact.bytes,
      staged: true,
    },
  });
}));

test('staging rejects private config that does not match the approved preview', async () => withTempDirectory(async (root) => {
  const manager = createRoundcubeConfigManager({ stagingRoot: path.join(root, 'staging') });
  const preview = previewRoundcubeConfiguration(input);
  await assert.rejects(
    manager.stageConfiguration(preview, `${renderRoundcubeConfig(input)}\n`),
    (error) => error instanceof RoundcubeConfigManagerError
      && error.code === 'roundcube_sensitive_material_mismatch',
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