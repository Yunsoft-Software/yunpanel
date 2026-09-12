import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mailForwardingTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailForwardingConfiguration,
  previewManagedMailApplyPlan,
  renderDovecotQuotaPasswdFile,
} from '@yunpanel/config-templates';
import {
  createMailConfigManager,
  MailConfigManagerError,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 7).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')}`;

function fixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [{ source: 'info@example.com', destinations: ['owner@example.com'] }],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  };
  return {
    input,
    preview: previewManagedMailForwardingConfiguration(input),
    passwd: renderDovecotQuotaPasswdFile({ domains: input.domains, accounts: input.accounts }),
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-stage-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('stages the complete mail bundle atomically without returning protected content', async () => withTempDirectory(async (root) => {
  const { preview, passwd } = fixture();
  const stagingRoot = path.join(root, 'staging');
  const manager = createMailConfigManager({ stagingRoot });
  const manifest = await manager.stageConfiguration(preview, {
    sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd }],
  });
  const plan = previewManagedMailApplyPlan(preview);

  assert.equal(manifest.version, 2);
  assert.equal(manifest.planSha256, plan.sha256);
  assert.equal(manifest.previewSha256, preview.sha256);
  assert.equal(JSON.stringify(manifest).includes(ARGON2ID_HASH), false);
  assert.equal(JSON.stringify(manifest).includes(passwd), false);
  assert.equal(manifest.artifacts.length, 8);

  const directory = manager.stageDirectory(plan.sha256);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const passwdArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotPasswdFilePath);
  const passwdPath = path.join(directory, passwdArtifact.stagedName);
  assert.equal((await stat(passwdPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(passwdPath, 'utf8'), passwd);

  const publicArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailTemplatePolicy.dovecotAuthConfigPath);
  assert.equal((await stat(path.join(directory, publicArtifact.stagedName))).mode & 0o777, 0o640);
  const sieveArtifact = manifest.artifacts.find((artifact) => artifact.targetPath === mailForwardingTemplatePolicy.sievePath);
  assert.ok(sieveArtifact);
  assert.equal((await stat(path.join(directory, sieveArtifact.stagedName))).mode & 0o777, 0o640);

  const inspected = await manager.inspectStagedConfiguration(preview);
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.planSha256, plan.sha256);
  assert.equal(JSON.stringify(inspected).includes(ARGON2ID_HASH), false);
}));

test('fails closed when protected material is missing, unexpected, reordered or digest-mismatched', async () => withTempDirectory(async (root) => {
  const { preview, passwd } = fixture();
  const manager = createMailConfigManager({ stagingRoot: path.join(root, 'staging') });

  await assert.rejects(
    manager.stageConfiguration(preview),
    (error) => error instanceof MailConfigManagerError && error.code === 'mail_sensitive_artifact_missing',
  );
  await assert.rejects(
    manager.stageConfiguration(preview, {
      sensitiveArtifacts: [
        { path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd },
        { path: '/tmp/not-allowed', content: 'nope' },
      ],
    }),
    (error) => error instanceof MailConfigManagerError && error.code === 'mail_sensitive_artifact_unexpected',
  );
  const reorderedPreview = {
    ...preview,
    artifacts: [preview.artifacts[1], preview.artifacts[0], ...preview.artifacts.slice(2)],
  };
  await assert.rejects(
    manager.stageConfiguration(reorderedPreview, {
      sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd }],
    }),
    (error) => error instanceof MailConfigManagerError && error.code === 'mail_artifact_order_invalid',
  );
  await assert.rejects(
    manager.stageConfiguration(preview, {
      sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: `${passwd}tampered\n` }],
    }),
    (error) => error instanceof MailConfigManagerError && error.code === 'mail_artifact_digest_mismatch',
  );
}));

test('staged inspection detects artifact tampering without exposing file contents', async () => withTempDirectory(async (root) => {
  const { preview, passwd } = fixture();
  const manager = createMailConfigManager({ stagingRoot: path.join(root, 'staging') });
  const manifest = await manager.stageConfiguration(preview, {
    sensitiveArtifacts: [{ path: mailTemplatePolicy.dovecotPasswdFilePath, content: passwd }],
  });
  const plan = previewManagedMailApplyPlan(preview);
  const artifact = manifest.artifacts.find((entry) => entry.targetPath === mailTemplatePolicy.dovecotPasswdFilePath);
  await writeFile(path.join(manager.stageDirectory(plan.sha256), artifact.stagedName), 'tampered\n', { mode: 0o600 });

  const inspected = await manager.inspectStagedConfiguration(preview);
  assert.deepEqual(inspected, { satisfied: false, result: null });
}));
