import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDurableJobRegistry } from '../src/jobs/durable-job-registry.js';
import { resolveJobRecoveryPaths } from '../src/jobs/job-recovery-runtime.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { createLocalJobExecutor } from '../src/runtime/local-job-executor.js';
import { runRunningPhpToolRecoveryFromStores } from '../src/jobs/job-running-php-tool-recovery-runtime.js';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createWebsitePhpToolOperationReceiptStore } from '../src/php/website-php-tool-operation-receipt.js';
import { createWordPressSelectiveTransferJournal } from '../src/wordpress/wordpress-selective-transfer-journal.js';

const linux = { skip: process.platform !== 'linux' && 'Requires native Linux file recovery' };
const hostname = 'selective-recovery-host';
const sourceWebsite = '11111111-1111-4111-8111-111111111111';
const sourceApp = '22222222-2222-4222-8222-222222222222';
const targetWebsite = '33333333-3333-4333-8333-333333333333';
const targetApp = '44444444-4444-4444-8444-444444444444';
const actorSessionId = '55555555-5555-4555-8555-555555555555';
const actorUserId = '66666666-6666-4666-8666-666666666666';
const previewDigest = 'a'.repeat(64);
const original = '<?php /* original */';
const replacement = '<?php /* selective transfer */';
const concurrent = '<?php /* independent production write */';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const names = ['wp-content/plugins/add.php', 'wp-content/plugins/main.php', 'wp-content/plugins/untouched.php'];

async function fixture(t) {
  const cwd = await mkdtemp(path.join(await realpath(os.tmpdir()), 'yunpanel-selective-journal-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const sites = path.join(cwd, 'sites');
  const release = path.join(sites, 'release-1');
  const releaseRoot = path.join(release, 'wordpress');
  const documentRoot = path.join(sites, 'current');
  const root = path.join(cwd, 'private', 'wordpress-selective');
  const files = names.map((name) => path.join(releaseRoot, name));
  await mkdir(path.dirname(files[0]), { recursive: true });
  await symlink(release, documentRoot, 'dir');
  await writeFile(files[1], original);
  await writeFile(files[2], concurrent);
  const rootInfo = await lstat(releaseRoot, { bigint: true });

  const env = {};
  const paths = resolveJobRecoveryPaths({ env, cwd });
  const servers = createServerRegistry({ filePath: paths.serverStore });
  await servers.init();
  const server = await servers.createLocalServer({ hostname });
  const payload = { websiteId: sourceWebsite, applicationId: sourceApp, unixUser: 'yunapp-aaaaaaaaaaaa',
    expectedWebsiteRevision: 1, targetApplicationId: targetApp, targetWebsiteRevision: 5,
    actorSessionId, actorUserId, actorRole: 'owner', actionId: 'wp.toolkit', previewDigest,
    confirmation: `php-tool:${sourceWebsite}:wp.toolkit:${previewDigest}`,
    options: { action: 'selective_transfer', targetWebsiteId: targetWebsite, fileScopes: ['plugins'] }, secretRef: null };
  const target = { releaseRoot, expectedRoot: { device: String(rootInfo.dev), inode: String(rootInfo.ino) } };
  const readTarget = async (pin) => pin.releaseRoot === target.releaseRoot && pin.expectedRoot.device === target.expectedRoot.device
    && pin.expectedRoot.inode === target.expectedRoot.inode;
  return { cwd, root, releaseRoot, documentRoot, files, env, paths, payload, target, readTarget, serverId: server.id,
    journal: createWordPressSelectiveTransferJournal({ root }) };
}

function apply(batch, index, expected) {
  return batch.apply({ relativePath: names[index], expectedTargetSha256: expected, content: Buffer.from(replacement) });
}

test('durable batch restores touched files while retaining untouched production state', linux, async (t) => {
  const fx = await fixture(t);
  const context = { serverId: fx.serverId, jobId: 'selective-batch-01', payload: fx.payload };
  const batch = await fx.journal.prepare({ ...context, target: fx.target, relativePaths: [...names].reverse() });
  assert.equal((await apply(batch, 0, null)).status, 'applied');
  assert.equal((await apply(batch, 1, sha256(original))).status, 'applied');
  await assert.rejects(batch.apply({ relativePath: 'wp-content/plugins/outside.php' }), { code: 'wordpress_selective_journal_path_unapproved' });

  const restarted = createWordPressSelectiveTransferJournal({ root: fx.root });
  await assert.rejects(restarted.rollbackInterrupted({ ...context, payload: { ...fx.payload, targetWebsiteRevision: 6 }, verifyTarget: fx.readTarget }), {
    code: 'wordpress_selective_journal_identity_mismatch',
  });
  assert.equal(await readFile(fx.files[1], 'utf8'), replacement);
  const recovered = await restarted.rollbackInterrupted({ ...context, verifyTarget: fx.readTarget });
  assert.deepEqual(recovered, { status: 'rolled_back', filesRolledBack: 2, unchangedFiles: 1, conflicts: [] });
  await assert.rejects(lstat(fx.files[0]), { code: 'ENOENT' });
  assert.equal(await readFile(fx.files[1], 'utf8'), original);
  assert.equal(await readFile(fx.files[2], 'utf8'), concurrent);
  assert.deepEqual(await restarted.rollbackInterrupted({ ...context, verifyTarget: fx.readTarget }), recovered);
  await assert.rejects(apply(batch, 2, sha256(concurrent)), { code: 'wordpress_selective_journal_compensating' });
});

test('recovery compensates every safe path when another path conflicts', linux, async (t) => {
  const fx = await fixture(t);
  const context = { serverId: fx.serverId, jobId: 'selective-batch-02', payload: fx.payload };
  const batch = await fx.journal.prepare({ ...context, target: fx.target, relativePaths: [names[0], names[1]] });
  await apply(batch, 0, null);
  await apply(batch, 1, sha256(original));
  await writeFile(fx.files[1], concurrent);
  const recovered = await fx.journal.rollbackInterrupted({ ...context, verifyTarget: fx.readTarget });
  assert.equal(recovered.status, 'conflict');
  assert.equal(recovered.filesRolledBack, 1);
  assert.deepEqual(recovered.conflicts.map(({ relativePath, reason }) => ({ relativePath, reason })), [{ relativePath: names[1], reason: 'target_changed' }]);
  assert.equal(await readFile(fx.files[1], 'utf8'), concurrent);
  await assert.rejects(lstat(fx.files[0]), { code: 'ENOENT' });
});

test('an unbound job, protected path and replaced target remain unavailable for recovery', linux, async (t) => {
  const fx = await fixture(t);
  const context = { serverId: fx.serverId, jobId: 'selective-batch-03', payload: fx.payload };
  await assert.rejects(fx.journal.rollbackInterrupted(context), { code: 'wordpress_selective_journal_target_changed' });
  await assert.rejects(fx.journal.prepare({ ...context, target: fx.target, relativePaths: ['wp-content/uploads/order.png'] }), {
    code: 'wordpress_selective_journal_files_protected',
  });
  const batch = await fx.journal.prepare({ ...context, target: fx.target, relativePaths: [names[1]] });
  await apply(batch, 1, sha256(original));
  await assert.rejects(fx.journal.rollbackInterrupted({ ...context, verifyTarget: async (target) => target.expectedRoot.inode === '0' }), {
    code: 'wordpress_selective_journal_target_changed',
  });
  assert.equal(await readFile(fx.files[1], 'utf8'), replacement);
});

async function runningJobFixture(t, { claim = true } = {}) {
  const fx = await fixture(t);
  const jobs = createDurableJobRegistry({ filePath: fx.paths.jobStore, registryFactory: createJobRegistry });
  await jobs.init();
  const queued = await jobs.enqueue({ serverId: fx.serverId, type: 'website.php.action', operation: 'website.php.action',
    payload: fx.payload, resourceType: 'application', resourceId: sourceApp, idempotencyKey: 'selective-recovery-queue' });
  if (claim) assert.equal((await jobs.claimNext(fx.serverId)).job.id, queued.id);

  const websites = { version: 6, websites: [
    { id: sourceWebsite, name: 'source.test', runtimeType: 'php', serverId: fx.serverId, applicationId: sourceApp, revision: 1, unixUser: fx.payload.unixUser },
    { id: targetWebsite, name: 'target.test', runtimeType: 'php', serverId: fx.serverId, applicationId: targetApp, revision: 5,
      unixUser: 'yunapp-bbbbbbbbbbbb', documentRoot: fx.documentRoot },
  ] };
  const domain = { serverId: fx.serverId, websiteId: targetWebsite, primaryDomain: 'target.test', nginxSettings: { documentRoot: 'wordpress' } };
  await writeFile(fx.paths.websiteStore, JSON.stringify(websites));
  await writeFile(fx.paths.domainStore, JSON.stringify({ version: 4, domains: [domain] }));
  const recover = () => runRunningPhpToolRecoveryFromStores({ serverId: fx.serverId, jobId: queued.id, hostname, env: fx.env, cwd: fx.cwd,
    journalFactory: () => createWordPressSelectiveTransferJournal({ root: fx.root }),
    receiptStoreFactory: () => createWebsitePhpToolOperationReceiptStore({ root: path.join(fx.cwd, 'receipts') }),
    serviceStatus: async () => ({ apiActive: false, agentActive: false }) });
  return { ...fx, jobs, jobId: queued.id, payload: queued.payload, domain, recover };
}

test('a WordPress file conflict keeps the real local job in durable recovery', linux, async (t) => {
  const fx = await runningJobFixture(t, { claim: false });
  const executor = createLocalJobExecutor({ serverId: fx.serverId, jobRegistry: fx.jobs,
    executeOperation: async (_operation, payload, { jobId }) => {
      const batch = await fx.journal.prepare({ serverId: fx.serverId, jobId, payload, target: fx.target, relativePaths: [names[1]] });
      assert.equal((await apply(batch, 1, sha256(original))).status, 'applied');
      await writeFile(fx.files[1], concurrent);
      assert.equal((await batch.rollback()).status, 'conflict');
      throw Object.assign(new Error('WordPress file requires inspection'), { code: 'wordpress_selective_transfer_rollback_conflict' });
    },
    reconcileCompletedJob: async () => assert.fail('A partial rollback must not be completed'),
  });
  await assert.rejects(executor.runOnce(), { code: 'local_host_recovery_required', jobId: fx.jobId });
  assert.equal((await fx.jobs.getJob(fx.jobId)).status, 'running');
  await assert.rejects(fx.jobs.claimNext(fx.serverId), { code: 'durable_job_reconciliation_required' });
  await assert.rejects(fx.recover(), { code: 'job_wordpress_selective_rollback_unresolved' });
  assert.equal(await readFile(fx.files[1], 'utf8'), concurrent);
});

test('PHP recovery uses durable queue evidence and the currently bound WordPress document root', linux, async (t) => {
  const fx = await runningJobFixture(t);
  const batch = await fx.journal.prepare({ serverId: fx.serverId, jobId: fx.jobId, payload: fx.payload,
    target: fx.target, relativePaths: names });
  await apply(batch, 1, sha256(original));
  const { domain, recover } = fx;
  await writeFile(fx.paths.domainStore, JSON.stringify({ version: 4, domains: [{ ...domain, nginxSettings: { documentRoot: 'other' } }] }));
  await assert.rejects(recover(), { code: 'wordpress_selective_journal_target_changed' });
  assert.equal(await readFile(fx.files[1], 'utf8'), replacement);
  await writeFile(fx.paths.domainStore, JSON.stringify({ version: 4, domains: [domain] }));
  const restored = await recover();
  assert.equal(restored.status, 'failed');
  assert.equal(restored.filesRolledBack, 1);
  assert.equal(restored.unchangedFiles, 2);
  assert.equal(await readFile(fx.files[1], 'utf8'), original);
  const readback = await fx.jobs.getJob(fx.jobId);
  assert.equal(readback.status, 'failed');
  assert.equal(readback.error.code, 'wordpress_selective_transfer_interrupted');
});

test('PHP recovery closes interrupted jobs before the manifest only with zero-touch evidence', linux, async (t) => {
  for (const initial of ['no journal directory', 'only a staged manifest', 'a file marker and no manifest']) {
    await t.test(initial, async (subtest) => {
      const fx = await runningJobFixture(subtest);
      const directory = path.join(fx.root, sha256(JSON.stringify([fx.serverId, fx.jobId])));
      if (initial !== 'no journal directory') {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, '.11111111-1111-4111-8111-111111111111.tmp'), '{"version":', { mode: 0o600 });
      }
      if (initial === 'a file marker and no manifest') {
        const marker = path.join(directory, `started-${sha256(names[1])}`);
        await writeFile(marker, '', { mode: 0o600 });
        await assert.rejects(fx.recover(), { code: 'wordpress_selective_journal_manifest_absent_with_artifacts' });
        assert.equal((await fx.jobs.getJob(fx.jobId)).status, 'running');
      } else {
        const result = await fx.recover();
        assert.equal(result.status, 'failed');
        assert.equal(result.filesRolledBack, 0);
        assert.equal(result.unchangedFiles, 0);
        assert.equal((await fx.jobs.getJob(fx.jobId)).status, 'failed');
      }
      if (initial === 'no journal directory') await assert.rejects(lstat(directory), { code: 'ENOENT' });
      assert.equal(await readFile(fx.files[1], 'utf8'), original);
      await assert.rejects(lstat(fx.files[0]), { code: 'ENOENT' });
    });
  }
});
