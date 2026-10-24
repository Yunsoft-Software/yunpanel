import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebsiteEnvironmentBackupAdapter } from '../src/website-environment-backup-adapter.js';
import { createWebsiteResourceBackupCodec } from '../src/website-resource-backup-codec.js';
import { createApplicationEnvironmentRegistry } from '../src/application-environment-registry.js';

async function fixture(t, type = 'node', configureRuntime = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-site-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const application = { id: randomUUID(), serverId: randomUUID(), type, currentReleaseId: type === 'node' ? randomUUID() : null };
  const website = { id: randomUUID(), applicationId: application.id, serverId: application.serverId };
  const registry = createApplicationEnvironmentRegistry({ filePath: path.join(root, 'registry.json'), masterKey: Buffer.alloc(32, 17), applicationExists: async id => id === application.id });
  const backupSet = { website, stagedRoot: path.join(root, 'staged'), env: { stagedMetadataPath: path.join(root, 'staged', 'env-metadata.json') } };
  const calls = [];
  const runtimeManager = configureRuntime ? {
    captureEnvironment: async input => { calls.push(['capture', input]); return { state: 'running', fixture: true }; },
    restoreEnvironment: async input => { calls.push(['restore', input]); assert.equal(await input.verifyHealth(), true); return { verified: true, appliedMatchesSaved: true, applicationId: input.application.id, environmentRevision: input.environmentRevision }; },
  } : null;
  const adapter = createWebsiteEnvironmentBackupAdapter({ applicationRegistry: { getApplication: async id => id === application.id ? application : null },
    domainRegistry: { listDomains: async () => [{ websiteId: website.id, serverId: application.serverId, primaryDomain: 'owned.example.test' }] },
    healthInspector: { inspect: async input => { assert.equal(input.primaryDomain, 'owned.example.test'); return { satisfied: true }; } },
    applicationEnvironmentRegistry: registry, codec: createWebsiteResourceBackupCodec({ masterKey: Buffer.alloc(32, 17) }), runtimeManager });
  return { registry, application, website, backupSet, adapter, calls };
}
test('environment backup contains encrypted actual values and requires a verified runtime application before applied metadata', async t => {
  const f = await fixture(t);
  await f.registry.setVariable({ applicationId: f.application.id, key: 'SERVICE_SECRET', value: 'original private service secret', secret: true });
  await f.adapter.capture(f.backupSet);
  assert.doesNotMatch(await readFile(f.backupSet.env.stagedMetadataPath, 'utf8'), /original private service secret|SERVICE_SECRET/);
  await f.registry.setVariable({ applicationId: f.application.id, key: 'SERVICE_SECRET', value: 'changed private service secret', secret: true });
  const result = await f.adapter.restore({ backupSet: f.backupSet, include: [f.backupSet.stagedRoot], operationId: randomUUID() });
  assert.equal(result[0].restored, true);
  const runtime = f.calls.find(call => call[0] === 'restore')[1];
  assert.deepEqual(runtime.values, { SERVICE_SECRET: 'original private service secret' });
  assert.equal(runtime.website.id, f.website.id);
  const status = await f.registry.environmentStatus(f.application.id, { currentReleaseId: f.application.currentReleaseId });
  assert.equal(status.appliedToRunningProcess, true);
});
test('missing Node runtime capture/restore fails before recording a complete backup or mutating the saved environment', async t => {
  const f = await fixture(t, 'node', false);
  await f.registry.setVariable({ applicationId: f.application.id, key: 'VALUE', value: 'keep committed value', secret: false });
  await assert.rejects(f.adapter.capture(f.backupSet), { code: 'website_environment_runtime_backup_unavailable' });
  await assert.rejects(f.adapter.assertSupported(f.backupSet, [f.backupSet.stagedRoot]), { code: 'website_environment_runtime_restore_unavailable' });
  assert.deepEqual(await f.registry.materialize(f.application.id), { VALUE: 'keep committed value' });
});
test('an empty PHP catalog round trips without inventing a process environment or changing a saved revision', async t => {
  const f = await fixture(t, 'php', false);
  await f.adapter.capture(f.backupSet);
  await f.adapter.restore({ backupSet: f.backupSet, include: [f.backupSet.stagedRoot], operationId: randomUUID() });
  assert.equal((await f.registry.environmentStatus(f.application.id)).savedRevision, 0);
  assert.deepEqual(f.calls, []);
});
