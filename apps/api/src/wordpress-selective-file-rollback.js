import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { filterSelectiveFileEntries, wordpressSelectiveTransferPolicy } from './wordpress-selective-transfer.js';

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_BYTES = wordpressSelectiveTransferPolicy.maxFileBytes;
const TERMINAL = new Set(['rolled_back', 'conflict']);

export class WordPressSelectiveFileRollbackError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WordPressSelectiveFileRollbackError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new WordPressSelectiveFileRollbackError(code, message, status);
}

function beneath(directory, name) {
  return `/proc/self/fd/${directory.fd}/${name}`;
}

function identity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function same(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

async function descend(directory, segments, owner = null) {
  let current = directory;
  try {
    for (const segment of segments) {
      const next = await open(beneath(current, segment), DIRECTORY);
      if (current !== directory) await current.close();
      current = next;
      if (owner !== null) {
        const directoryStat = await current.stat({ bigint: true });
        // Root-owned sticky ancestors such as /tmp cannot have the private
        // child renamed by the site UID. Untrusted ancestors can.
        if ((directoryStat.uid !== owner && directoryStat.uid !== 0n)
          || ((directoryStat.mode & 0o022n) !== 0n && (directoryStat.mode & 0o1000n) === 0n)) {
          fail('wordpress_selective_retention_unsafe', 'WordPress retention requires trusted containing directories');
        }
      }
    }
    return current;
  } catch (error) {
    if (current !== directory) await current.close();
    throw error;
  }
}

async function item(name) {
  try { return await lstat(name, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readRegular(name) {
  const listed = await item(name);
  if (!listed?.isFile() || listed.size > BigInt(MAX_BYTES)) return null;
  let file;
  try {
    file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const start = await file.stat({ bigint: true });
    if (!start.isFile() || !same(identity(start), identity(listed)) || start.size > BigInt(MAX_BYTES)) return null;
    const bytes = Buffer.alloc(Number(start.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const finish = await file.stat({ bigint: true });
    if (BigInt(read) !== start.size || start.size !== finish.size
      || start.mtimeNs !== finish.mtimeNs || start.ctimeNs !== finish.ctimeNs) return null;
    return { ...identity(start), sha256: digest(bytes.subarray(0, read)), uid: Number(start.uid), gid: Number(start.gid), mode: Number(start.mode & 0o777n) };
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(error.code)) return null;
    throw error;
  } finally {
    await file?.close();
  }
}

function matches(file, expected) {
  return same(file, expected) && file.sha256 === expected.sha256 && file.uid === expected.uid
    && file.gid === expected.gid && file.mode === expected.mode;
}

function artifactPath(storage, operation, role) {
  return beneath(storage, `${operation}.${role}`);
}

async function makeArtifact(name, bytes, permissions) {
  const file = await open(name, 'wx', 0o600);
  try {
    if (permissions) {
      await file.chown(permissions.uid, permissions.gid);
      await file.chmod(permissions.mode);
    }
    await file.writeFile(bytes);
    await file.sync();
    return identity(await file.stat({ bigint: true }));
  } finally {
    await file.close();
  }
}

async function save(location, receipt, phase, reason = null) {
  const next = { ...receipt, phase, reason };
  const temporary = artifactPath(location.storage, randomUUID(), 'receipt');
  await makeArtifact(temporary, JSON.stringify(next));
  await rename(temporary, location.receiptPath);
  await location.storage.sync();
  return next;
}

async function readReceipt(location, relativePath) {
  let contents;
  try { contents = await readFile(location.receiptPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let receipt;
  try { receipt = JSON.parse(contents); } catch {}
  if (receipt?.version !== 1 || receipt.relativePath !== relativePath || !ID.test(receipt.operation)
    || !receipt.root || !receipt.storage || !receipt.parent || !receipt.stage || !receipt.beforeSlot || !receipt.afterSlot
    || !['prepared', 'publish_pending', 'applied', 'compensating', 'rolled_back', 'conflict'].includes(receipt.phase)) {
    fail('wordpress_selective_receipt_invalid', 'WordPress selective file recovery receipt requires inspection');
  }
  if (!same(receipt.root, location.rootIdentity) || !same(receipt.storage, location.storageIdentity)
    || !same(receipt.parent, location.parentIdentity)) {
    fail('wordpress_selective_file_identity_changed', 'WordPress file or retention directory changed; inspect the recovery receipt');
  }
  return receipt;
}

function result(receipt, idempotent = false) {
  return Object.freeze({ status: receipt.phase, retentionId: receipt.operation, idempotent, ...(receipt.reason ? { reason: receipt.reason } : {}) });
}

async function finish(location, receipt, phase, reason = null) {
  return result(await save(location, receipt, phase, reason));
}

async function capture(location, slot) {
  // The destination is a private, fsynced regular placeholder. POSIX rename
  // refuses to move a concurrent directory over it. Captured objects stay private.
  try { await rename(location.target, slot); }
  catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
  await location.storage.sync();
  await location.parent.sync();
  return true;
}

async function publish(location, source) {
  // Linux link creates a new name only. It does not overwrite an SFTP rename
  // into the same destination and does not follow a captured symlink.
  try { await link(source, location.target); }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  await location.parent.sync();
  return true;
}

async function retained(slot, placeholder) {
  const entry = await item(slot);
  if (!entry) fail('wordpress_selective_retention_missing', 'WordPress selective file retention requires inspection');
  return same(identity(entry), placeholder) ? null : identity(entry);
}

async function restoreCaptured(location, slot, captured) {
  const live = await item(location.target);
  return live ? same(identity(live), captured) : publish(location, slot);
}

async function parentStillPinned(location) {
  let parent;
  try {
    parent = await descend(location.root, location.parentSegments);
    return same(identity(await parent.stat({ bigint: true })), location.parentIdentity);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ELOOP', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  } finally {
    await parent?.close();
  }
}

async function compensate(location, receipt) {
  const before = artifactPath(location.storage, receipt.operation, 'before');
  const after = artifactPath(location.storage, receipt.operation, 'after');
  const original = await retained(before, receipt.beforeSlot);
  if (!await parentStillPinned(location)) return finish(location, receipt, 'conflict', 'parent_directory_changed');

  if (receipt.phase === 'prepared') {
    if (original) {
      const restored = await restoreCaptured(location, before, original);
      if (!restored || !same(original, receipt.prior)) return finish(location, receipt, 'conflict', 'target_changed');
    }
    return finish(location, receipt, 'rolled_back');
  }

  if (receipt.prior && !same(receipt.prior, original)) return finish(location, receipt, 'conflict', 'original_not_verified');
  let captured = await retained(after, receipt.afterSlot);
  if (!captured) {
    if (receipt.phase === 'publish_pending' && !await item(location.target)) {
      if (!original) return finish(location, receipt, 'rolled_back');
      // A crash before the link and a concurrent deletion after it both leave
      // a vacant name. Recover availability without clobbering any occupant.
      // Keep all bytes and flag the ambiguous publication for operator review.
      const restored = await restoreCaptured(location, before, original);
      return finish(location, receipt, 'conflict', restored ? 'publication_interrupted' : 'target_changed');
    }
    const live = await readRegular(location.target);
    if (!matches(live, receipt.stage)) return finish(location, receipt, 'conflict', 'target_changed');
    if (receipt.phase !== 'compensating') receipt = await save(location, receipt, 'compensating');
    if (!await capture(location, after)) return finish(location, receipt, 'conflict', 'target_changed');
    captured = await retained(after, receipt.afterSlot);
  }

  if (!matches(await readRegular(after), receipt.stage)) {
    await restoreCaptured(location, after, captured);
    return finish(location, receipt, 'conflict', 'target_changed');
  }

  const restored = original ? await restoreCaptured(location, before, original) : await item(location.target) === null;
  if (!restored || !matches(await readRegular(after), receipt.stage)) return finish(location, receipt, 'conflict', 'target_changed');
  if (!await parentStillPinned(location)) return finish(location, receipt, 'conflict', 'parent_directory_changed');
  return finish(location, receipt, 'rolled_back');
}

// The caller serializes apply/rollback with the site's durable mutation lock.
// Supply one dedicated, panel-EUID-owned 0700 directory per transfer under a
// trusted parent outside the release. Keep its contents for operator recovery.
// This component handles regular files in existing directories on Linux.
export function createWordPressSelectiveFileRollback({ releaseRoot, expectedRoot, retentionDirectory, fileScopes = ['plugins', 'themes', 'mu-plugins'] } = {}) {
  if (process.platform !== 'linux') fail('wordpress_selective_file_platform_unsupported', 'Selective file recovery requires Linux', 503);
  if (![releaseRoot, retentionDirectory].every((name) => typeof name === 'string' && name !== '/' && path.isAbsolute(name)
    && path.normalize(name) === name && !name.endsWith('/') && !name.includes('\0'))
    || releaseRoot === retentionDirectory || releaseRoot.startsWith(`${retentionDirectory}/`) || retentionDirectory.startsWith(`${releaseRoot}/`)
    || !/^[0-9]+$/.test(expectedRoot?.device ?? '') || !/^[0-9]+$/.test(expectedRoot?.inode ?? '')) {
    fail('wordpress_selective_file_scope_invalid', 'Selective file recovery requires a pinned release and separate retention directory', 400);
  }
  const rootPin = { device: String(expectedRoot.device), inode: String(expectedRoot.inode) };

  async function withLocation(relativePath, action) {
    const selection = filterSelectiveFileEntries([relativePath], fileScopes);
    if (selection.includeUploads || selection.transferable.length !== 1) {
      fail('wordpress_selective_file_protected', 'File is outside this selective transfer scope');
    }
    const parentSegments = relativePath.split('/');
    const name = parentSegments.pop();
    const base = await open('/', DIRECTORY);
    let root;
    let parent;
    let storageParent;
    let storage;
    try {
      root = await descend(base, releaseRoot.slice(1).split('/'));
      const rootIdentity = identity(await root.stat({ bigint: true }));
      if (!same(rootIdentity, rootPin)) fail('wordpress_selective_file_identity_changed', 'WordPress release changed');
      parent = await descend(root, parentSegments);
      const parentStat = await parent.stat({ bigint: true });
      const storagePath = retentionDirectory.slice(1).split('/');
      const storageName = storagePath.pop();
      const owner = BigInt(process.geteuid());
      storageParent = await descend(base, storagePath, owner);
      storage = await open(beneath(storageParent, storageName), DIRECTORY);
      const parentTrust = await storageParent.stat({ bigint: true });
      const storageStat = await storage.stat({ bigint: true });
      if (storageStat.uid !== owner || (storageStat.mode & 0o777n) !== 0o700n || parentTrust.uid !== owner
        || (parentTrust.mode & 0o022n) !== 0n || storageStat.dev !== parentStat.dev || rootIdentity.device !== String(parentStat.dev)) {
        fail('wordpress_selective_retention_unsafe', 'WordPress retention must be private and on the release filesystem');
      }
      await storageParent.sync();
      return await action({ root, rootIdentity, parent, parentStat, parentIdentity: identity(parentStat), parentSegments, storage,
        storageIdentity: identity(storageStat), target: beneath(parent, name), receiptPath: beneath(storage, `${digest(relativePath)}.json`) });
    } catch (error) {
      if (['ENOENT', 'EISDIR', 'ELOOP', 'ENOTDIR', 'EXDEV'].includes(error.code)) {
        fail('wordpress_selective_file_location_unavailable', 'WordPress file or retention directory is unavailable');
      }
      throw error;
    } finally {
      for (const handle of new Set([storage, storageParent, parent, root, base])) await handle?.close();
    }
  }

  async function apply({ relativePath, expectedTargetSha256, content } = {}) {
    if ((expectedTargetSha256 !== null && !DIGEST.test(expectedTargetSha256 ?? '')) || !(content instanceof Uint8Array) || content.byteLength > MAX_BYTES) {
      fail('wordpress_selective_file_request_invalid', 'Selective file transfer requires an expected digest and bounded byte content', 400);
    }
    const bytes = Buffer.from(content);
    const sha256 = digest(bytes);
    return withLocation(relativePath, async (location) => {
      let receipt = await readReceipt(location, relativePath);
      if (receipt) {
        if (receipt.stage.sha256 !== sha256 || (receipt.prior?.sha256 ?? null) !== expectedTargetSha256) {
          fail('wordpress_selective_receipt_mismatch', 'WordPress selective file request differs from its recovery receipt');
        }
        if (TERMINAL.has(receipt.phase)) return result(receipt, true);
        if (receipt.phase === 'applied' && matches(await readRegular(location.target), receipt.stage)) return result(receipt, true);
        fail('wordpress_selective_recovery_required', 'WordPress selective file must be reconciled before another attempt');
      }

      const prior = expectedTargetSha256 === null ? null : await readRegular(location.target);
      if (prior ? prior.sha256 !== expectedTargetSha256 : expectedTargetSha256 !== null || await item(location.target)) {
        fail('wordpress_selective_file_stale', 'WordPress target file changed after preview');
      }
      const operation = randomUUID();
      const before = artifactPath(location.storage, operation, 'before');
      const after = artifactPath(location.storage, operation, 'after');
      const stage = artifactPath(location.storage, operation, 'stage');
      const permissions = prior ? { uid: prior.uid, gid: prior.gid, mode: prior.mode }
        : { uid: Number(location.parentStat.uid), gid: Number(location.parentStat.gid), mode: 0o644 };
      const staged = await makeArtifact(stage, bytes, permissions);
      const beforeSlot = await makeArtifact(before, '');
      const afterSlot = await makeArtifact(after, '');
      receipt = await save(location, { version: 1, relativePath, operation, root: location.rootIdentity, parent: location.parentIdentity,
        storage: location.storageIdentity, prior, stage: { ...staged, ...permissions, sha256 }, beforeSlot, afterSlot }, 'prepared');

      if (!await parentStillPinned(location)) return finish(location, receipt, 'conflict', 'parent_directory_changed');
      if (prior) {
        if (!await capture(location, before)) return finish(location, receipt, 'conflict', 'target_changed');
        if (!matches(await readRegular(before), prior)) {
          await restoreCaptured(location, before, await retained(before, beforeSlot));
          return finish(location, receipt, 'conflict', 'target_changed');
        }
      }
      receipt = await save(location, receipt, 'publish_pending');
      if (!await publish(location, stage) || !matches(await readRegular(location.target), receipt.stage)) {
        return finish(location, receipt, 'conflict', 'target_changed');
      }
      if (!await parentStillPinned(location)) return finish(location, receipt, 'conflict', 'parent_directory_changed');
      return finish(location, receipt, 'applied');
    });
  }

  async function rollback({ relativePath } = {}) {
    return withLocation(relativePath, async (location) => {
      const receipt = await readReceipt(location, relativePath);
      if (!receipt) fail('wordpress_selective_receipt_missing', 'No WordPress selective file recovery receipt exists', 404);
      return TERMINAL.has(receipt.phase) ? result(receipt, true) : compensate(location, receipt);
    });
  }

  return Object.freeze({ apply, rollback });
}
