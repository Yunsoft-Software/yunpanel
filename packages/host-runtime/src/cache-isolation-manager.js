import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REDIS_CLI_PATH = '/usr/bin/redis-cli';
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
const KEY_PREFIX_PATTERN = /^[a-zA-Z0-9_:-]{1,64}$/;

export class CacheIsolationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CacheIsolationError';
    this.code = code;
    this.status = status;
  }
}

export function createCacheIsolationManager({
  redisCliPath = REDIS_CLI_PATH,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 256 * 1024,
  }),
} = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('Cache isolation manager dependencies are invalid');
  }

  function validateRedisUserParams({ username, password, keyPrefix, allowedDb }) {
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw new CacheIsolationError('redis_username_invalid', 'Redis username is invalid');
    }
    if (typeof password !== 'string' || password.length < 16 || /[\s\u0000-\u001f\u007f]/.test(password)) {
      throw new CacheIsolationError('redis_password_invalid', 'Redis password must be at least 16 characters and contain no spaces or control characters');
    }
    if (keyPrefix !== undefined && (typeof keyPrefix !== 'string' || !KEY_PREFIX_PATTERN.test(keyPrefix))) {
      throw new CacheIsolationError('redis_key_prefix_invalid', 'Redis key prefix is invalid');
    }
    if (allowedDb !== undefined && (!Number.isInteger(allowedDb) || allowedDb < 0 || allowedDb > 15)) {
      throw new CacheIsolationError('redis_db_invalid', 'Redis allowed DB must be an integer between 0 and 15');
    }
  }

  async function applyRedisAcl({
    username,
    password,
    keyPrefix,
    allowedDb = 0,
    dangerousCommandsDisabled = true,
  } = {}) {
    validateRedisUserParams({ username, password, keyPrefix, allowedDb });

    const keyPattern = keyPrefix ? `~${keyPrefix}*` : '~*';
    const aclArgs = [
      'ACL', 'SETUSER', username,
      'on',
      `>${password}`,
      'resetkeys',
      keyPattern,
      '+@read',
      '+@write',
      '+@connection',
      `+select|${allowedDb}`,
    ];

    if (dangerousCommandsDisabled) {
      aclArgs.push(
        '-@dangerous',
        '-@admin',
        '-FLUSHALL',
        '-FLUSHDB',
        '-CONFIG',
        '-SHUTDOWN',
        '-DEBUG',
        '-SAVE',
        '-BGSAVE',
        '-SLAVEOF',
        '-REPLICAOF',
        '-MODULE',
        '-ACL',
      );
    }

    try {
      await run(redisCliPath, aclArgs);
      // Attempt to persist ACL if supported by Redis config
      try {
        await run(redisCliPath, ['ACL', 'SAVE']);
      } catch {
        // ACL SAVE may fail if redis.conf does not use aclfile, which is non-fatal for in-memory ACL
      }

      return Object.freeze({
        applied: true,
        username,
        keyPrefix: keyPrefix ?? null,
        allowedDb,
      });
    } catch (error) {
      throw new CacheIsolationError(
        'redis_acl_apply_failed',
        `Failed to apply Redis ACL for user ${username}: ${error.message}`,
        500,
      );
    }
  }

  async function removeRedisAcl({ username } = {}) {
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw new CacheIsolationError('redis_username_invalid', 'Redis username is invalid');
    }

    try {
      await run(redisCliPath, ['ACL', 'DELUSER', username]);
      try {
        await run(redisCliPath, ['ACL', 'SAVE']);
      } catch {}

      return Object.freeze({
        removed: true,
        username,
      });
    } catch (error) {
      throw new CacheIsolationError(
        'redis_acl_remove_failed',
        `Failed to remove Redis ACL for user ${username}: ${error.message}`,
        500,
      );
    }
  }

  async function inspectRedisAcl({ username } = {}) {
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      throw new CacheIsolationError('redis_username_invalid', 'Redis username is invalid');
    }

    try {
      const result = await run(redisCliPath, ['ACL', 'GETUSER', username]);
      const stdout = String(result?.stdout ?? '').trim();
      if (!stdout || stdout === '(nil)' || stdout.includes('Error')) {
        return Object.freeze({ exists: false, username });
      }

      return Object.freeze({
        exists: true,
        username,
        raw: stdout,
      });
    } catch {
      return Object.freeze({ exists: false, username });
    }
  }

  function generateMemcachedPolicy({ unixUser, websiteId } = {}) {
    if (!unixUser || typeof unixUser !== 'string') {
      throw new CacheIsolationError('memcached_user_invalid', 'Memcached user is invalid');
    }

    const keyPrefix = `${unixUser}:`;
    const socketPath = `/run/memcached/${unixUser}.sock`;

    return Object.freeze({
      type: 'memcached',
      websiteId,
      unixUser,
      keyPrefix,
      socketPath,
      defaultHost: '127.0.0.1',
      defaultPort: 11211,
    });
  }

  return Object.freeze({
    applyRedisAcl,
    removeRedisAcl,
    inspectRedisAcl,
    generateMemcachedPolicy,
  });
}

export const cacheIsolationInternals = Object.freeze({
  REDIS_CLI_PATH,
  USERNAME_PATTERN,
  KEY_PREFIX_PATTERN,
});
