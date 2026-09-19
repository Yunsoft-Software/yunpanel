import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCacheIsolationManager,
  CacheIsolationError,
} from '../src/cache-isolation-manager.js';

const VALID_USER = 'yunapp-0123456789ab';
const VALID_PASSWORD = 'a_very_strong_password_12345';
const VALID_PREFIX = 'mysite:';

test('applyRedisAcl validates parameters', async () => {
  const manager = createCacheIsolationManager();

  // Invalid username
  await assert.rejects(
    async () => manager.applyRedisAcl({ username: 'bad user!', password: VALID_PASSWORD }),
    (err) => err instanceof CacheIsolationError && err.code === 'redis_username_invalid',
  );

  // Short password
  await assert.rejects(
    async () => manager.applyRedisAcl({ username: VALID_USER, password: 'short' }),
    (err) => err instanceof CacheIsolationError && err.code === 'redis_password_invalid',
  );

  // Password with space
  await assert.rejects(
    async () => manager.applyRedisAcl({ username: VALID_USER, password: 'password with spaces 1234' }),
    (err) => err instanceof CacheIsolationError && err.code === 'redis_password_invalid',
  );

  // Invalid DB
  await assert.rejects(
    async () => manager.applyRedisAcl({ username: VALID_USER, password: VALID_PASSWORD, allowedDb: 25 }),
    (err) => err instanceof CacheIsolationError && err.code === 'redis_db_invalid',
  );
});

test('applyRedisAcl generates correct redis-cli ACL arguments and restricts dangerous commands', async () => {
  const calls = [];

  const manager = createCacheIsolationManager({
    run: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'OK\n', stderr: '' };
    },
  });

  const result = await manager.applyRedisAcl({
    username: VALID_USER,
    password: VALID_PASSWORD,
    keyPrefix: VALID_PREFIX,
    allowedDb: 2,
    dangerousCommandsDisabled: true,
  });

  assert.equal(result.applied, true);
  assert.equal(result.username, VALID_USER);
  assert.equal(result.keyPrefix, VALID_PREFIX);
  assert.equal(result.allowedDb, 2);

  assert.equal(calls.length, 2);
  const firstCall = calls[0];
  assert.equal(firstCall.file, '/usr/bin/redis-cli');
  assert.ok(firstCall.args.includes('ACL'));
  assert.ok(firstCall.args.includes('SETUSER'));
  assert.ok(firstCall.args.includes(VALID_USER));
  assert.ok(firstCall.args.includes(`>${VALID_PASSWORD}`));
  assert.ok(firstCall.args.includes(`~${VALID_PREFIX}*`));
  assert.ok(firstCall.args.includes('+select|2'));
  assert.ok(firstCall.args.includes('-FLUSHALL'));
  assert.ok(firstCall.args.includes('-FLUSHDB'));
  assert.ok(firstCall.args.includes('-CONFIG'));

  const secondCall = calls[1];
  assert.deepEqual(secondCall.args, ['ACL', 'SAVE']);
});

test('removeRedisAcl executes ACL DELUSER', async () => {
  const calls = [];

  const manager = createCacheIsolationManager({
    run: async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'OK\n', stderr: '' };
    },
  });

  const result = await manager.removeRedisAcl({ username: VALID_USER });
  assert.equal(result.removed, true);
  assert.equal(result.username, VALID_USER);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('ACL'));
  assert.ok(calls[0].args.includes('DELUSER'));
  assert.ok(calls[0].args.includes(VALID_USER));
  assert.deepEqual(calls[1].args, ['ACL', 'SAVE']);
});

test('inspectRedisAcl returns user existence status', async () => {
  const manager = createCacheIsolationManager({
    run: async (file, args) => {
      if (args[2] === VALID_USER) {
        return { stdout: 'flags on keys ~mysite:* commands +@read\n', stderr: '' };
      }
      return { stdout: '(nil)\n', stderr: '' };
    },
  });

  const existing = await manager.inspectRedisAcl({ username: VALID_USER });
  assert.equal(existing.exists, true);
  assert.equal(existing.username, VALID_USER);

  const missing = await manager.inspectRedisAcl({ username: 'yunapp-nonexistent' });
  assert.equal(missing.exists, false);
});

test('generateMemcachedPolicy returns structured policy with user prefix and socket', () => {
  const manager = createCacheIsolationManager();

  const policy = manager.generateMemcachedPolicy({
    unixUser: VALID_USER,
    websiteId: 'website-123',
  });

  assert.equal(policy.type, 'memcached');
  assert.equal(policy.websiteId, 'website-123');
  assert.equal(policy.unixUser, VALID_USER);
  assert.equal(policy.keyPrefix, `${VALID_USER}:`);
  assert.equal(policy.socketPath, `/run/memcached/${VALID_USER}.sock`);
  assert.equal(policy.defaultHost, '127.0.0.1');
  assert.equal(policy.defaultPort, 11211);
});
