import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { removalFixture, removalPreview, removalStart, removalContinue } from '../test-support/website-removal-fixture.js';

const code = (expected) => (error) => error.code === expected;
const readyAdapters = () => ({
  websiteCronRegistry: { listTasks: async () => [], getTask: async () => null },
  jobRegistry: {
    enqueue: async () => { throw new Error('unexpected cron enqueue'); },
    findIdempotentJob: async () => { throw new Error('unexpected cron lookup'); },
  },
  websiteSftpKeyRegistry: { listKeys: async () => [], revokeKey: async () => {} },
  databaseBindingRegistry: { listBindings: async () => [], unbindDatabase: async () => {} },
  databaseCredentialRegistry: { getForBinding: async () => null, deleteCredential: async () => {} },
  runtimeBindingRegistry: { getBinding: async () => null, removeOwnedPassenger: async () => {}, removeOwnedStatic: async () => {} },
});
for (const [dependency, bucket, blocker] of [
  ['fileCleanupHandler', null, 'file_cleanup_unavailable'],
  ['websiteRegistry', null, 'metadata_cleanup_unavailable'],
  ['unixIdentityCleanupHandler', null, 'unix_cleanup_unavailable'],
  ['websiteCronRegistry', 'crons', 'cron_cleanup_unavailable'],
  ['jobRegistry', 'crons', 'cron_cleanup_unavailable'],
  ['websiteSftpKeyRegistry', 'sftpKeys', 'sftp_cleanup_unavailable'],
  ['databaseBindingRegistry', 'databases', 'database_cleanup_unavailable'],
  ['databaseCredentialRegistry', 'databases', 'database_cleanup_unavailable'],
  ['runtimeBindingRegistry', 'runtimeBindings', 'runtime_cleanup_unavailable'],
]) {
  test(`missing ${dependency} withholds confirmation before any destructive step`, async () => {
    const preview = removalPreview('site-a', bucket ? { [bucket]: [{ id: 'resource-a' }] } : {}, { systemUser: 'yunapp-test' });
    const f = await removalFixture({ ...readyAdapters(), [dependency]: null }, preview);
    const unavailable = await f.runtime.preview({ websiteId: 'site-a' });
    assert.equal(unavailable.readyToStart, false); assert.equal(unavailable.confirmation, null);
    assert.ok(unavailable.hardBlockers.includes(blocker));
    await assert.rejects(f.runtime.start(removalStart(preview)), code('website_removal_preview_stale'));
    assert.equal((await f.registry.list()).length, 0); assert.equal(f.calls.length, 0);
  });
}
for (const receipt of [undefined, null, true, {}, { filesCleaned: 'true' }, { filesCleaned: false },
  { filesCleaned: true, websiteId: 'other', applicationId: 'app-a', retainedBackups: [] },
  { filesCleaned: true, websiteId: 'site-a', applicationId: 'other', retainedBackups: [] },
  { filesCleaned: true, websiteId: 'site-a', applicationId: 'app-a' }]) {
  test(`file cleanup requires explicit matching evidence: ${JSON.stringify(receipt)}`, async () => {
    const f = await removalFixture({ fileCleanupHandler: async () => receipt });
    const op = await f.runtime.start(removalStart(f.preview));
    assert.equal(op.status, 'blocked'); assert.equal(op.steps[0].status, 'blocked');
    assert.equal(op.steps[0].error.code, 'website_removal_cleanup_unverified');
    assert.equal(op.steps.at(-1).status, 'pending');
  });
}
test('cleanup result whitelists safe fields; arbitrary adapter secrets are not published', async () => {
  const f = await removalFixture({ fileCleanupHandler: async (input) => ({ ...input, filesCleaned: true, cleanedFilesCount: 3, secret: 'do-not-publish' }) });
  const op = await f.runtime.start(removalStart(f.preview));
  assert.deepEqual(op.steps[0].result, { filesCleaned: true, retainedBackups: [], cleanedFilesCount: 3 });
  assert.doesNotMatch(JSON.stringify(op), /do-not-publish/);
});
test('retained backups cannot be changed through either input mutation or a false receipt', async () => {
  const preview = removalPreview('site-a', { backups: [{ id: 'backup-a' }] });
  const f = await removalFixture({ fileCleanupHandler: async (input) => {
    input.retainedBackups.length = 0; return { ...input, filesCleaned: true };
  } }, preview);
  const op = await f.runtime.start(removalStart(preview));
  assert.equal(op.status, 'blocked');
  assert.deepEqual(op.plan.additional.backups.ids, ['backup-a']);
});
for (const changes of [{ unixIdentityCleaned: false }, { websiteId: 'other' }, { systemUser: 'other' }, { unixIdentityCleaned: undefined }]) {
  test(`Unix cleanup cannot complete with wrong evidence: ${JSON.stringify(changes)}`, async () => {
    const preview = removalPreview('site-a', {}, { systemUser: 'yunapp-test' });
    const f = await removalFixture({ unixIdentityCleanupHandler: async (input) => ({ ...input, unixIdentityCleaned: true, ...changes }) }, preview);
    let op = await f.runtime.start(removalStart(preview));
    op = await f.runtime.continueStep(removalContinue(op));
    assert.equal(op.status, 'blocked'); assert.equal(op.steps.at(-1).status, 'pending');
  });
}
for (const current of [undefined, { id: 'other', serverId: 'server-a', applicationId: 'app-a' },
  { id: 'site-a', serverId: 'other', applicationId: 'app-a' }, { id: 'site-a', serverId: 'server-a', applicationId: 'other' }]) {
  test(`metadata cannot delete an unverified identity: ${JSON.stringify(current)}`, async () => {
    let deletes = 0;
    const f = await removalFixture({ websiteRegistry: { getWebsite: async () => current, deleteMigrationWebsite: async () => { deletes++; } } });
    let op = await f.runtime.start(removalStart(f.preview)); op = await f.runtime.continueStep(removalContinue(op));
    assert.equal(op.status, 'blocked'); assert.equal(deletes, 0);
  });
}
test('metadata delete that does nothing cannot mark the operation removed', async () => {
  const f = await removalFixture({ websiteRegistry: {
    getWebsite: async () => ({ id: 'site-a', serverId: 'server-a', applicationId: 'app-a' }),
    deleteMigrationWebsite: async () => ({ deleted: true }),
  } });
  let op = await f.runtime.start(removalStart(f.preview)); op = await f.runtime.continueStep(removalContinue(op));
  assert.equal(op.status, 'blocked'); assert.equal(op.steps.at(-1).result, null);
});
test('delete errors are retained as failure, never swallowed as already absent', async () => {
  const f = await removalFixture({ websiteRegistry: {
    getWebsite: async () => ({ id: 'site-a', serverId: 'server-a', applicationId: 'app-a' }),
    deleteMigrationWebsite: async () => { throw new Error('private filesystem detail'); },
  } });
  let op = await f.runtime.start(removalStart(f.preview)); op = await f.runtime.continueStep(removalContinue(op));
  assert.equal(op.status, 'failed'); assert.equal(op.error.code, 'website_removal_step_failed');
  assert.doesNotMatch(JSON.stringify(op), /private filesystem detail/);
});
test('only an independent null read after deletion completes metadata', async () => {
  let current = { id: 'site-a', serverId: 'server-a', applicationId: 'app-a' }, deletes = 0;
  const f = await removalFixture({ websiteRegistry: { getWebsite: async () => current,
    deleteMigrationWebsite: async (input) => { assert.deepEqual(input, { websiteId: 'site-a', serverId: 'server-a', applicationId: 'app-a' }); deletes++; current = null; },
  } });
  let op = await f.runtime.start(removalStart(f.preview)); op = await f.runtime.continueStep(removalContinue(op));
  assert.equal(op.status, 'removed'); assert.equal(deletes, 1);
});
for (const stage of ['read-before', 'read-after']) {
  test(`metadata ${stage} failure is not evidence of absence`, async () => {
    let reads = 0;
    const f = await removalFixture({ websiteRegistry: { getWebsite: async () => {
      reads++; if (reads === (stage === 'read-before' ? 1 : 2)) throw new Error('unavailable');
      return { id: 'site-a', serverId: 'server-a', applicationId: 'app-a' };
    }, deleteMigrationWebsite: async () => {} } });
    let op = await f.runtime.start(removalStart(f.preview)); op = await f.runtime.continueStep(removalContinue(op));
    assert.equal(op.status, 'failed');
  });
}
test('old persisted operations also stop at an unavailable cleanup adapter', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-removal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createWebsiteRemovalOperationRegistry({ filePath }); await registry.init();
  const original = await registry.create(removalPreview());
  const reopened = createWebsiteRemovalOperationRegistry({ filePath }); await reopened.init();
  const f = await removalFixture({ registry: reopened, fileCleanupHandler: null });
  const current = await f.runtime.get(original.id);
  const blocked = await f.runtime.continueStep(removalContinue(current));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.steps.at(-1).status, 'pending');
  const after = createWebsiteRemovalOperationRegistry({ filePath }); await after.init();
  assert.equal((await after.get(original.id)).status, 'blocked');
});
test('SFTP exceptions are never retried with a string or fabricated revision', async () => {
  let calls = 0;
  const f = await removalFixture({ ...readyAdapters(), websiteSftpKeyRegistry: {
    listKeys: async () => [{ id: 'key-a', revision: 7 }],
    revokeKey: async (input) => { calls++; assert.deepEqual(input, { websiteId: 'site-a', keyId: 'key-a', expectedRevision: 7 }); throw new Error('host error'); },
  } }, removalPreview('site-a', { sftpKeys: [{ id: 'key-a' }] }));
  const op = await f.runtime.start(removalStart(f.preview));
  assert.equal(op.status, 'failed'); assert.equal(calls, 1);
});
for (const inventory of [undefined, null, {}, [{ id: 'x' }, { id: 'x' }], [null]]) {
  test(`invalid cleanup inventory is not an empty successful cleanup: ${JSON.stringify(inventory)}`, async () => {
    let removals = 0;
    const f = await removalFixture({ ...readyAdapters(), websiteCronRegistry: {
      listTasks: async () => inventory,
      getTask: async () => null,
    } },
      removalPreview('site-a', { crons: [{ id: 'cron-a' }] }));
    const op = await f.runtime.start(removalStart(f.preview));
    assert.equal(op.status, 'blocked'); assert.equal(removals, 0);
  });
}
test('corrected adapter can explicitly continue a blocked step without a second removal operation', async () => {
  let ready = false, attempts = 0;
  const f = await removalFixture({ fileCleanupHandler: async (input) => { attempts++; return { ...input, filesCleaned: ready }; } });
  let op = await f.runtime.start(removalStart(f.preview)); assert.equal(op.status, 'blocked');
  ready = true; op = await f.runtime.continueStep(removalContinue(op));
  assert.equal(op.steps[0].status, 'succeeded'); assert.equal(attempts, 2);
  assert.equal((await f.registry.list()).length, 1);
});
test('failed cleanup cannot be replaced by a second removal operation', async () => {
  let attempts = 0;
  const f = await removalFixture({ fileCleanupHandler: async () => { attempts++; throw new Error('fixture failure'); } });
  const op = await f.runtime.start(removalStart(f.preview)); assert.equal(op.status, 'failed');
  await assert.rejects(f.runtime.start(removalStart(f.preview)), code('website_removal_operation_in_progress'));
  assert.equal((await f.registry.list()).length, 1); assert.equal(attempts, 1);
});
test('bounded adapter error code remains useful without publishing its private message', async () => {
  const f = await removalFixture({ fileCleanupHandler: async () => {
    throw Object.assign(new Error('private path and credential details'), { code: 'website_cleanup_busy' });
  } });
  const op = await f.runtime.start(removalStart(f.preview));
  assert.equal(op.error.code, 'website_cleanup_busy'); assert.doesNotMatch(JSON.stringify(op), /credential details/);
});


test('Website removal takes the process-shared site lock before every destructive journal step', async () => {
  const locks = [];
  const f = await removalFixture({
    siteMutationLock: {
      withSiteLock: async (identity, action) => {
        locks.push(identity);
        return action();
      },
    },
  });
  let op = await f.runtime.start(removalStart(f.preview));
  while (op.status === 'running') {
    op = await f.runtime.continueStep(removalContinue(op));
  }
  assert.equal(op.status, 'removed');
  assert.ok(locks.length >= 1);
  assert.deepEqual(locks[0], {
    websiteId: f.preview.website.id,
    applicationId: f.preview.website.applicationId,
  });
  assert.equal(locks.every((entry) => entry.websiteId === f.preview.website.id
    && entry.applicationId === f.preview.website.applicationId), true);
});
