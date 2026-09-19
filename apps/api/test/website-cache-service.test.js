import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebsiteCacheService,
  WebsiteCacheServiceError,
} from '../src/website-cache-service.js';
import { createWebsiteCachePolicyRegistry } from '../src/website-cache-policy-registry.js';

const WEBSITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIX_USER = 'yunapp-0123456789ab';
const MASTER_KEY = '12345678901234567890123456789012'; // 32 chars

function createMockRegistries({
  website = {
    id: WEBSITE_ID,
    unixUser: UNIX_USER,
  },
} = {}) {
  return {
    websiteRegistry: {
      getWebsite: async (id) => (id === WEBSITE_ID ? website : null),
    },
  };
}

test('getCachePolicy returns disabled when no cache configured', async () => {
  const { websiteRegistry } = createMockRegistries();
  const cachePolicyRegistry = createWebsiteCachePolicyRegistry({
    filePath: '/tmp/test-cache-policies.json',
    masterKey: MASTER_KEY,
    readFileFn: async () => JSON.stringify({ version: 1, policies: {} }),
    writeFileFn: async () => {},
    renameFn: async () => {},
    mkdirFn: async () => {},
  });

  const service = createWebsiteCacheService({
    websiteRegistry,
    cachePolicyRegistry,
    cacheIsolationManager: {},
  });

  const policy = await service.getCachePolicy(WEBSITE_ID);
  assert.equal(policy.enabled, false);
  assert.equal(policy.type, 'none');
  assert.equal(policy.websiteId, WEBSITE_ID);
});

test('enableRedisCache applies ACL, encrypts secret and returns initial credentials', async () => {
  const { websiteRegistry } = createMockRegistries();
  let savedData = null;
  const cachePolicyRegistry = createWebsiteCachePolicyRegistry({
    filePath: '/tmp/test-cache-policies.json',
    masterKey: MASTER_KEY,
    readFileFn: async () => JSON.stringify({ version: 1, policies: {} }),
    writeFileFn: async (p, content) => { savedData = content; },
    renameFn: async () => {},
    mkdirFn: async () => {},
  });

  let aclCall = null;
  const mockCacheIsolation = {
    applyRedisAcl: async (params) => { aclCall = params; return { applied: true }; },
    inspectRedisAcl: async () => ({ exists: true }),
  };

  const service = createWebsiteCacheService({
    websiteRegistry,
    cachePolicyRegistry,
    cacheIsolationManager: mockCacheIsolation,
  });

  const result = await service.enableRedisCache(WEBSITE_ID, {
    keyPrefix: 'site1:',
    allowedDb: 1,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.type, 'redis');
  assert.equal(result.redis.username, UNIX_USER);
  assert.equal(result.redis.keyPrefix, 'site1:');
  assert.equal(result.redis.allowedDb, 1);
  assert.ok(typeof result.redis.password === 'string' && result.redis.password.length >= 16);

  assert.equal(aclCall.username, UNIX_USER);
  assert.equal(aclCall.keyPrefix, 'site1:');
  assert.equal(aclCall.allowedDb, 1);
  assert.equal(aclCall.password, result.redis.password);

  // Subsequent getCachePolicy must redact password
  const policy = await service.getCachePolicy(WEBSITE_ID);
  assert.equal(policy.enabled, true);
  assert.equal(policy.type, 'redis');
  assert.equal(policy.redis.hasPassword, true);
  assert.equal(policy.redis.passwordRedacted, true);
  assert.equal(policy.redis.password, undefined);
  assert.equal(policy.redis.liveAclConfigured, true);
});

test('rotateRedisPassword generates new password and updates ACL', async () => {
  const { websiteRegistry } = createMockRegistries();
  const cachePolicyRegistry = createWebsiteCachePolicyRegistry({
    filePath: '/tmp/test-cache-policies.json',
    masterKey: MASTER_KEY,
    readFileFn: async () => JSON.stringify({ version: 1, policies: {} }),
    writeFileFn: async () => {},
    renameFn: async () => {},
    mkdirFn: async () => {},
  });

  let appliedPasswords = [];
  const mockCacheIsolation = {
    applyRedisAcl: async (params) => {
      appliedPasswords.push(params.password);
      return { applied: true };
    },
  };

  const service = createWebsiteCacheService({
    websiteRegistry,
    cachePolicyRegistry,
    cacheIsolationManager: mockCacheIsolation,
  });

  // First enable
  const initial = await service.enableRedisCache(WEBSITE_ID);
  assert.equal(appliedPasswords.length, 1);

  // Rotate
  const rotated = await service.rotateRedisPassword(WEBSITE_ID);
  assert.equal(rotated.rotated, true);
  assert.equal(appliedPasswords.length, 2);
  assert.notEqual(rotated.redis.password, initial.redis.password);
});

test('enableMemcached sets up memcached policy and disableCache removes it', async () => {
  const { websiteRegistry } = createMockRegistries();
  const cachePolicyRegistry = createWebsiteCachePolicyRegistry({
    filePath: '/tmp/test-cache-policies.json',
    masterKey: MASTER_KEY,
    readFileFn: async () => JSON.stringify({ version: 1, policies: {} }),
    writeFileFn: async () => {},
    renameFn: async () => {},
    mkdirFn: async () => {},
  });

  const mockCacheIsolation = {
    generateMemcachedPolicy: ({ unixUser, websiteId }) => ({
      type: 'memcached',
      websiteId,
      unixUser,
      keyPrefix: `${unixUser}:`,
      socketPath: `/run/memcached/${unixUser}.sock`,
    }),
  };

  const service = createWebsiteCacheService({
    websiteRegistry,
    cachePolicyRegistry,
    cacheIsolationManager: mockCacheIsolation,
  });

  const enabled = await service.enableMemcached(WEBSITE_ID);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.type, 'memcached');
  assert.equal(enabled.memcached.keyPrefix, `${UNIX_USER}:`);

  const disabled = await service.disableCache(WEBSITE_ID);
  assert.equal(disabled.disabled, true);

  const policy = await service.getCachePolicy(WEBSITE_ID);
  assert.equal(policy.enabled, false);
});
