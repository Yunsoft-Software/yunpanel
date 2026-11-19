import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { phpSiteBootstrapManagerInternals } from '@yunpanel/host-runtime/php-site-bootstrap-manager';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDatabaseBindingRegistry } from '../src/database-binding-registry.js';
import { createDatabaseCredentialRegistry, databaseCredentialRegistryInternals } from '../src/database-credential-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createPhpSiteCopyPlanner } from '../src/php-site-copy-plan.js';
import { createServerRegistry } from '../src/server-registry.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import { createWebsiteProvisioningRegistry } from '../src/website-provisioning-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

const MANAGED_ROOT = '/var/lib/yunpanel';
const CONTRACT_FILE = '.php-copy-fixture.json';
const sourceIndex = '<?php echo "Kaynak uygulama";';
const { bootstrapIndex, bootstrapIndexSha256 } = phpSiteBootstrapManagerInternals;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, { sharedUid = false, targetReady = true, wrongTargetOwner = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yp-php-copy-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const managedTree = path.join(directory, 'managed');
  const toDisk = (name) => path.join(managedTree, path.posix.relative(MANAGED_ROOT, name));
  const readCanonicalPath = async (name) => {
    const resolved = await fs.realpath(toDisk(name));
    return resolved.startsWith(`${managedTree}/`) ? path.posix.join(MANAGED_ROOT, path.relative(managedTree, resolved)) : resolved;
  };
  const opened = new Map();
  const filesystem = {
    stat: (name, options) => fs.stat(toDisk(name), options),
    lstat: (name) => fs.lstat(toDisk(name)),
    readFile: (name) => fs.readFile(toDisk(name)),
    readdir: (name, options) => fs.readdir(toDisk(name), options),
    open: async (name, ...args) => {
      const handle = await fs.open(toDisk(name), ...args);
      opened.set(handle.fd, name);
      return handle;
    },
    // Use real handles with a path lookup on platforms without /proc/self/fd.
    realpath: (name) => name.startsWith('/proc/self/fd/')
      ? readCanonicalPath(opened.get(Number(path.basename(name)))) : readCanonicalPath(name),
  };
  const storage = (name) => path.join(directory, name + '.json');
  const servers = createServerRegistry({ filePath: storage('servers') });
  const server = await servers.createLocalServer({ hostname: 'php-copy.example.test' });
  const serverExists = async (id) => Boolean(await servers.getServer(id));
  const applicationRegistry = createApplicationRegistry({ filePath: storage('applications'), serverExists });
  const getApplication = applicationRegistry.getApplication;
  const websiteRegistry = createWebsiteRegistry({ filePath: storage('websites'), serverExists, getApplication });
  const getWebsite = websiteRegistry.getWebsite;
  const domainRegistry = createDomainRegistry({ filePath: storage('domains'), serverExists, getWebsite });
  const websiteProvisioningRegistry = createWebsiteProvisioningRegistry({ filePath: storage('provisioning') });
  const databaseBindingRegistry = createDatabaseBindingRegistry({ filePath: storage('bindings'), serverExists, getWebsite, getApplication });
  const databaseCredentialRegistry = createDatabaseCredentialRegistry({ filePath: storage('credentials'),
    masterKey: randomBytes(32).toString('hex'), getDatabaseBinding: databaseBindingRegistry.getBinding });
  const siteFileManager = { async execute(websiteId, operation) {
    const { documentRoot } = await getWebsite(websiteId);
    return executeSiteFileOperation({ ...operation, root: documentRoot }, filesystem);
  } };

  async function publish(domain, checksum = sha(domain.primaryDomain)) {
    await domainRegistry.markStaged(domain.id, { checksum, configName: domain.id + '.conf' });
    return domainRegistry.markApplied(domain.id, { checksum });
  }

  async function bind(site, databaseName) {
    return databaseBindingRegistry.bindDatabase({ serverId: site.serverId, websiteId: site.id, applicationId: site.applicationId,
      databaseName, confirmation: `bind-database:${site.serverId}:${databaseName}:${site.id}` });
  }

  async function createSite(name, { uid, gid, ready = true, parentDomainId = null, serverId = server.id } = {}) {
    const application = await applicationRegistry.createPhpApplication({ serverId, name });
    const site = await websiteRegistry.createWebsite({ serverId, name, applicationId: application.id, runtimeType: 'php' });
    let domain = await domainRegistry.createDomain({ serverId, websiteId: site.id, primaryDomain: name,
      targetType: 'php', target: { applicationId: application.id }, parentDomainId });
    if (!ready) return { site, domain };
    domain = await publish(domain);
    const operationId = randomUUID();
    const intent = { websiteId: site.id, applicationId: application.id, unixUser: site.unixUser, documentRoot: site.documentRoot };
    const paths = createApplicationIdentity(application.id).paths;
    const spec = phpSiteBootstrapManagerInternals.normalizeIntent(intent, operationId);
    const release = toDisk(spec.releaseDocumentRoot);
    const home = toDisk(paths.workspace.homeDirectory);
    await fs.mkdir(release, { recursive: true });
    await fs.mkdir(home, { recursive: true, mode: 0o750 });
    await fs.symlink(path.relative(path.dirname(toDisk(spec.currentRelease)), toDisk(spec.currentLinkTarget)), toDisk(spec.currentRelease));
    const steps = [
      { id: 'php_bootstrap', adapter: 'php-bootstrap', evidence: { ...intent, unixUid: uid, unixGid: gid, releaseId: operationId,
        currentRelease: spec.currentRelease, releaseDirectory: spec.releaseDirectory, indexSha256: bootstrapIndexSha256 } },
      { id: 'php_runtime', adapter: 'php-fpm', evidence: { containerLocked: true, releaseUid: uid, releaseGid: gid } },
    ];
    await websiteProvisioningRegistry.create({ operationId, websiteId: site.id, resources: { application }, steps:
      steps.map(({ id, adapter }) => ({ id, intent: { adapter, ...intent } })) });
    for (const { id: stepId, adapter, evidence } of steps) {
      await websiteProvisioningRegistry.beginStep({ operationId, stepId });
      await websiteProvisioningRegistry.completeStep({ operationId, stepId, evidence: { satisfied: true, adapter, ...evidence } });
    }
    const binding = await bind(site, 'data_' + name.split('.')[0]);
    const username = databaseCredentialRegistryInternals.usernameFor(binding.id);
    const secret = randomBytes(24).toString('base64url');
    const credential = await databaseCredentialRegistry.createCredential({ databaseBindingId: binding.id, initialPassword: secret,
      confirmation: `create-database-credential:${binding.id}:${username}` });
    return { site, domain, application, operationId, release, home, binding, credential, secret };
  }

  const targetUid = process.getuid() || 1302;
  const targetGid = process.getgid() || 1302;
  const source = await createSite('source.php-copy.example.test', { uid: sharedUid ? targetUid : targetUid + 1, gid: targetGid });
  const target = await createSite('target.php-copy.example.test', { uid: wrongTargetOwner ? targetUid + 2 : targetUid,
    gid: targetGid, ready: targetReady });
  const writeSourceContract = async ({ binding = source.binding, credential = source.credential, version = 1 } = {}) => {
    await fs.writeFile(path.join(source.home, CONTRACT_FILE), JSON.stringify({ version, bindingId: binding.id,
      credentialId: credential.id, password: source.secret }), { mode: 0o600 });
  };
  await fs.writeFile(path.join(source.release, 'index.php'), sourceIndex);
  await writeSourceContract();
  if (targetReady) {
    const index = path.join(target.release, 'index.php');
    await fs.writeFile(index, bootstrapIndex, { mode: 0o640 });
    if (process.getuid() === 0) await fs.chown(index, targetUid, targetGid);
  }

  async function inspectContract({ homeDirectory }) {
    try {
      const { version, bindingId, credentialId } = JSON.parse(await fs.readFile(toDisk(path.join(homeDirectory, CONTRACT_FILE)), 'utf8'));
      return { version, bindingId, credentialId };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  const planner = createPhpSiteCopyPlanner({ localServerId: server.id, websiteRegistry, applicationRegistry, domainRegistry,
    websiteProvisioningRegistry, databaseBindingRegistry, databaseCredentialRegistry, siteFileManager, inspectContract,
    realpathFn: filesystem.realpath, statFn: filesystem.stat });
  return { source, target, createSite, bind, publish, writeSourceContract, planner, domainRegistry, databaseCredentialRegistry,
    storage, request: { sourceWebsiteId: source.site.id, targetWebsiteId: target.site.id } };
}

test('PHP copy pins separate active publications, public bytes and persisted database identities', async (t) => {
  const { planner, request, source, target, storage } = await fixture(t);
  const plan = await planner.preview(request);
  for (const [record, endpoint] of [[source, plan.source], [target, plan.target]]) {
    assert.equal(endpoint.applicationId, record.application.id);
    assert.equal(endpoint.releaseId, record.operationId);
    assert.match(endpoint.rootInode, /^\d+$/);
    assert.equal(endpoint.domain.id, record.domain.id);
    assert.equal(endpoint.domain.appliedChecksum, record.domain.appliedChecksum);
    assert.equal(endpoint.domain.appliedRevision, record.domain.appliedRevision);
    assert.deepEqual(endpoint.database, { bindingId: record.binding.id, bindingRevision: record.binding.revision,
      credentialId: record.credential.id, credentialRevision: record.credential.revision, databaseName: record.binding.databaseName });
    for (const value of [record.secret, record.credential.username, CONTRACT_FILE]) {
      assert.ok(!JSON.stringify(plan).includes(value));
    }
  }
  const privateFile = await fs.readFile(path.join(source.home, CONTRACT_FILE));
  assert.ok(!JSON.stringify(plan).includes(sha(privateFile)));
  assert.deepEqual(plan.files, [{ path: 'index.php', type: 'file', bytes: Buffer.byteLength(sourceIndex), sha256: sha(sourceIndex) }]);
  assert.deepEqual(plan.targetBootstrap, { path: 'index.php', releaseId: target.operationId, sha256: bootstrapIndexSha256 });
  assert.notEqual(plan.source.unixUid, plan.target.unixUid);
  assert.ok(Object.isFrozen(plan.source.domain) && Object.isFrozen(plan.target.database) && Object.isFrozen(plan.files[0]));
  assert.deepEqual(await planner.revalidate(plan), plan);
  assert.equal(await fs.readFile(path.join(target.release, 'index.php'), 'utf8'), bootstrapIndex);
  assert.ok(!(await fs.readFile(storage('credentials'), 'utf8')).includes(source.secret));
});

test('PHP copy rejects unsupported source files and private binding identity', async (t) => {
  const { planner, request, source, target, writeSourceContract } = await fixture(t);
  const index = path.join(source.release, 'index.php');
  await fs.writeFile(index, bootstrapIndex);
  await assert.rejects(planner.preview(request), { code: 'php_copy_source_contract_unsupported' });
  await fs.writeFile(index, sourceIndex);
  await writeSourceContract({ binding: target.binding, credential: target.credential });
  await assert.rejects(planner.preview(request), { code: 'php_copy_source_contract_unsupported' });
  await writeSourceContract({ version: 2 });
  await assert.rejects(planner.preview(request), { code: 'php_copy_source_contract_unsupported' });
  await writeSourceContract();
  await fs.writeFile(path.join(source.release, 'other.php'), '<?php');
  await assert.rejects(planner.preview(request), { code: 'php_copy_source_contract_unsupported' });
});

test('PHP copy rejects modified, extra and privately configured targets', async (t) => {
  const { planner, request, target } = await fixture(t);
  const index = path.join(target.release, 'index.php');
  await fs.writeFile(index, '<?php echo "Existing";');
  await assert.rejects(planner.preview(request), { code: 'php_copy_target_not_empty' });
  await fs.writeFile(index, bootstrapIndex);
  await fs.chmod(index, 0o644);
  await assert.rejects(planner.preview(request), { code: 'php_copy_target_not_empty' });
  await fs.chmod(index, 0o640);
  const extra = path.join(target.release, 'notes');
  await fs.writeFile(extra, 'Keep');
  await assert.rejects(planner.preview(request), { code: 'php_copy_target_not_empty' });
  await fs.rm(extra);
  await fs.writeFile(path.join(target.home, CONTRACT_FILE), JSON.stringify({ version: 1, bindingId: target.binding.id, credentialId: target.credential.id }));
  await assert.rejects(planner.preview(request), { code: 'php_copy_target_not_empty' });
});

test('PHP copy verifies bootstrap UID against the real target file', async (t) => {
  const { planner, request } = await fixture(t, { wrongTargetOwner: true });
  await assert.rejects(planner.preview(request), { code: 'php_copy_target_not_empty' });
});

test('PHP copy rejects the same website, shared Unix UID and unsupported active release links', async (t) => {
  const { planner, request, source, target } = await fixture(t, { sharedUid: true });
  await assert.rejects(planner.preview({ sourceWebsiteId: source.site.id, targetWebsiteId: source.site.id }),
    { code: 'php_copy_website_pair_invalid' });
  await assert.rejects(planner.preview(request), { code: 'php_copy_roots_overlap' });
  const link = path.resolve(target.release, '..', '..', '..', 'current');
  await fs.unlink(link);
  await fs.symlink(path.dirname(source.release), link);
  await assert.rejects(planner.preview(request), { code: 'php_copy_release_unverified' });
});

test('PHP copy rejects unpublished domains and parent sites with a managed child', async (t) => {
  const { planner, request, source, createSite } = await fixture(t, { targetReady: false });
  await assert.rejects(planner.preview(request), { code: 'php_copy_domain_unverified' });
  await createSite('child.source.php-copy.example.test', { ready: false, parentDomainId: source.domain.id });
  await assert.rejects(planner.preview(request), { code: 'php_copy_subdomain_unsupported' });
});

test('PHP copy requires one database and rejects stale content, credential and domain publication', async (t) => {
  const { planner, request, source, target, publish, bind, databaseCredentialRegistry } = await fixture(t);
  const original = await planner.preview(request);
  const index = path.join(source.release, 'index.php');
  await fs.writeFile(index, sourceIndex + ' /* changed */');
  await assert.rejects(planner.revalidate(original), { code: 'php_copy_preview_stale' });
  await fs.writeFile(index, sourceIndex);
  const { id, revision } = target.credential;
  await databaseCredentialRegistry.rotatePassword(id, { expectedRevision: revision, confirmation: `rotate-database-password:${id}:${revision}` });
  await assert.rejects(planner.revalidate(original), { code: 'php_copy_preview_stale' });
  const afterRotation = await planner.preview(request);
  await publish(target.domain, sha('updated Nginx publication'));
  await assert.rejects(planner.revalidate(afterRotation), { code: 'php_copy_preview_stale' });
  await bind(source.site, 'data_additional');
  await assert.rejects(planner.preview(request), { code: 'php_copy_database_scope_invalid' });
});
