import { normalizePassengerReleaseResult } from './passenger-release-job-result.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizePassengerNodeDeploySpec, normalizePassengerNodeRollbackSpec } from '@yunpanel/shared';
import { OPERATIONS } from '@yunpanel/protocol';
import { createProcessStoreLock } from './process-store-lock.js';
import { createWebsiteResourceBackupCodec } from './website-resource-backup-codec.js';

const phases = new Set(['preflight', 'captured', 'preparing', 'prepared', 'publishing', 'published', 'reconciling', 'reconciled', 'compensating', 'compensated', 'rejected', 'blocked']);
const transitions = {
  preflight: new Set(['captured','rejected','blocked']), captured: new Set(['preparing','compensating','blocked']),
  preparing: new Set(['prepared','compensating','blocked']), prepared: new Set(['publishing','compensating','blocked']),
  publishing: new Set(['publishing','published','compensating','blocked']), published: new Set(['reconciling','reconciled','blocked']),
  reconciling: new Set(['reconciled','blocked']), reconciled: new Set(['reconciled','blocked']),
  compensating: new Set(['compensated','blocked']), compensated: new Set(['compensating']), rejected: new Set(['rejected']),
  blocked: new Set(['compensating','reconciled','blocked']),
};
const operations = new Set([OPERATIONS.APP_NODE_PASSENGER_DEPLOY, OPERATIONS.APP_NODE_PASSENGER_ROLLBACK]);
const fields = new Set(['version', 'serverId', 'jobId', 'websiteId', 'applicationId', 'operation', 'payloadSha256', 'phase', 'protectedState', 'result', 'problemCode', 'updatedAt']);
const resultFields = new Set(['applicationId', 'websiteId', 'unixUser', 'operationId', 'deploymentId', 'releaseId', 'previousReleaseId', 'commitSha',
  'gitTarget', 'environmentRevision', 'configurationRevision', 'bindingRevision', 'domains', 'runtimeAdapter', 'port', 'healthPath', 'healthy', 'active', 'published']);
const fail = () => Object.assign(new Error('Passenger release recovery evidence requires inspection'), { code: 'passenger_release_phase_invalid', status: 503 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function passengerReleasePhaseIdentity(operation, payload, execution) {
  payload = operation === OPERATIONS.APP_NODE_PASSENGER_DEPLOY ? normalizePassengerNodeDeploySpec(payload) : normalizePassengerNodeRollbackSpec(payload);
  if (!operations.has(operation) || execution?.resourceType !== 'application' || execution.resourceId !== payload.applicationId
    || (operation === OPERATIONS.APP_NODE_PASSENGER_DEPLOY && payload.deploymentId !== execution.jobId)) throw fail();
  return Object.freeze({ serverId: assertUuid(execution.serverId, 'serverId'), jobId: assertUuid(execution.jobId, 'jobId'),
    websiteId: assertUuid(payload.websiteId, 'websiteId'), applicationId: assertUuid(payload.applicationId, 'applicationId'),
    operation, payloadSha256: digest(payload) });
}

export function createPassengerReleasePhaseStore({ root = '/var/lib/yunpanel/recovery/passenger-release',
  codec = createWebsiteResourceBackupCodec(), ownerUid = process.getuid?.() ?? 0 } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !codec?.configured || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') throw fail();
  function file(identity) {
    for (const key of ['serverId', 'jobId', 'websiteId', 'applicationId']) assertUuid(identity[key], key);
    if (!operations.has(identity.operation) || !/^[a-f0-9]{64}$/.test(identity.payloadSha256)) throw fail();
    return path.join(root, identity.serverId, `${identity.jobId}.json`);
  }
  async function directory(target, create = false) {
    if (create) await mkdir(target, { recursive: true, mode: 0o700 });
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o700 || await realpath(target) !== target) throw fail();
  }
  function validate(identity, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || !phases.has(record.phase)
      || Object.keys(record).some(key => !fields.has(key))
      || Object.keys(identity).some(key => record[key] !== identity[key]) || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
      || (record.protectedState !== null && typeof record.protectedState !== 'string')
      || (record.problemCode !== null && (typeof record.problemCode !== 'string' || !/^[a-z0-9_]{1,120}$/.test(record.problemCode)))
      || (record.result !== null && (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)
        || Object.keys(record.result).some(key => !resultFields.has(key))))) throw fail();
    if (record.result !== null) normalizePassengerReleaseResult(record.result, { identity });
    return record;
  }
  async function read(identity) {
    const target = file(identity);
    try {
      await directory(root); await directory(path.dirname(target));
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o600 || stat.size > 4 * 1024 * 1024) throw fail();
      return validate(identity, JSON.parse(await readFile(target, 'utf8')));
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail(); }
  }
  async function save(identity, update, { expectedPhase = null } = {}) {
    const target = file(identity);
    await directory(root, true); await directory(path.dirname(target), true);
    return createProcessStoreLock({ filePath: target }).withLock(async () => {
      const previous = await read(identity);
      if (expectedPhase !== null && previous?.phase !== expectedPhase) throw fail();
      const record = validate(identity, { version: 1, ...identity, phase: 'preflight', protectedState: null,
        result: null, problemCode: null, ...previous, ...update, updatedAt: new Date().toISOString() });
      if (previous ? expectedPhase !== previous.phase || !transitions[previous.phase]?.has(record.phase) : record.phase !== 'preflight') throw fail();
      const serialized = JSON.stringify(record); if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw fail();
      const temporary = `${target}.${process.pid}.tmp`;
      let handle = null, created = false;
      try { handle = await open(temporary, 'wx', 0o600); created = true; await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null; await rename(temporary, target);
        const directoryHandle = await open(path.dirname(target), 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } }
      finally { if (handle) await handle.close().catch(() => {}); if (created) await rm(temporary, { force: true }).catch(() => {}); }
      return record;
    });
  }
  function protect(identity, state) { return codec.encode({ websiteId: identity.websiteId, resourceId: identity.jobId, kind: 'environment' }, state); }
  function unprotect(identity, record) {
    validate(identity, record);
    return codec.decode({ websiteId: identity.websiteId, resourceId: identity.jobId, kind: 'environment' }, record.protectedState);
  }
  return Object.freeze({ read, save, protect, unprotect, file });
}
