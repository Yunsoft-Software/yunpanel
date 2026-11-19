import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { createUploadedStaticBootstrapManager } from '@yunpanel/host-runtime/php-site-bootstrap-manager';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INDEX = 'index.html';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

function ownsRuntime(evidence, site, application, releaseRoot) {
  return evidence?.satisfied === true && evidence.adapter === 'static-bootstrap'
    && evidence.websiteId === site.id && evidence.applicationId === application.id
    && evidence.unixUser === site.unixUser && evidence.documentRoot === site.documentRoot
    && evidence.currentRelease === site.documentRoot && evidence.releaseDirectory === releaseRoot
    && evidence.releaseId === application.currentReleaseId
    && Number.isSafeInteger(evidence.unixUid) && evidence.unixUid > 0
    && Number.isSafeInteger(evidence.unixGid) && evidence.unixGid > 0
    && SHA256.test(evidence.indexSha256 ?? '');
}

export function createStaticSiteCopyPlanner({
  websiteRegistry, applicationRegistry, domainRegistry, websiteProvisioningRegistry, siteFileManager, localServerId,
  staticBootstrapManager = createUploadedStaticBootstrapManager(), realpathFn = realpath, statFn = stat,
} = {}) {
  async function rootIdentity(documentRoot, releaseRoot) {
    try {
      if (await realpathFn(documentRoot) === releaseRoot && await realpathFn(releaseRoot) === releaseRoot) {
        const current = await statFn(releaseRoot, { bigint: true });
        if (current.isDirectory()) return { rootDevice: String(current.dev), rootInode: String(current.ino) };
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
    }
    throw fail('static_copy_release_unverified', 'Etkin site dizini doğrulanamadı.');
  }

  async function loadSite(websiteId) {
    const site = await websiteRegistry.getWebsite(websiteId);
    if (site?.id !== websiteId) throw fail('static_copy_website_not_found', 'Site bulunamadı.', 404);
    if (!UUID.test(localServerId ?? '') || site.serverId !== localServerId) {
      throw fail('static_copy_server_mismatch', 'İki site aynı yerel sunucuda olmalıdır.');
    }
    if (site.runtimeType !== 'static' || !UUID.test(site.applicationId ?? '')) {
      throw fail('static_copy_runtime_unsupported', 'Kopyalama dosya yüklemeli statik sitelerde kullanılabilir.');
    }
    const application = await applicationRegistry.getApplication(site.applicationId);
    if (application?.id !== site.applicationId || application.serverId !== site.serverId
      || application.type !== 'static' || application.repositoryUrl !== null) {
      throw fail('static_copy_runtime_unsupported', 'Kopyalama dosya yüklemeli statik sitelerde kullanılabilir.');
    }
    if (application.state !== 'active' || !UUID.test(application.currentReleaseId ?? '')) {
      throw fail('static_copy_site_not_ready', 'Sitenin etkin yayını hazır olmalıdır.');
    }
    const identity = createApplicationIdentity(application.id);
    const documentRoot = path.posix.join(identity.paths.static.publishRoot, 'current');
    const releaseRoot = path.posix.join(identity.paths.static.publishRoot, 'releases', application.currentReleaseId);
    if (site.unixUser !== identity.unixUser || site.documentRoot !== documentRoot || application.webRoot !== documentRoot) {
      throw fail('static_copy_release_unverified', 'Etkin site dizini doğrulanamadı.');
    }
    return { site, application, documentRoot, releaseRoot };
  }

  async function readEndpoint({ site, application, documentRoot, releaseRoot }) {
    const operation = await websiteProvisioningRegistry.getLatestForWebsite(site.id);
    const step = operation?.steps.find(({ id }) => id === 'runtime');
    const intent = step?.intent;
    const evidence = step?.evidence;
    if (operation?.ready !== true || operation.websiteId !== site.id || operation.operationId !== application.currentReleaseId
      || step?.state !== 'succeeded' || !['pending', 'not_required'].includes(step.compensation.state)
      || intent?.adapter !== 'static' || intent.mode !== 'upload' || intent.websiteId !== site.id
      || intent.applicationId !== application.id || intent.unixUser !== site.unixUser || intent.documentRoot !== documentRoot
      || !ownsRuntime(evidence, site, application, releaseRoot)) {
      throw fail('static_copy_site_not_ready', 'Dosya yüklemeli site kurulum kaydı doğrulanamadı.');
    }
    const root = await rootIdentity(documentRoot, releaseRoot);
    return {
      endpoint: Object.freeze({
        websiteId: site.id, websiteRevision: site.revision, applicationId: application.id,
        applicationRevision: application.desiredRevision, serverId: site.serverId,
        unixUser: site.unixUser, unixUid: evidence.unixUid, unixGid: evidence.unixGid,
        releaseId: application.currentReleaseId, documentRoot, releaseRoot, ...root,
      }),
      evidence,
    };
  }

  async function targetBootstrap(targetRecord, { endpoint, evidence }, files) {
    if (files.length === 0) return null;
    const entry = files[0];
    if (files.length === 1 && entry.path === INDEX && entry.type === 'file' && entry.sha256 === evidence.indexSha256) {
      const { site, application, releaseRoot } = targetRecord;
      const intent = { websiteId: endpoint.websiteId, applicationId: endpoint.applicationId,
        unixUser: endpoint.unixUser, documentRoot: endpoint.documentRoot };
      // Strict inspection checks the active bootstrap receipt, canonical link, ownership, ACL and official index bytes.
      const live = await staticBootstrapManager.inspect(intent, { operationId: endpoint.releaseId }).catch((error) => {
        if (error.code === 'php_site_bootstrap_content_drift' || error.code === 'php_site_receipt_invalid') return null;
        throw error;
      });
      if (ownsRuntime(live, site, application, releaseRoot) && live.indexSha256 === entry.sha256
        && live.unixUid === evidence.unixUid && live.unixGid === evidence.unixGid) {
        return Object.freeze({ path: INDEX, sha256: entry.sha256, releaseId: live.releaseId });
      }
    }
    throw fail('static_copy_target_not_empty', 'Hedefte mevcut dosyalar var.');
  }

  async function preview({ sourceWebsiteId, targetWebsiteId } = {}, { fileManager = siteFileManager } = {}) {
    if (!UUID.test(sourceWebsiteId ?? '') || !UUID.test(targetWebsiteId ?? '') || sourceWebsiteId === targetWebsiteId) {
      throw fail('static_copy_website_pair_invalid', 'Kaynak ve hedef olarak ayrı siteler seçin.', 400);
    }
    const [sourceRecord, targetRecord, domains] = await Promise.all([
      loadSite(sourceWebsiteId), loadSite(targetWebsiteId), domainRegistry.listDomains(),
    ]);
    const websiteIds = new Set([sourceWebsiteId, targetWebsiteId]);
    const boundDomains = domains.filter((domain) => websiteIds.has(domain.websiteId));
    const domainIds = new Set(boundDomains.map((domain) => domain.id));
    if (boundDomains.some((domain) => domain.parentDomainId) || domains.some((domain) => domainIds.has(domain.parentDomainId))) {
      throw fail('static_copy_subdomain_unsupported', 'Yönetilen alt alan kökleri kopyalanamaz.');
    }
    if (sourceRecord.application.id === targetRecord.application.id || sourceRecord.site.unixUser === targetRecord.site.unixUser
      || overlaps(sourceRecord.releaseRoot, targetRecord.releaseRoot)) {
      throw fail('static_copy_roots_overlap', 'Kaynak ve hedef ayrı site dizinlerinde olmalıdır.');
    }
    const [sourceRead, targetRead] = await Promise.all([readEndpoint(sourceRecord), readEndpoint(targetRecord)]);
    const { endpoint: source } = sourceRead;
    const { endpoint: target } = targetRead;
    if (source.unixUid === target.unixUid || (source.rootDevice === target.rootDevice && source.rootInode === target.rootInode)) {
      throw fail('static_copy_roots_overlap', 'Kaynak ve hedef ayrı site dizinlerinde olmalıdır.');
    }
    const [sourceFiles, targetFiles] = await Promise.all([source, target].map(({ websiteId }) =>
      fileManager.execute(websiteId, { operation: 'manifest', path: '', exclude: [] })));
    const bootstrap = await targetBootstrap(targetRecord, targetRead, targetFiles.entries);
    const currentRoots = await Promise.all([source, target].map(({ documentRoot, releaseRoot }) => rootIdentity(documentRoot, releaseRoot)));
    if ([source, target].some(({ rootDevice, rootInode }, index) =>
      rootDevice !== currentRoots[index].rootDevice || rootInode !== currentRoots[index].rootInode)) {
      throw fail('static_copy_preview_stale', 'Kaynak veya hedef değişti. Önizlemeyi yenileyin.');
    }
    const files = Object.freeze(sourceFiles.entries.map((file) => Object.freeze(file)));
    const plan = { version: 1, source, target, files, targetBootstrap: bootstrap };
    return Object.freeze({ ...plan, digest: digest(plan) });
  }

  // The caller holds both application mutation locks and uses the returned plan.
  async function revalidate(plan, options) {
    if (plan?.version !== 1 || !SHA256.test(plan.digest ?? '')) {
      throw fail('static_copy_preview_stale', 'Kaynak veya hedef değişti. Önizlemeyi yenileyin.');
    }
    const current = await preview({ sourceWebsiteId: plan.source?.websiteId, targetWebsiteId: plan.target?.websiteId }, options);
    if (current.digest !== plan.digest) throw fail('static_copy_preview_stale', 'Kaynak veya hedef değişti. Önizlemeyi yenileyin.');
    return current;
  }

  return Object.freeze({ preview, revalidate });
}
