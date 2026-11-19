import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { phpSiteBootstrapManagerInternals } from '@yunpanel/host-runtime/php-site-bootstrap-manager';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INDEX = 'index.php';
const BOOTSTRAP_SHA = phpSiteBootstrapManagerInternals.bootstrapIndexSha256;
const validRevision = (value) => Number.isSafeInteger(value) && value > 0;
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function stale() {
  return fail('php_copy_preview_stale', 'Kaynak veya hedef değişti. Önizlemeyi yenileyin.');
}

function ownsStep(step, adapter, { websiteId, applicationId, unixUser, documentRoot }) {
  const intent = step?.intent;
  return step?.state === 'succeeded' && ['pending', 'not_required'].includes(step.compensation?.state)
    && intent?.adapter === adapter && intent.websiteId === websiteId && intent.applicationId === applicationId
    && intent.unixUser === unixUser && intent.documentRoot === documentRoot
    && step.evidence?.satisfied === true && step.evidence.adapter === adapter;
}

export function createPhpSiteCopyPlanner({
  localServerId, websiteRegistry, applicationRegistry, domainRegistry, websiteProvisioningRegistry,
  databaseBindingRegistry, databaseCredentialRegistry, siteFileManager, inspectContract,
  realpathFn = realpath, statFn = stat,
} = {}) {
  async function rootIdentity(documentRoot, releaseRoot) {
    try {
      if (await realpathFn(documentRoot) === releaseRoot && await realpathFn(releaseRoot) === releaseRoot) {
        const record = await statFn(releaseRoot, { bigint: true });
        if (record.isDirectory()) return { rootDevice: String(record.dev), rootInode: String(record.ino) };
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
    }
    throw fail('php_copy_release_unverified', 'Etkin site dizini doğrulanamadı.');
  }

  async function loadSite(websiteId, domains) {
    const site = await websiteRegistry.getWebsite(websiteId);
    if (site?.id !== websiteId) throw fail('php_copy_website_not_found', 'Site bulunamadı.', 404);
    if (!UUID.test(localServerId ?? '') || site.serverId !== localServerId) {
      throw fail('php_copy_server_mismatch', 'İki site aynı yerel sunucuda olmalıdır.');
    }
    if (site.runtimeType !== 'php' || !UUID.test(site.applicationId ?? '')) {
      throw fail('php_copy_runtime_unsupported', 'Kopyalama iki PHP sitesi gerektirir.');
    }
    const application = await applicationRegistry.getApplication(site.applicationId);
    if (application?.id !== site.applicationId || application.serverId !== site.serverId || application.type !== 'php') {
      throw fail('php_copy_runtime_unsupported', 'Kopyalama iki PHP sitesi gerektirir.');
    }
    const identity = createApplicationIdentity(application.id);
    const documentRoot = path.posix.join(identity.paths.runtime.currentRelease, 'public');
    if (site.unixUser !== identity.unixUser || site.documentRoot !== documentRoot || application.webRoot !== documentRoot) {
      throw fail('php_copy_release_unverified', 'Etkin site dizini doğrulanamadı.');
    }
    const bound = domains.filter((domain) => domain.websiteId === site.id);
    if (bound.some((domain) => domain.parentDomainId || domains.some((child) => child.parentDomainId === domain.id))) {
      throw fail('php_copy_subdomain_unsupported', 'Yönetilen alt alan kökleri kopyalanamaz.');
    }
    const domain = bound[0];
    if (bound.length !== 1 || domain.serverId !== site.serverId || domain.state !== 'active'
      || domain.targetType !== 'php' || domain.target?.applicationId !== application.id || domain.nginxSettings?.documentRoot
      || !validRevision(domain.desiredRevision) || domain.appliedRevision !== domain.desiredRevision
      || domain.appliedPrimaryDomain !== domain.primaryDomain || !SHA256.test(domain.appliedChecksum ?? '')) {
      throw fail('php_copy_domain_unverified', 'Sitenin etkin birincil yayını doğrulanamadı.');
    }
    const operation = await websiteProvisioningRegistry.getLatestForWebsite(site.id);
    const bootstrap = operation?.steps.find(({ id }) => id === 'php_bootstrap');
    const runtime = operation?.steps.find(({ id }) => id === 'php_runtime');
    const evidence = bootstrap?.evidence;
    const endpoint = {
      websiteId: site.id, websiteRevision: site.revision, applicationId: application.id,
      applicationRevision: application.desiredRevision, serverId: site.serverId, unixUser: identity.unixUser,
      documentRoot, homeDirectory: identity.paths.workspace.homeDirectory,
    };
    if (operation?.ready !== true || operation.websiteId !== site.id || !UUID.test(operation.operationId ?? '')
      || !ownsStep(bootstrap, 'php-bootstrap', endpoint) || !ownsStep(runtime, 'php-fpm', endpoint)
      || evidence.websiteId !== site.id || evidence.applicationId !== application.id
      || evidence.unixUser !== site.unixUser || evidence.documentRoot !== documentRoot || evidence.releaseId !== operation.operationId
      || evidence.indexSha256 !== BOOTSTRAP_SHA || !validRevision(evidence.unixUid) || !validRevision(evidence.unixGid)
      || runtime.evidence.containerLocked !== true || runtime.evidence.releaseUid !== evidence.unixUid
      || runtime.evidence.releaseGid !== evidence.unixGid) {
      throw fail('php_copy_site_not_ready', 'Sitenin PHP kurulum kaydı doğrulanamadı.');
    }
    const releaseRoot = path.posix.join(identity.paths.runtime.releasesDirectory, operation.operationId, 'public');
    const root = await rootIdentity(documentRoot, releaseRoot);
    return {
      ...endpoint, releaseId: operation.operationId, releaseRoot, ...root, unixUid: evidence.unixUid, unixGid: evidence.unixGid,
      domain: Object.freeze({ id: domain.id, primaryDomain: domain.primaryDomain, desiredRevision: domain.desiredRevision,
        appliedRevision: domain.appliedRevision, appliedChecksum: domain.appliedChecksum, httpsMode: domain.httpsMode,
        certificateId: domain.certificateId ?? null }),
    };
  }

  async function readDatabase({ websiteId, applicationId, serverId, unixUser }) {
    const bindings = await databaseBindingRegistry.listBindings({ websiteId });
    const binding = bindings[0];
    if (bindings.length !== 1 || binding.serverId !== serverId || binding.applicationId !== applicationId
      || binding.websiteId !== websiteId || binding.unixUser !== unixUser || !validRevision(binding.revision)) {
      throw fail('php_copy_database_scope_invalid', 'Her siteye kendisine ait tek bir veritabanı bağlı olmalıdır.');
    }
    const credential = await databaseCredentialRegistry.getForBinding(binding.id);
    if (credential?.databaseBindingId !== binding.id || credential.serverId !== serverId
      || credential.websiteId !== websiteId || credential.applicationId !== applicationId
      || credential.siteUnixUser !== unixUser || credential.databaseName !== binding.databaseName
      || credential.host !== 'localhost' || !validRevision(credential.revision)) {
      throw fail('php_copy_database_scope_invalid', 'Veritabanı kullanıcısı siteyle eşleşmiyor.');
    }
    const database = Object.freeze({ bindingId: binding.id, bindingRevision: binding.revision,
      credentialId: credential.id, credentialRevision: credential.revision, databaseName: binding.databaseName });
    return { database, username: credential.username };
  }

  async function preview({ sourceWebsiteId, targetWebsiteId } = {}, { fileManager = siteFileManager } = {}) {
    if (!UUID.test(sourceWebsiteId ?? '') || !UUID.test(targetWebsiteId ?? '') || sourceWebsiteId === targetWebsiteId) {
      throw fail('php_copy_website_pair_invalid', 'Kaynak ve hedef olarak ayrı siteler seçin.', 400);
    }
    const domains = await domainRegistry.listDomains();
    const [sourceSite, targetSite] = await Promise.all([sourceWebsiteId, targetWebsiteId].map((id) => loadSite(id, domains)));
    if (sourceSite.applicationId === targetSite.applicationId || sourceSite.unixUser === targetSite.unixUser
      || sourceSite.unixUid === targetSite.unixUid
      || (sourceSite.rootDevice === targetSite.rootDevice && sourceSite.rootInode === targetSite.rootInode)
      || sourceSite.releaseRoot.startsWith(`${targetSite.releaseRoot}/`)
      || targetSite.releaseRoot.startsWith(`${sourceSite.releaseRoot}/`)) {
      throw fail('php_copy_roots_overlap', 'Kaynak ve hedef ayrı site dizinlerinde olmalıdır.');
    }
    const [sourceDb, targetDb] = await Promise.all([readDatabase(sourceSite), readDatabase(targetSite)]);
    if (sourceDb.database.bindingId === targetDb.database.bindingId || sourceDb.database.credentialId === targetDb.database.credentialId
      || sourceDb.database.databaseName.toLowerCase() === targetDb.database.databaseName.toLowerCase()
      || sourceDb.username === targetDb.username) {
      throw fail('php_copy_database_scope_invalid', 'Kaynak ve hedef ayrı veritabanı bağlantıları kullanmalıdır.');
    }
    const source = Object.freeze({ ...sourceSite, database: sourceDb.database });
    const target = Object.freeze({ ...targetSite, database: targetDb.database });
    const [sourceFiles, targetFiles, sourceContract, targetContract] = await Promise.all([
      fileManager.execute(source.websiteId, { operation: 'manifest', path: '', exclude: [] }),
      fileManager.execute(target.websiteId, { operation: 'manifest', path: '', exclude: [] }),
      inspectContract(source), inspectContract(target),
    ]);
    const entry = sourceFiles.entries[0];
    if (sourceFiles.entries.length !== 1 || entry?.path !== INDEX || entry.type !== 'file'
      || !SHA256.test(entry.sha256 ?? '') || entry.sha256 === BOOTSTRAP_SHA || sourceContract?.version !== 1
      || sourceContract.bindingId !== source.database.bindingId || sourceContract.credentialId !== source.database.credentialId) {
      throw fail('php_copy_source_contract_unsupported', 'Kaynak site desteklenen dosya ve veritabanı bağlantısını kullanmıyor.');
    }
    const targetEntry = targetFiles.entries[0];
    if (targetContract !== null || targetFiles.entries.length !== 1 || targetEntry?.path !== INDEX
      || targetEntry.type !== 'file' || targetEntry.sha256 !== BOOTSTRAP_SHA) {
      throw fail('php_copy_target_not_empty', 'Hedefte mevcut site dosyaları veya veritabanı bağlantısı var.');
    }
    const index = await fileManager.execute(target.websiteId, { operation: 'read_text', path: INDEX });
    if (index.file?.type !== 'file' || index.file.mode !== '0640' || index.sha256 !== BOOTSTRAP_SHA
      || index.file.uid !== target.unixUid || index.file.gid !== target.unixGid) {
      throw fail('php_copy_target_not_empty', 'Hedefin başlangıç dosyası doğrulanamadı.');
    }
    const roots = await Promise.all([source, target].map(({ documentRoot, releaseRoot }) => rootIdentity(documentRoot, releaseRoot)));
    if ([source, target].some(({ rootDevice, rootInode }, i) => roots[i].rootDevice !== rootDevice || roots[i].rootInode !== rootInode)) {
      throw stale();
    }
    const files = Object.freeze([Object.freeze({ path: INDEX, type: 'file', bytes: entry.bytes, sha256: entry.sha256 })]);
    const targetBootstrap = Object.freeze({ path: INDEX, sha256: BOOTSTRAP_SHA, releaseId: target.releaseId });
    const plan = { version: 1, source, target, files, targetBootstrap };
    return Object.freeze({ ...plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') });
  }

  // The caller holds both application mutation locks and uses the returned plan.
  async function revalidate(plan, options) {
    if (plan?.version !== 1 || !SHA256.test(plan.digest ?? '')) throw stale();
    const current = await preview({ sourceWebsiteId: plan.source?.websiteId, targetWebsiteId: plan.target?.websiteId }, options);
    if (current.digest !== plan.digest) throw stale();
    return current;
  }

  return Object.freeze({ preview, revalidate });
}
