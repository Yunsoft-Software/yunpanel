import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createWordPressSelectiveFileRollback } from './wordpress-selective-file-rollback.js';
import { filterSelectiveFileEntries, wordpressSelectiveTransferPolicy } from './wordpress-selective-transfer.js';

const ROOT = '/var/lib/yunpanel/recovery/wordpress-selective';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TEMP_RECEIPT = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MANIFEST = 'manifest.json';
const COMPENSATING = 'compensating';

export class WordPressSelectiveTransferJournalError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WordPressSelectiveTransferJournalError';
    this.code = code;
    this.status = status;
  }
}

function fail(reason, message, status) {
  throw new WordPressSelectiveTransferJournalError(`wordpress_selective_${reason}`, message, status);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
}

function absoluteDirectory(value) {
  return typeof value === 'string' && value !== '/' && path.isAbsolute(value) && path.normalize(value) === value
    && !value.endsWith('/') && !value.includes('\0');
}

function validateJob(serverId, jobId, payload) {
  if (!UUID.test(serverId ?? '') || !JOB.test(jobId ?? '') || payload?.actionId !== 'wp.toolkit'
    || payload.options?.action !== 'selective_transfer' || !UUID.test(payload.websiteId ?? '')
    || !UUID.test(payload.applicationId ?? '') || !UUID.test(payload.options.targetWebsiteId ?? '')
    || !UUID.test(payload.targetApplicationId ?? '') || payload.applicationId.toLowerCase() === payload.targetApplicationId.toLowerCase()
    || payload.websiteId.toLowerCase() === payload.options.targetWebsiteId.toLowerCase()
    || !Number.isSafeInteger(payload.targetWebsiteRevision) || payload.targetWebsiteRevision < 1
    || !SHA256.test(payload.previewDigest ?? '') || payload.secretRef !== null
    || !Array.isArray(payload.options.fileScopes) || payload.options.fileScopes.length === 0
    || payload.options.fileScopes.some((scope) => !['plugins', 'themes', 'mu-plugins'].includes(scope))) {
    fail('journal_job_invalid', 'WordPress selective transfer requires exact source and target job identities', 400);
  }
  return { serverId, jobId, payloadSha256: digest(canonical(payload)) };
}

function normalizeTarget(target) {
  const device = target?.expectedRoot?.device;
  const inode = target?.expectedRoot?.inode;
  if (!absoluteDirectory(target?.releaseRoot) || typeof device !== 'string' || !/^\d+$/.test(device)
    || typeof inode !== 'string' || !/^\d+$/.test(inode)) {
    fail('journal_target_invalid', 'WordPress selective transfer requires a pinned target release', 400);
  }
  return { releaseRoot: target.releaseRoot, expectedRoot: { device, inode } };
}

function normalizeFiles(relativePaths, fileScopes) {
  if (!Array.isArray(relativePaths) || !relativePaths.length || relativePaths.some((file) => typeof file !== 'string')) {
    fail('journal_files_invalid', 'WordPress selective transfer requires explicit file paths', 400);
  }
  const selected = filterSelectiveFileEntries(relativePaths, fileScopes).transferable;
  if (selected.length !== relativePaths.length) fail('journal_files_protected', 'A WordPress file is outside the approved transfer scope');
  return selected.map((entry) => entry.path).sort();
}

function beneath(directory, name) {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function openChild(parent, name, create) {
  const target = beneath(parent, name);
  if (create) {
    try {
      await mkdir(target, { mode: 0o700 });
      await parent.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return open(target, DIRECTORY);
}

async function directoryStatus(directory, { privateDirectory = false } = {}) {
  const stat = await directory.stat({ bigint: true });
  const owner = BigInt(process.geteuid());
  if (privateDirectory ? stat.uid !== owner || (stat.mode & 0o777n) !== 0o700n
    : (stat.uid !== 0n && stat.uid !== owner) || ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)) {
    fail('journal_directory_unsafe', 'WordPress selective transfer requires a private recovery directory');
  }
  return stat;
}

async function writeNewReceipt(directory, name, bytes = '') {
  const temporary = beneath(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, beneath(directory, name));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary);
  }
  await directory.sync();
}

async function readManifest(directory) {
  let file;
  try {
    file = await open(beneath(directory, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > wordpressSelectiveTransferPolicy.maxEntries * 530 + 2048) {
      fail('journal_invalid', 'WordPress selective transfer manifest requires inspection');
    }
    try { return JSON.parse(await file.readFile('utf8')); }
    catch { fail('journal_invalid', 'WordPress selective transfer manifest requires inspection'); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await file?.close();
  }
}

async function exists(directory, name) {
  try { await lstat(beneath(directory, name)); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertPreManifestDirectory(directory) {
  for (const name of await readdir(beneath(directory, '.'))) {
    const info = await lstat(beneath(directory, name));
    if (!TEMP_RECEIPT.test(name) || !info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600) {
      fail('journal_manifest_absent_with_artifacts', 'WordPress transfer artifacts without a manifest require inspection');
    }
  }
}

function fileMarker(relativePath) {
  return `started-${digest(relativePath)}`;
}

function verifiedManifest(value, identity, fileScopes) {
  if (value?.version !== 1 || value.serverId !== identity.serverId || value.jobId !== identity.jobId
    || value.payloadSha256 !== identity.payloadSha256) {
    fail('journal_identity_mismatch', 'WordPress selective transfer manifest does not match the queued job');
  }
  return { target: normalizeTarget(value.target), relativePaths: normalizeFiles(value.relativePaths, fileScopes) };
}

function filePrimitive(manifest, retentionDirectory, fileScopes) {
  return createWordPressSelectiveFileRollback({ ...manifest.target, retentionDirectory, fileScopes });
}

async function compensate(directory, operation, relativePaths) {
  await writeNewReceipt(directory, COMPENSATING);
  const conflicts = [];
  let filesRolledBack = 0;
  let unchangedFiles = 0;
  for (const relativePath of relativePaths.toReversed()) {
    if (!await exists(directory, fileMarker(relativePath))) {
      unchangedFiles += 1;
      continue;
    }
    try {
      const outcome = await operation.rollback({ relativePath });
      if (outcome.status === 'rolled_back') filesRolledBack += 1;
      else conflicts.push({ relativePath, reason: outcome.reason, retentionId: outcome.retentionId });
    } catch (error) {
      // The file primitive fsyncs its own receipt before any live rename/link.
      if (error.code === 'wordpress_selective_receipt_missing') unchangedFiles += 1;
      else conflicts.push({ relativePath, reason: 'file_recovery_unverified' });
    }
  }
  return Object.freeze({ status: conflicts.length ? 'conflict' : 'rolled_back', filesRolledBack, unchangedFiles, conflicts });
}

// The caller holds the durable locks for both Applications around batch work.
// This private journal never exposes its retention paths to a website UID.
export function createWordPressSelectiveTransferJournal({ root = ROOT } = {}) {
  if (!absoluteDirectory(root)) fail('journal_root_invalid', 'WordPress selective transfer journal root is invalid', 400);

  async function withDirectory(identity, create, action) {
    if (process.platform !== 'linux') fail('journal_platform_unsupported', 'WordPress selective transfer journal requires Linux', 503);
    const jobDirectory = digest(canonical([identity.serverId, identity.jobId]));
    let current = await open('/', DIRECTORY);
    try {
      for (const segment of [...root.slice(1).split('/'), jobDirectory]) {
        let next;
        try { next = await openChild(current, segment, create); }
        catch (error) {
          if (!create && error.code === 'ENOENT') return null;
          throw error;
        }
        await current.close();
        current = next;
        await directoryStatus(current, { privateDirectory: segment === jobDirectory });
      }
      return await action(current, path.join(root, jobDirectory));
    } finally {
      await current.close();
    }
  }

  async function prepare({ serverId, jobId, payload, target, relativePaths } = {}) {
    const identity = validateJob(serverId, jobId, payload);
    const pinnedTarget = normalizeTarget(target);
    const fileScopes = [...payload.options.fileScopes];
    const paths = normalizeFiles(relativePaths, fileScopes);
    if (root === pinnedTarget.releaseRoot || root.startsWith(`${pinnedTarget.releaseRoot}/`)) {
      fail('journal_directory_unsafe', 'WordPress selective transfer recovery must be outside the release');
    }
    const manifest = { version: 1, ...identity, target: pinnedTarget, relativePaths: paths };
    await withDirectory(identity, true, async (directory, retentionDirectory) => {
      const stat = await directoryStatus(directory, { privateDirectory: true });
      const targetStat = await lstat(pinnedTarget.releaseRoot, { bigint: true });
      if (!targetStat.isDirectory() || String(stat.dev) !== pinnedTarget.expectedRoot.device
        || String(targetStat.dev) !== pinnedTarget.expectedRoot.device || String(targetStat.ino) !== pinnedTarget.expectedRoot.inode) {
        fail('journal_target_changed', 'WordPress selective transfer target must share the pinned recovery filesystem');
      }
      filePrimitive(manifest, retentionDirectory, fileScopes);
      await writeNewReceipt(directory, MANIFEST, canonical(manifest));
      if (canonical(await readManifest(directory)) !== canonical(manifest)) {
        fail('journal_identity_mismatch', 'Existing WordPress selective transfer manifest differs from the approved job');
      }
      if (await exists(directory, COMPENSATING)) fail('journal_compensating', 'WordPress selective transfer has begun rollback');
    });

    async function withOperation(action) {
      const result = await withDirectory(identity, false, async (directory, retentionDirectory) => {
        if (canonical(await readManifest(directory)) !== canonical(manifest)) {
          fail('journal_identity_mismatch', 'WordPress selective transfer manifest changed');
        }
        return action(directory, filePrimitive(manifest, retentionDirectory, fileScopes));
      });
      if (!result) fail('journal_missing', 'WordPress selective transfer manifest is unavailable');
      return result;
    }

    return Object.freeze({
      async apply(input) {
        if (!paths.includes(input?.relativePath)) fail('journal_path_unapproved', 'WordPress file is outside the approved transfer manifest');
        return withOperation(async (directory, operation) => {
          if (await exists(directory, COMPENSATING)) fail('journal_compensating', 'WordPress selective transfer has begun rollback');
          await writeNewReceipt(directory, fileMarker(input.relativePath));
          return operation.apply(input);
        });
      },
      rollback: () => withOperation((directory, operation) => compensate(directory, operation, paths)),
    });
  }

  async function rollbackInterrupted({ serverId, jobId, payload, verifyTarget } = {}) {
    const identity = validateJob(serverId, jobId, payload);
    async function requireCurrentTarget(target) {
      if (typeof verifyTarget !== 'function' || await verifyTarget(target) !== true) {
        fail('journal_target_changed', 'Current WordPress target could not be matched to the approved release');
      }
    }
    const recovered = await withDirectory(identity, false, async (directory, retentionDirectory) => {
      const value = await readManifest(directory);
      if (!value) {
        await assertPreManifestDirectory(directory);
        return null;
      }
      const fileScopes = [...payload.options.fileScopes];
      const manifest = verifiedManifest(value, identity, fileScopes);
      await requireCurrentTarget(manifest.target);
      return compensate(directory, filePrimitive(manifest, retentionDirectory, fileScopes), manifest.relativePaths);
    });
    if (recovered) return recovered;
    // The immutable manifest is synced before any file marker or live capture.
    // Its absence in trusted storage proves the worker stopped before mutation.
    await requireCurrentTarget(null);
    return Object.freeze({ status: 'rolled_back', filesRolledBack: 0, unchangedFiles: 0, conflicts: [] });
  }

  return Object.freeze({ prepare, rollbackInterrupted });
}
