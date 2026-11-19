import { createHash } from 'node:crypto';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MANIFEST = Object.freeze({ operation: 'manifest', path: '', exclude: [] });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

export function createPhpSiteCopyTransfer({ planner, siteFileManager, siteMutationLock, connection,
  databaseCopyManager, domainRegistry, removalRegistry, healthInspector = createWebsiteHttpHealthInspector() }) {
  async function assertIdle(sites) {
    for (const { websiteId } of sites) {
      const removals = await removalRegistry.listForWebsite(websiteId);
      if (removals.some(({ status }) => status !== 'removed')) {
        throw fail('php_copy_site_not_ready', 'Kaynak veya hedef site için kaldırma işlemi açık.');
      }
    }
  }

  async function credentialsFor({ source, target }) {
    const [sourceCredential, targetCredential] = await Promise.all([source, target].map(connection.materialize));
    return { source: sourceCredential, target: targetCredential };
  }

  async function preview(identities) {
    const site = await planner.preview(identities);
    const { bytes } = site.files[0];
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) {
      throw fail('php_copy_source_contract_unsupported', 'Kaynak PHP giriş dosyası kopyalama sınırına uymuyor.');
    }
    await assertIdle([site.source, site.target]);
    const inventory = await databaseCopyManager.inspect(await credentialsFor(site));
    return Object.freeze({ site, inventory, digest: hash(JSON.stringify([site.digest, inventory.inventorySha256])) });
  }

  async function assertPublished({ domain, websiteId }) {
    const current = await domainRegistry.getDomain(domain.id);
    if (current?.websiteId !== websiteId || current.state !== 'active'
      || ['primaryDomain', 'desiredRevision', 'appliedRevision', 'appliedChecksum', 'httpsMode', 'certificateId']
        .some((key) => (current[key] ?? null) !== (domain[key] ?? null))) {
      throw fail('php_copy_domain_unverified', 'Sitenin etkin yayını değişti.');
    }
  }

  async function copy(plan, { authorize }) {
    const sites = [plan.site.source, plan.site.target].sort((left, right) => left.applicationId.localeCompare(right.applicationId));
    async function requireAccess() {
      for (const { websiteId } of sites) {
        if (await authorize(websiteId) !== true) throw fail('php_copy_forbidden', 'Kaynak ve hedef siteye erişim gerekir.', 403);
      }
    }

    async function run(files) {
      await requireAccess();
      await assertIdle(sites);
      const site = await planner.revalidate(plan.site, { fileManager: files });
      const { source, target, targetBootstrap } = site;
      const [entry] = site.files;
      const scopes = await credentialsFor(site);
      const result = await databaseCopyManager.copy({ ...scopes, expectedInventorySha256: plan.inventory.inventorySha256,
        async authorizeBeforeImport() {
          await requireAccess();
          await assertIdle(sites);
          await planner.revalidate(site, { fileManager: files });
          return true;
        } });

      try {
        await requireAccess();
        await assertIdle(sites);
        await Promise.all(sites.map(assertPublished));
        const { content } = await files.execute(source.websiteId, { operation: 'download', path: entry.path });
        const bytes = Buffer.from(content, 'base64');
        if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) {
          throw fail('php_copy_preview_stale', 'Kaynak dosya değişti.');
        }
        if (await connection.inspect(source) === null) throw fail('php_copy_connection_invalid', 'Kaynak bağlantısı değişti.');
        await requireAccess();
        await connection.create(target);
        await requireAccess();
        await files.execute(target.websiteId, { operation: 'upload', path: targetBootstrap.path, content, expectedSha256: targetBootstrap.sha256 });
        for (const scope of sites) {
          const { entries } = await files.execute(scope.websiteId, MANIFEST);
          const [index] = entries;
          if (entries.length !== 1 || index?.path !== entry.path || index.type !== entry.type
            || index.bytes !== entry.bytes || index.sha256 !== entry.sha256 || await connection.inspect(scope) === null) {
            throw fail('php_copy_preview_stale', 'Kopyalanan dosyalar veya bağlantı doğrulanamadı.');
          }
          await assertPublished(scope);
        }
        const health = await healthInspector.inspect({ primaryDomain: target.domain.primaryDomain, healthPath: '/', timeoutSeconds: 30 });
        if (health?.satisfied !== true) throw fail('php_copy_http_unverified', 'Hedef PHP sitesi doğrulanamadı.');
        await requireAccess();
      } catch {
        throw fail('php_copy_partial', 'Veritabanı aktarıldı. Hedef dosyalarını ve site yanıtını kontrol edin.');
      }
      return Object.freeze({ sourceWebsiteId: source.websiteId, targetWebsiteId: target.websiteId, digest: plan.digest,
        filesCopied: 1, bytesCopied: entry.bytes, tablesCopied: result.tables, databaseBytes: result.bytes });
    }

    const [first, second] = sites;
    await requireAccess();
    return siteMutationLock.withApplicationLock(first.applicationId, () =>
      siteMutationLock.withApplicationLock(second.applicationId, () => siteFileManager.withPinnedSites(sites, run)));
  }

  return Object.freeze({ preview, copy });
}
