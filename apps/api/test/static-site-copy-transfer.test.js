import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSiteFileManager } from '../src/site-file-manager.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createStaticSiteCopyTransfer } from '../src/static-site-copy-transfer.js';
import { staticSiteCopyFixture } from './fixtures/static-site-copy.js';

async function copyFixture(t) {
  const fixture = await staticSiteCopyFixture(t);
  const { directory, source, target, server, websiteRegistry, filesystem, planner, request } = fixture;
  const accountsFile = path.join(directory, 'accounts');
  const accounts = [source, target].map(({ site, evidence }) =>
    `${site.unixUser}:x:${evidence.unixUid}:${evidence.unixGid}::${directory}:/usr/sbin/nologin`);
  await fs.writeFile(accountsFile, `${accounts.join('\n')}\n`, { mode: 0o600 });
  // The filesystem worker runs against the real disposable releases without host account installation.
  const files = createSiteFileManager({ websiteRegistry, localServerId: server.id, getuid: () => 0,
    readPasswd: () => fs.readFile(accountsFile, 'utf8'), statFn: filesystem.stat, realpathFn: filesystem.realpath,
    runWorker: ({ request: operation }) => executeSiteFileOperation(operation, filesystem) });
  const siteMutationLock = createSiteMutationLock({ root: path.join(directory, 'mutation-locks') });
  const transfer = createStaticSiteCopyTransfer({ planner, siteFileManager: files, siteMutationLock });
  const plan = await planner.preview(request, { fileManager: files });
  const authorize = (websiteId) => [source.site.id, target.site.id].includes(websiteId);
  return { ...fixture, files, transfer, plan, authorize };
}

test('copies actual nested binary and HTML files and preserves the source', async (t) => {
  const { source, target, transfer, plan, authorize } = await copyFixture(t);
  const original = await fs.readFile(path.join(source.release, 'index.html'));
  await assert.rejects(transfer.copy(plan, { authorize: (websiteId) => websiteId === source.site.id }), { code: 'static_copy_forbidden' });
  assert.deepEqual(await fs.readdir(target.release), []);

  const result = await transfer.copy(plan, { authorize });
  assert.deepEqual(result, { sourceWebsiteId: source.site.id, targetWebsiteId: target.site.id,
    digest: plan.digest, filesCopied: 2, bytesCopied: original.length + 4 });
  assert.deepEqual(await fs.readFile(path.join(target.release, 'index.html')), original);
  assert.deepEqual(await fs.readFile(path.join(target.release, 'images', 'photo.bin')), Buffer.from([0, 1, 254, 255]));
  assert.deepEqual(await fs.readFile(path.join(source.release, 'index.html')), original);
  await assert.rejects(transfer.copy(plan, { authorize }), { code: 'static_copy_target_not_empty' });
});

test('keeps normal file writes queued and releases both sites on failure', async (t) => {
  const { files, source, target, plan } = await copyFixture(t);
  const outsideId = '20be27ad-0fa5-43e1-ad6e-17ee772610ff';
  const inside = Promise.withResolvers();
  const release = Promise.withResolvers();
  const lockRun = files.withPinnedSites([plan.target, plan.source], async (session) => {
    inside.resolve(session);
    await release.promise;
    throw new Error('End the copy with an error');
  });
  const failure = assert.rejects(lockRun, /End the copy with an error/);
  const session = await inside.promise;
  try {
    await assert.rejects(session.execute(outsideId, { operation: 'list', path: '' }), { code: 'site_file_copy_scope_invalid' });
    const pending = files.execute(target.site.id, { operation: 'create_file', path: 'normal.txt' });
    try {
      assert.equal(await Promise.race([pending.then(() => false), delay(30, true)]), true);
      assert.deepEqual(await fs.readdir(target.release), []);
    } finally { release.resolve(); }
    await failure;
    assert.equal((await pending).created, true);
  } finally { release.resolve(); }
  assert.equal((await files.execute(source.site.id, { operation: 'list', path: '' })).entries.length, 2);
  await assert.rejects(session.execute(target.site.id, { operation: 'list', path: '' }), { code: 'site_file_copy_scope_invalid' });
});

test('rejects a changed release root before any copy writes', async (t) => {
  const { source, target, transfer, plan, authorize, toDisk } = await copyFixture(t);
  const link = toDisk(target.site.documentRoot);
  await fs.unlink(link);
  await fs.symlink(source.release, link);
  await assert.rejects(transfer.copy(plan, { authorize }), { code: 'site_file_copy_root_changed' });
  assert.deepEqual(await fs.readdir(target.release), []);
});
