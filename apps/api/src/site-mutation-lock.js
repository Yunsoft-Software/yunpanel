import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(['application', 'website']);

export class SiteMutationLockError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'SiteMutationLockError';
    this.code = code;
    this.status = status;
  }
}

function safeType(value) {
  if (!TYPES.has(value)) {
    throw new SiteMutationLockError('site_mutation_lock_type_invalid', 'Site mutation lock resource type is invalid', 400);
  }
  return value;
}

function safeId(value, field = 'resourceId') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new SiteMutationLockError('site_mutation_lock_identity_invalid', `${field} must be a UUID`, 400);
  }
  return value.toLowerCase();
}

function parseRecord(value, expectedType, expectedId) {
  let record;
  try { record = JSON.parse(value); } catch { return null; }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.version !== 1
    || record.resourceType !== expectedType
    || record.resourceId !== expectedId
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || typeof record.token !== 'string' || !UUID.test(record.token)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    return null;
  }
  return record;
}

function processAlive(pid, signalProcess) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function createSiteMutationLock({
  root,
  pid = process.pid,
  now = Date.now,
  signalProcess = process.kill.bind(process),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 500 || root.includes('\0')
    || !Number.isSafeInteger(pid) || pid < 1
    || typeof now !== 'function' || typeof signalProcess !== 'function') {
    throw new SiteMutationLockError('site_mutation_lock_invalid', 'Site mutation lock configuration is invalid', 500);
  }

  async function withLock({ resourceType, resourceId } = {}, action) {
    const type = safeType(resourceType);
    const id = safeId(resourceId);
    if (typeof action !== 'function') {
      throw new SiteMutationLockError('site_mutation_lock_action_invalid', 'Site mutation lock action is invalid', 400);
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${type}-${id}.lock`);
    const token = randomUUID();
    const record = Object.freeze({
      version: 1,
      resourceType: type,
      resourceId: id,
      pid,
      token,
      createdAt: new Date(now()).toISOString(),
    });
    const value = `${JSON.stringify(record)}\n`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle = null;
      try {
        handle = await open(target, 'wx', 0o600);
        await writeFile(handle, value, { encoding: 'utf8' });
        await handle.close();
        handle = null;

        try {
          return await action();
        } finally {
          let current = null;
          try { current = parseRecord(await readFile(target, 'utf8'), type, id); } catch {}
          if (current?.token === token && current.pid === pid) {
            await rm(target, { force: true }).catch(() => {});
          }
        }
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error instanceof SiteMutationLockError) throw error;
        if (error?.code !== 'EEXIST') {
          throw new SiteMutationLockError('site_mutation_lock_failed', 'Site mutation lock could not be acquired', 503);
        }

        let existing;
        try {
          existing = parseRecord(await readFile(target, 'utf8'), type, id);
        } catch {
          throw new SiteMutationLockError('site_mutation_lock_unreadable', 'Existing site mutation lock requires inspection', 503);
        }
        if (!existing) {
          throw new SiteMutationLockError('site_mutation_lock_unreadable', 'Existing site mutation lock is invalid', 503);
        }
        if (processAlive(existing.pid, signalProcess)) {
          throw new SiteMutationLockError('site_mutation_locked', 'Another process is changing this site resource', 409);
        }
        await rm(target, { force: true });
      }
    }

    throw new SiteMutationLockError('site_mutation_lock_race', 'Site mutation lock changed while it was being acquired', 409);
  }

  function withApplicationLock(applicationId, action) {
    return withLock({ resourceType: 'application', resourceId: applicationId }, action);
  }

  function withWebsiteLock(websiteId, action) {
    return withLock({ resourceType: 'website', resourceId: websiteId }, action);
  }

  function withSiteLock({ applicationId = null, websiteId = null } = {}, action) {
    if (applicationId !== null) return withApplicationLock(applicationId, action);
    if (websiteId !== null) return withWebsiteLock(websiteId, action);
    throw new SiteMutationLockError('site_mutation_lock_identity_invalid', 'Application or Website identity is required', 400);
  }

  return Object.freeze({ withLock, withApplicationLock, withWebsiteLock, withSiteLock });
}

export const siteMutationLockInternals = Object.freeze({
  resourceTypes: Object.freeze([...TYPES]),
  parseRecord,
  processAlive,
});
