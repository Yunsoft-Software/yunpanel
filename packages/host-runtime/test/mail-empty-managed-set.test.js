import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailEmptyConfiguration,
} from '@yunpanel/config-templates';
import { createMailConfigManager } from '../src/index.js';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-empty-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('stages the empty managed mail set with an empty protected passwd artifact', async () => withTempDirectory(async (root) => {
  const preview = previewManagedMailEmptyConfiguration();
  const manager = createMailConfigManager({ stagingRoot: path.join(root, 'staging') });
  const manifest = await manager.stageConfiguration(preview, {
    sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: '' }],
  });
  const plan = previewManagedMailApplyPlan(preview);

  assert.equal(manifest.planSha256, plan.sha256);
  assert.equal(manifest.previewSha256, preview.sha256);
  assert.equal(manifest.artifacts.length, 7);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.targetPath), [
    mailTemplatePolicy.postfixVirtualDomainMapPath,
    mailTemplatePolicy.postfixVirtualMailboxMapPath,
    mailTemplatePolicy.postfixVirtualAliasMapPath,
    mailTemplatePolicy.dovecotPasswdFilePath,
    mailTemplatePolicy.dovecotAuthConfigPath,
    mailTemplatePolicy.dovecotMailConfigPath,
    mailTemplatePolicy.rspamdProxyConfigPath,
  ]);

  const stageDirectory = manager.stageDirectory(plan.sha256);
  const passwdArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotPasswdFilePath);
  const passwdPath = path.join(stageDirectory, passwdArtifact.stagedName);
  assert.equal(passwdArtifact.bytes, 0);
  assert.equal((await stat(passwdPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(passwdPath, 'utf8'), '');

  const mailArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotMailConfigPath);
  const mailConfig = await readFile(path.join(stageDirectory, mailArtifact.stagedName), 'utf8');
  assert.match(mailConfig, /^protocols = imap$/m);
  assert.doesNotMatch(mailConfig, /lmtp|postmaster_address|dovecot-lmtp/i);

  const inspected = await manager.inspectStagedConfiguration(preview);
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.planSha256, plan.sha256);
}));
