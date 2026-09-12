import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  enableManagedMailSubmission,
  mailForwardingTemplatePolicy,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailEmptyConfiguration,
  secureManagedMailPreview,
} from '@yunpanel/config-templates';
import { createMailConfigManager } from '../src/index.js';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-empty-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function emptyPreview() {
  return enableManagedMailSubmission(
    secureManagedMailPreview(previewManagedMailEmptyConfiguration()),
    [],
  );
}

test('stages the empty managed mail set with protected passwd, sender-login and no-op forwarding artifacts', async () => withTempDirectory(async (root) => {
  const preview = emptyPreview();
  const manager = createMailConfigManager({ stagingRoot: path.join(root, 'staging') });
  const manifest = await manager.stageConfiguration(preview, {
    sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: '' }],
  });
  const plan = previewManagedMailApplyPlan(preview);

  assert.equal(manifest.planSha256, plan.sha256);
  assert.equal(manifest.previewSha256, preview.sha256);
  assert.equal(manifest.artifacts.length, 9);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.targetPath), [
    mailTemplatePolicy.postfixVirtualDomainMapPath,
    mailTemplatePolicy.postfixVirtualMailboxMapPath,
    mailTemplatePolicy.postfixVirtualAliasMapPath,
    mailSubmissionTemplatePolicy.senderLoginPath,
    mailTemplatePolicy.dovecotPasswdFilePath,
    mailTemplatePolicy.dovecotAuthConfigPath,
    mailTemplatePolicy.dovecotMailConfigPath,
    mailForwardingTemplatePolicy.sievePath,
    mailTemplatePolicy.rspamdProxyConfigPath,
  ]);
  assert.deepEqual(plan.postfixMasterServices, [mailSubmissionTemplatePolicy.service]);

  const stageDirectory = manager.stageDirectory(plan.sha256);
  const senderArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailSubmissionTemplatePolicy.senderLoginPath);
  assert.equal(senderArtifact.bytes, 0);
  assert.equal(await readFile(path.join(stageDirectory, senderArtifact.stagedName), 'utf8'), '');

  const passwdArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotPasswdFilePath);
  const passwdPath = path.join(stageDirectory, passwdArtifact.stagedName);
  assert.equal(passwdArtifact.bytes, 0);
  assert.equal((await stat(passwdPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(passwdPath, 'utf8'), '');

  const authArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotAuthConfigPath);
  const authConfig = await readFile(path.join(stageDirectory, authArtifact.stagedName), 'utf8');
  assert.equal((authConfig.match(/^auth_mechanisms\s*=\s*plain login$/gm) ?? []).length, 1);
  assert.match(authConfig, /unix_listener \/var\/spool\/postfix\/private\/auth/);

  const sieveArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailForwardingTemplatePolicy.sievePath);
  const sievePath = path.join(stageDirectory, sieveArtifact.stagedName);
  assert.equal((await stat(sievePath)).mode & 0o777, 0o640);
  assert.equal(await readFile(sievePath, 'utf8'), 'require ["envelope", "copy"];\n\n\n');

  const mailArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotMailConfigPath);
  const mailConfig = await readFile(path.join(stageDirectory, mailArtifact.stagedName), 'utf8');
  assert.match(mailConfig, /^protocols = imap$/m);
  assert.match(mailConfig, /^ssl = required$/m);
  assert.doesNotMatch(mailConfig, /lmtp|postmaster_address|dovecot-lmtp/i);

  const inspected = await manager.inspectStagedConfiguration(preview);
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.planSha256, plan.sha256);
}));
