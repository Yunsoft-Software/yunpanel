import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createUploadedStaticBootstrapManager, phpSiteBootstrapManagerInternals } from '@yunpanel/host-runtime/php-site-bootstrap-manager';
import { staticSiteCopyFixture } from './fixtures/static-site-copy.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');

test('plans actual HTML and binary files into an empty separate release and revalidates the same digest', async (t) => {
  const { planner, request, source, target } = await staticSiteCopyFixture(t);
  const plan = await planner.preview(request);
  assert.equal(plan.source.releaseId, source.releaseId);
  assert.equal(plan.target.releaseId, target.releaseId);
  assert.notEqual(plan.source.rootInode, plan.target.rootInode);
  assert.notEqual(plan.source.unixUser, plan.target.unixUser);
  assert.equal(plan.targetBootstrap, null);
  assert.equal(plan.files.length, 3);
  assert.deepEqual(plan.files.find((file) => file.path === 'images/photo.bin'),
    { path: 'images/photo.bin', type: 'file', bytes: 4, sha256: sha(Buffer.from([0, 1, 254, 255])) });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.files) && Object.isFrozen(plan.files[0]));
  assert.deepEqual(await planner.revalidate(JSON.parse(JSON.stringify(plan))), plan);
  assert.deepEqual(await fs.readdir(target.release), []);
});

test('rejects file drift and a non-empty target without writing to either site', async (t) => {
  const { planner, request, source, target } = await staticSiteCopyFixture(t);
  const plan = await planner.preview(request);
  const sourceFile = path.join(source.release, 'index.html');
  await fs.writeFile(sourceFile, '<h1>Değişti</h1>');
  await assert.rejects(planner.revalidate(plan), { code: 'static_copy_preview_stale' });
  const targetFile = path.join(target.release, 'index.html');
  await fs.writeFile(targetFile, '<h1>Kullanıcının dosyası</h1>');
  await assert.rejects(planner.preview(request), { code: 'static_copy_target_not_empty' });
  assert.equal(await fs.readFile(targetFile, 'utf8'), '<h1>Kullanıcının dosyası</h1>');
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '<h1>Değişti</h1>');
});

test('rejects retargeted current links, including a common or nested physical release', async (t) => {
  const { planner, request, source, target, toDisk } = await staticSiteCopyFixture(t);
  const targetLink = toDisk(target.site.documentRoot);
  for (const differentRoot of [source.release, path.join(source.release, 'images')]) {
    await fs.unlink(targetLink);
    await fs.symlink(differentRoot, targetLink);
    await assert.rejects(planner.preview(request), { code: 'static_copy_release_unverified' });
  }
});

test('rejects same site, other server, wrong runtime, and unready static site', async (t) => {
  const { planner, request, servers, createSite } = await staticSiteCopyFixture(t);
  await assert.rejects(planner.preview({ ...request, targetWebsiteId: request.sourceWebsiteId }), { code: 'static_copy_website_pair_invalid' });
  const otherServer = await servers.createLocalServer({ hostname: 'elsewhere.copy.example.test' });
  const remote = await createSite('remote.copy.example.test', { serverId: otherServer.id, unixUid: 1103 });
  await assert.rejects(planner.preview({ ...request, targetWebsiteId: remote.site.id }), { code: 'static_copy_server_mismatch' });
  const php = await createSite('php.copy.example.test', { runtime: 'php' });
  await assert.rejects(planner.preview({ ...request, targetWebsiteId: php.site.id }), { code: 'static_copy_runtime_unsupported' });
  const pending = await createSite('pending.copy.example.test', { ready: false });
  await assert.rejects(planner.preview({ ...request, targetWebsiteId: pending.site.id }), { code: 'static_copy_site_not_ready' });
});

test('rejects a managed child or a site with a managed child before scanning files', async (t) => {
  const { planner, request, source, createSite } = await staticSiteCopyFixture(t);
  const child = await createSite(`child.${source.domain.primaryDomain}`, { unixUid: 1103, parentDomainId: source.domain.id });
  await assert.rejects(planner.preview(request), { code: 'static_copy_subdomain_unsupported' });
  await assert.rejects(planner.preview({ ...request, sourceWebsiteId: child.site.id }), { code: 'static_copy_subdomain_unsupported' });
});

test('keeps the file worker size limit on a real sparse file', async (t) => {
  const { planner, request, source } = await staticSiteCopyFixture(t);
  const large = await fs.open(path.join(source.release, 'large.dat'), 'w');
  try { await large.truncate(16 * 1024 * 1024 + 1); } finally { await large.close(); }
  await assert.rejects(planner.preview(request), { code: 'site_file_too_large' });
});

test('official index bytes without an active bootstrap receipt cannot authorize replacement', async (t) => {
  const { makePlanner, request, receipts, target } = await staticSiteCopyFixture(t);
  // The real inspecting manager reads a deliberately empty, disposable receipt directory.
  // Identity is read from the actual disposable tree rather than invoking host account management.
  const staticBootstrapManager = createUploadedStaticBootstrapManager({ receiptRoot: receipts, identityManager: {
    async inspect({ user, homeDirectory }) {
      const info = await fs.stat(target.release);
      return { satisfied: true, user, homeDirectory, uid: info.uid, gid: info.gid };
    },
  } });
  await fs.writeFile(path.join(target.release, 'index.html'), target.spec.bootstrapContent);
  await assert.rejects(makePlanner(staticBootstrapManager).preview(request), { code: 'static_copy_target_not_empty' });
  assert.equal(await fs.readFile(path.join(target.release, 'index.html'), 'utf8'), target.spec.bootstrapContent);
});

test('a real Linux ACL and active bootstrap receipt allow the official index', {
  skip: process.platform !== 'linux' && 'Linux POSIX ACL and package inspection are required',
}, async (t) => {
  const run = promisify(execFile);
  const { DPKG_QUERY_PATH, GETFACL_PATH, SETFACL_PATH } = phpSiteBootstrapManagerInternals.paths;
  try {
    const { stdout } = await run(DPKG_QUERY_PATH, ['-W', '-f=${Status}', 'acl']);
    if (stdout.trim() !== 'install ok installed') return t.skip('The native acl package is unavailable');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 1) return t.skip('The native acl package is unavailable');
    throw error;
  }
  const uid = process.getuid();
  const gid = process.getgid();
  const users = (await fs.readFile('/etc/passwd', 'utf8')).split('\n').map((line) => line.split(':'));
  if (!users.some(([name]) => name === 'www-data')) return t.skip('The native Nginx identity is unavailable');
  const [, , nobodyUid, nobodyGid] = users.find(([name]) => name === 'nobody') ?? [];
  const unixUid = uid || Number(nobodyUid);
  const unixGid = gid || Number(nobodyGid);
  if (!unixUid || !unixGid || unixUid === 1101) return t.skip('Separate fixture Unix identities are required');
  const { makePlanner, request, receipts, target, toDisk } = await staticSiteCopyFixture(t, { targetOwner: { unixUid, unixGid } });
  const index = path.join(target.release, 'index.html');
  const appRoot = toDisk(target.spec.applicationRoot);
  const releasesRoot = toDisk(target.spec.releasesDirectory);
  await fs.writeFile(index, target.spec.bootstrapContent, { mode: 0o640 });
  await fs.mkdir(receipts, { mode: 0o700 });
  const receipt = path.join(receipts, `${target.releaseId}.json`);
  await fs.writeFile(receipt, JSON.stringify(phpSiteBootstrapManagerInternals.receiptCore(target.spec, 'active')), { mode: 0o600 });
  for (const directory of [appRoot, releasesRoot, target.release]) await fs.chmod(directory, 0o750);
  await fs.chmod(index, 0o640);
  if (uid === 0) {
    for (const item of [appRoot, releasesRoot, target.release, index, toDisk(target.site.documentRoot)]) {
      await fs.lchown(item, unixUid, unixGid);
    }
  }
  for (const directory of [appRoot, releasesRoot]) await run(SETFACL_PATH, ['-m', 'u:www-data:--x', directory]);
  await run(SETFACL_PATH, ['-m', 'u:www-data:r-x,d:u:www-data:r-x', target.release]);
  await run(SETFACL_PATH, ['-m', 'u:www-data:r--', index]);
  const staticBootstrapManager = createUploadedStaticBootstrapManager({ receiptRoot: receipts,
    lstatFn: (pathname) => fs.lstat(toDisk(pathname)), readFileFn: (pathname, encoding) => fs.readFile(toDisk(pathname), encoding),
    readlinkFn: (pathname) => fs.readlink(toDisk(pathname)),
    run: (file, args) => run(file, file === GETFACL_PATH ? [...args.slice(0, -1), toDisk(args.at(-1))] : args),
    identityManager: { async inspect({ user, homeDirectory }) {
      const info = await fs.stat(target.release);
      return { satisfied: true, user, homeDirectory, uid: info.uid, gid: info.gid };
    } },
  });
  const planner = makePlanner(staticBootstrapManager);
  const plan = await planner.preview(request);
  assert.deepEqual(plan.targetBootstrap, { path: 'index.html', sha256: sha(target.spec.bootstrapContent), releaseId: target.releaseId });
  assert.deepEqual(await planner.revalidate(plan), plan);
  await fs.unlink(receipt);
  await assert.rejects(planner.revalidate(plan), { code: 'static_copy_target_not_empty' });
});
