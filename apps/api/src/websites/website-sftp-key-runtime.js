import { createSftpAuthorizedKeyManager } from '@yunpanel/host-runtime/sftp-authorized-key-manager';
import { createWebsiteSftpKeyRegistry } from './website-sftp-key-registry.js';
import { createWebsiteSftpKeyService } from './website-sftp-key-service.js';

export async function createWebsiteSftpKeyRuntime({
  filePath = null,
  now,
  websiteRegistry,
  localServerId = null,
  authorizedKeyManager = null,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('Website SFTP key runtime requires a Website registry');
  }
  if (localServerId !== null && (typeof localServerId !== 'string' || localServerId.trim().length === 0)) {
    throw new Error('Website SFTP key runtime local Server identity is invalid');
  }
  const scopedWebsiteRegistry = Object.freeze({
    async getWebsite(websiteId) {
      const website = await websiteRegistry.getWebsite(websiteId);
      if (!website || (localServerId && website.serverId !== localServerId)) return null;
      return website;
    },
  });
  const keyRegistry = createWebsiteSftpKeyRegistry({
    filePath,
    ...(now ? { now } : {}),
    getWebsite: (websiteId) => scopedWebsiteRegistry.getWebsite(websiteId),
  });
  await keyRegistry.init();
  const service = createWebsiteSftpKeyService({
    keyRegistry,
    websiteRegistry: scopedWebsiteRegistry,
    authorizedKeyManager: authorizedKeyManager ?? createSftpAuthorizedKeyManager(),
  });
  return Object.freeze({ keyRegistry, service });
}
