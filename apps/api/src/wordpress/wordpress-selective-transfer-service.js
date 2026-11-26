import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebsitePhpToolsServiceError } from '../php/website-php-tools-service.js';
import { filterSelectiveFileEntries, wordpressSelectiveTransferPolicy } from './wordpress-selective-transfer.js';
import { createWordPressSelectiveTransferJournal } from './wordpress-selective-transfer-journal.js';

const SCOPES = ['mu-plugins', 'plugins', 'themes'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => new WebsitePhpToolsServiceError(code, message, status);

export function normalizeWordPressSelectiveTransferOptions(input) {
  if (Object.keys(input).length !== 3 || !UUID.test(input.targetWebsiteId ?? '')
    || !Array.isArray(input.fileScopes) || !input.fileScopes.length || input.fileScopes.length > SCOPES.length
    || new Set(input.fileScopes).size !== input.fileScopes.length || !input.fileScopes.every(scope => SCOPES.includes(scope))) {
    throw fail('wordpress_selective_input_invalid', 'Hedef siteyi ve aktarılacak dosyaları seçin.', 400);
  }
  return { action: 'selective_transfer', targetWebsiteId: input.targetWebsiteId, fileScopes: [...input.fileScopes].sort() };
}

export function withWordPressTransferLocks(lock, source, target, action) {
  if (!UUID.test(source) || !UUID.test(target) || source === target) {
    throw fail('wordpress_selective_target_invalid', 'Kaynak ve hedef ayrı siteler olmalıdır.');
  }
  const [first, second] = [source, target].sort();
  return lock.withSiteLock({ applicationId: first }, () => lock.withSiteLock({ applicationId: second }, action));
}

export function createWordPressSelectiveTransferService({ context, config, run, actor, siteFileManager, jobRegistry,
  healthInspector, journal = createWordPressSelectiveTransferJournal() }) {
  const available = process.platform === 'linux' && typeof siteFileManager.withPinnedSites === 'function';

  async function authorize(owner, sourceId, targetId) {
    await actor(owner, sourceId);
    await actor(owner, targetId);
  }

  async function scope(site) {
    const documentRoot = site.website.documentRoot ?? site.cwd;
    const releaseRoot = await realpath(documentRoot);
    const root = await stat(releaseRoot, { bigint: true });
    const wordpressRoot = site.relativeRoot ? path.join(releaseRoot, site.relativeRoot) : releaseRoot;
    if (await realpath(wordpressRoot) !== wordpressRoot) throw fail('wordpress_selective_root_changed', 'WordPress dizini değişti.');
    const wp = await stat(wordpressRoot, { bigint: true });
    if (!root.isDirectory() || !wp.isDirectory() || root.dev !== wp.dev) throw fail('wordpress_selective_root_changed', 'WordPress dizini doğrulanamadı.');
    return { websiteId: site.website.id, applicationId: site.application.id, unixUser: site.unixUser, documentRoot, releaseRoot,
      rootDevice: String(root.dev), rootInode: String(root.ino), wordpressRoot, wordpressDevice: String(wp.dev), wordpressInode: String(wp.ino),
      relativeRoot: site.relativeRoot, websiteRevision: site.website.revision, domainId: site.domain.id,
      domainRevision: site.domain.desiredRevision ?? 1, certificateId: site.domain.certificateId ?? null, domain: site.primaryDomain };
  }

  async function siteDescriptor(site, saved) {
    await run(site.website.id, 'core', ['is-installed']);
    const raw = (await run(site.website.id, 'option', ['get', 'siteurl'])).stdout.trim();
    let url;
    try { url = new URL(raw); }
    catch { throw fail('wordpress_selective_url_invalid', 'WordPress site adresi doğrulanamadı.'); }
    const domains = site.domains.flatMap(domain => [domain.primaryDomain, ...(domain.aliases ?? [])]);
    if (!['http:', 'https:'].includes(url.protocol) || !domains.includes(url.hostname) || url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw fail('wordpress_selective_url_invalid', 'Kök adrese kurulu yerel WordPress sitesi seçin.');
    }
    return { websiteId: site.website.id, domain: url.hostname, url: url.origin, tablePrefix: saved.prefix };
  }

  const at = (site, relativePath) => [site.relativeRoot, relativePath].filter(Boolean).join('/');

  async function inventory(files, site, choices) {
    const entries = new Map();
    let totalBytes = 0;
    for (const choice of choices) {
      const relative = `wp-content/${choice}`;
      let manifest;
      try { manifest = await files.execute(site.websiteId, { operation: 'wordpress_manifest', path: at(site, relative), exclude: [] }); }
      catch (error) { if (error.code === 'site_file_not_found') continue; throw error; }
      entries.set(relative, { path: relative, type: 'directory' });
      for (const entry of manifest.entries) {
        const entryPath = `${relative}/${entry.path}`;
        entries.set(entryPath, { ...entry, path: entryPath });
        totalBytes += entry.bytes ?? 0;
      }
      if (entries.size > wordpressSelectiveTransferPolicy.maxEntries || totalBytes > wordpressSelectiveTransferPolicy.maxTotalBytes) {
        throw fail('wordpress_selective_files_limit', 'Seçili dosyalar aktarım sınırını aşıyor.', 413);
      }
    }
    return entries;
  }

  async function preview(websiteId, options, owner) {
    if (!available) throw fail('wordpress_selective_unavailable', 'Dosya aktarımı bu sunucuda kullanılamıyor.', 503);
    await authorize(owner, websiteId, options.targetWebsiteId);
    const [source, target] = await Promise.all([context(websiteId), context(options.targetWebsiteId)]);
    if (source.website.id === target.website.id || source.application.id === target.application.id
      || source.unixUser === target.unixUser || source.website.serverId !== target.website.serverId) {
      throw fail('wordpress_selective_target_invalid', 'Hedef aynı sunucuda ayrı bir WordPress sitesi olmalıdır.');
    }
    const [sourceConfig, targetConfig] = await Promise.all([config(source), config(target)]);
    if (!sourceConfig.present || !targetConfig.present) throw fail('wordpress_selective_not_installed', 'Her iki siteye de WordPress kurulu olmalıdır.');
    if (sourceConfig.environmentType !== 'staging' || (targetConfig.environmentType && targetConfig.environmentType !== 'production')) {
      throw fail('wordpress_selective_environment_invalid', 'Kaynak bir staging kurulumu, hedef bir yayın sitesi olmalıdır.');
    }
    if (sourceConfig.binding.id === targetConfig.binding.id || sourceConfig.binding.databaseName === targetConfig.binding.databaseName
      || sourceConfig.credential.username === targetConfig.credential.username) {
      throw fail('wordpress_selective_target_invalid', 'Siteler ayrı veritabanı ve kullanıcı kullanmalıdır.');
    }
    const [sourceSite, targetSite, stagingSite, productionSite] = await Promise.all([
      scope(source), scope(target), siteDescriptor(source, sourceConfig), siteDescriptor(target, targetConfig),
    ]);
    if (sourceSite.wordpressDevice === targetSite.wordpressDevice && sourceSite.wordpressInode === targetSite.wordpressInode) {
      throw fail('wordpress_selective_target_invalid', 'Kaynak ve hedef dosya dizinleri ayrı olmalıdır.');
    }
    const [sourceInventory, targetInventory] = await siteFileManager.withPinnedSites([sourceSite, targetSite], files => Promise.all([
      inventory(files, sourceSite, options.fileScopes), inventory(files, targetSite, options.fileScopes),
    ]));
    const selected = filterSelectiveFileEntries([...sourceInventory.values()], options.fileScopes);
    const changes = [];
    for (const item of selected.transferable) {
      if (item.type !== 'file') continue;
      const targetEntry = targetInventory.get(item.path);
      if (targetInventory.get(path.posix.dirname(item.path))?.type !== 'directory' || (targetEntry && targetEntry.type !== 'file')) {
        throw fail('wordpress_selective_directory_missing', 'Hedefte seçili dosyaların klasörlerini hazırlayın.');
      }
      const expectedTargetSha256 = targetEntry?.sha256 ?? null;
      if (expectedTargetSha256 !== item.sha256) changes.push({ path: item.path, bytes: item.bytes, sha256: item.sha256, expectedTargetSha256 });
    }
    if (!changes.length) throw fail('wordpress_selective_no_changes', 'Seçili dosyalar zaten aynı.');
    const createFileCount = changes.filter(item => item.expectedTargetSha256 === null).length;
    const summary = { transferableFileCount: changes.length, transferableBytes: changes.reduce((sum, item) => sum + item.bytes, 0),
      createFileCount, overwriteFileCount: changes.length - createFileCount };
    const identity = { source: sourceSite, target: targetSite, stagingSite, productionSite, changes,
      bindings: [sourceConfig, targetConfig].map(saved => [saved.configSha256, saved.binding.id, saved.binding.revision,
        saved.credential.id, saved.credential.revision]) };
    return { source: sourceSite, target: targetSite, changes, summary, digest: sha256(JSON.stringify(identity)) };
  }

  async function assertIdle(serverId, ids, currentJobId) {
    const jobs = await jobRegistry.listJobs({ serverId });
    if (jobs.some(job => job.id !== currentJobId && ['queued', 'running'].includes(job.status)
      && [job.resourceId, job.payload?.applicationId, job.payload?.websiteId, job.payload?.targetApplicationId,
        job.payload?.options?.targetWebsiteId].some(id => ids.includes(id)))) {
      throw fail('wordpress_job_conflict', 'Kaynak veya hedef sitede devam eden bir işlem var.');
    }
  }

  async function execute({ plan, payload, execution, owner }) {
    const { source, target, changes } = plan;
    const authorizeBoth = () => authorize(owner, source.websiteId, target.websiteId);
    await assertIdle(execution.serverId, [source.websiteId, source.applicationId, target.websiteId, target.applicationId], execution.jobId);
    await authorizeBoth();
    return siteFileManager.withPinnedSites([source, target], async (files) => {
      const transaction = await journal.prepare({ serverId: execution.serverId, jobId: execution.jobId, payload,
        target: { releaseRoot: target.wordpressRoot, expectedRoot: { device: target.wordpressDevice, inode: target.wordpressInode } },
        relativePaths: changes.map(item => item.path) });
      try {
        for (const entry of changes) {
          await authorizeBoth();
          const { content } = await files.execute(source.websiteId, { operation: 'wordpress_download', path: at(source, entry.path) });
          const bytes = Buffer.from(content, 'base64');
          if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw fail('wordpress_preview_stale', 'Kaynak dosya değişti.');
          const result = await transaction.apply({ relativePath: entry.path, expectedTargetSha256: entry.expectedTargetSha256, content: bytes });
          if (result.status !== 'applied') throw fail('wordpress_selective_transfer_interrupted', 'Dosya değişti. Aktarım geri alınıyor.');
        }
        // Allow a full timestamp check interval with the managed PHP OPcache defaults.
        await delay(3000);
        const health = await healthInspector.inspect({ primaryDomain: target.domain, healthPath: '/', timeoutSeconds: 30 });
        if (health?.satisfied !== true) throw fail('wordpress_selective_transfer_interrupted', 'Hedef site sağlık kontrolü geçmedi.');
        const applied = await inventory(files, target, payload.options.fileScopes);
        if (changes.some(entry => applied.get(entry.path)?.sha256 !== entry.sha256)) {
          throw fail('wordpress_selective_transfer_interrupted', 'Aktarılan dosyalar doğrulanamadı.');
        }
        await authorizeBoth();
      } catch (error) {
        const recovery = await transaction.rollback().catch(() => null);
        if (recovery?.status !== 'rolled_back') {
          throw fail('wordpress_selective_transfer_rollback_conflict', 'Bazı dosyalar değişti. Saklanan kopyaları işlem kaydından inceleyin.', 503);
        }
        throw fail('wordpress_selective_transfer_interrupted', 'Aktarım durduruldu. Seçili dosyalar geri alındı.', error.status ?? 409);
      }
    });
  }

  return Object.freeze({ available, preview, execute, assertIdle });
}
