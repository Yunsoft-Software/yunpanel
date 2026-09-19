import { randomBytes } from 'node:crypto';
import { createCacheIsolationManager, CacheIsolationError } from '@yunpanel/host-runtime';

export class WebsiteCacheServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteCacheServiceError';
    this.code = code;
    this.status = status;
  }
}

export function createWebsiteCacheService({
  websiteRegistry,
  applicationRegistry,
  cachePolicyRegistry,
  cacheIsolationManager = createCacheIsolationManager(),
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !cachePolicyRegistry || typeof cachePolicyRegistry.get !== 'function') {
    throw new TypeError('Website cache service dependencies are invalid');
  }

  async function resolveWebsite(websiteId) {
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new WebsiteCacheServiceError('website_id_invalid', 'Website ID is invalid', 400);
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) {
      throw new WebsiteCacheServiceError('website_not_found', 'Website not found', 404);
    }
    const unixUser = website.unixUser;
    if (!unixUser) {
      throw new WebsiteCacheServiceError('website_unix_user_missing', 'Website Unix user is missing', 409);
    }
    return { website, unixUser };
  }

  async function getCachePolicy(websiteId) {
    const { unixUser } = await resolveWebsite(websiteId);
    const policy = await cachePolicyRegistry.get(websiteId);

    if (!policy || !policy.enabled) {
      return Object.freeze({
        enabled: false,
        type: 'none',
        websiteId,
      });
    }

    if (policy.type === 'redis') {
      let liveAcl = null;
      try {
        liveAcl = await cacheIsolationManager.inspectRedisAcl({ username: policy.redis.username });
      } catch {}

      return Object.freeze({
        enabled: true,
        type: 'redis',
        websiteId,
        redis: {
          username: policy.redis.username,
          keyPrefix: policy.redis.keyPrefix,
          allowedDb: policy.redis.allowedDb,
          hasPassword: Boolean(policy.redis.encryptedPassword),
          passwordRedacted: true,
          liveAclConfigured: liveAcl?.exists ?? false,
        },
        updatedAt: policy.updatedAt,
      });
    }

    if (policy.type === 'memcached') {
      return Object.freeze({
        enabled: true,
        type: 'memcached',
        websiteId,
        memcached: { ...policy.memcached },
        updatedAt: policy.updatedAt,
      });
    }

    return Object.freeze({ enabled: false, type: 'none', websiteId });
  }

  async function enableRedisCache(websiteId, { keyPrefix, allowedDb = 0 } = {}) {
    const { unixUser } = await resolveWebsite(websiteId);
    const password = randomBytes(18).toString('base64url');
    const prefix = keyPrefix || `${unixUser}:`;

    try {
      await cacheIsolationManager.applyRedisAcl({
        username: unixUser,
        password,
        keyPrefix: prefix,
        allowedDb,
        dangerousCommandsDisabled: true,
      });
    } catch (error) {
      if (error instanceof CacheIsolationError) {
        throw new WebsiteCacheServiceError(error.code, error.message, error.status);
      }
      throw error;
    }

    const encryptedPassword = cachePolicyRegistry.encryptSecret(password);
    const policyRecord = {
      type: 'redis',
      enabled: true,
      redis: {
        username: unixUser,
        encryptedPassword,
        keyPrefix: prefix,
        allowedDb,
      },
    };

    await cachePolicyRegistry.set(websiteId, policyRecord);

    return Object.freeze({
      enabled: true,
      type: 'redis',
      websiteId,
      redis: {
        username: unixUser,
        password, // Plain password returned ONLY upon generation
        keyPrefix: prefix,
        allowedDb,
        host: '127.0.0.1',
        port: 6379,
      },
    });
  }

  async function rotateRedisPassword(websiteId) {
    const { unixUser } = await resolveWebsite(websiteId);
    const existing = await cachePolicyRegistry.get(websiteId);
    if (!existing || existing.type !== 'redis') {
      throw new WebsiteCacheServiceError('redis_cache_not_enabled', 'Redis cache is not enabled for this website', 409);
    }

    const newPassword = randomBytes(18).toString('base64url');
    const prefix = existing.redis.keyPrefix;
    const allowedDb = existing.redis.allowedDb;

    try {
      await cacheIsolationManager.applyRedisAcl({
        username: unixUser,
        password: newPassword,
        keyPrefix: prefix,
        allowedDb,
        dangerousCommandsDisabled: true,
      });
    } catch (error) {
      if (error instanceof CacheIsolationError) {
        throw new WebsiteCacheServiceError(error.code, error.message, error.status);
      }
      throw error;
    }

    const encryptedPassword = cachePolicyRegistry.encryptSecret(newPassword);
    const updatedRecord = {
      ...existing,
      redis: {
        ...existing.redis,
        encryptedPassword,
      },
    };

    await cachePolicyRegistry.set(websiteId, updatedRecord);

    return Object.freeze({
      rotated: true,
      type: 'redis',
      websiteId,
      redis: {
        username: unixUser,
        password: newPassword, // Plain new password returned once
        keyPrefix: prefix,
        allowedDb,
      },
    });
  }

  async function enableMemcached(websiteId) {
    const { unixUser } = await resolveWebsite(websiteId);
    const memcachedPolicy = cacheIsolationManager.generateMemcachedPolicy({
      websiteId,
      unixUser,
    });

    const policyRecord = {
      type: 'memcached',
      enabled: true,
      memcached: memcachedPolicy,
    };

    await cachePolicyRegistry.set(websiteId, policyRecord);

    return Object.freeze({
      enabled: true,
      type: 'memcached',
      websiteId,
      memcached: memcachedPolicy,
    });
  }

  async function disableCache(websiteId) {
    const { unixUser } = await resolveWebsite(websiteId);
    const existing = await cachePolicyRegistry.get(websiteId);

    if (existing?.type === 'redis') {
      try {
        await cacheIsolationManager.removeRedisAcl({ username: existing.redis.username ?? unixUser });
      } catch {}
    }

    await cachePolicyRegistry.delete(websiteId);

    return Object.freeze({
      disabled: true,
      websiteId,
    });
  }

  return Object.freeze({
    getCachePolicy,
    enableRedisCache,
    rotateRedisPassword,
    enableMemcached,
    disableCache,
  });
}
