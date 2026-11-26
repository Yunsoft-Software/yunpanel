import { createHash } from 'node:crypto';

const MANIFEST = Object.freeze({ operation: 'manifest', path: '', exclude: [] });

export class StaticSiteCopyTransferError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'StaticSiteCopyTransferError';
    this.code = code;
    this.status = status;
  }
}

export function createStaticSiteCopyTransfer({ planner, siteFileManager, siteMutationLock } = {}) {
  if (typeof planner?.revalidate !== 'function' || typeof siteFileManager?.withPinnedSites !== 'function'
    || typeof siteMutationLock?.withApplicationLock !== 'function') {
    throw new TypeError('Static site copy dependencies are required');
  }

  async function copy(plan, { authorize } = {}) {
    if (!plan?.source?.applicationId || !plan?.target?.applicationId || typeof authorize !== 'function') {
      throw new StaticSiteCopyTransferError('static_copy_plan_invalid', 'Kopya planı geçersiz.', 400);
    }
    const sites = [plan.source, plan.target].sort((left, right) => left.applicationId.localeCompare(right.applicationId));
    const [first, second] = sites;
    async function requireAccess() {
      for (const { websiteId } of sites) {
        if (await authorize(websiteId) !== true) {
          throw new StaticSiteCopyTransferError('static_copy_forbidden', 'Kaynak ve hedef siteye erişim gerekli.', 403);
        }
      }
    }
    await requireAccess();
    return siteMutationLock.withApplicationLock(first.applicationId, () =>
      siteMutationLock.withApplicationLock(second.applicationId, () => siteFileManager.withPinnedSites(sites, async (files) => {
        await requireAccess();
        const { source, target, files: entries, targetBootstrap, digest } = await planner.revalidate(plan, { fileManager: files });
        const index = targetBootstrap && entries.find((entry) => entry.path === targetBootstrap.path && entry.type === 'file');
        if (targetBootstrap && !index) {
          throw new StaticSiteCopyTransferError('static_copy_source_index_missing', 'Kaynak sitenin giriş dosyası bulunamadı.');
        }
        let filesCopied = 0;
        let bytesCopied = 0;
        for (const entry of index ? [...entries.filter((item) => item !== index), index] : entries) {
          await requireAccess();
          if (entry.type === 'directory') {
            await files.execute(target.websiteId, { operation: 'mkdir', path: entry.path });
            continue;
          }
          const { content } = await files.execute(source.websiteId, { operation: 'download', path: entry.path });
          const data = Buffer.from(content, 'base64');
          if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) {
            throw new StaticSiteCopyTransferError('static_copy_source_changed', 'Kaynak dosya değişti.');
          }
          await files.execute(target.websiteId, { operation: 'upload', path: entry.path, content,
            expectedSha256: entry === index ? targetBootstrap.sha256 : null });
          filesCopied += 1;
          bytesCopied += data.length;
        }
        const [sourceFiles, targetFiles] = await Promise.all([source, target].map(({ websiteId }) => files.execute(websiteId, MANIFEST)));
        const expected = JSON.stringify(entries);
        if (JSON.stringify(sourceFiles.entries) !== expected || JSON.stringify(targetFiles.entries) !== expected) {
          throw new StaticSiteCopyTransferError('static_copy_content_changed', 'Kopya dosyaları doğrulanamadı.');
        }
        await requireAccess();
        return Object.freeze({ sourceWebsiteId: source.websiteId, targetWebsiteId: target.websiteId, digest, filesCopied, bytesCopied });
      })));
  }

  return Object.freeze({ copy });
}
