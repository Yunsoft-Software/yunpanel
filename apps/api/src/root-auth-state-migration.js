import { chown, lstat } from 'node:fs/promises';
import path from 'node:path';

const PACKAGED_CONTROL_PLANE_ROOT = '/var/lib/yunpanel/control-plane';
const SIDECAR_SUFFIXES = Object.freeze(['', '-wal', '-shm']);

export class RootAuthStateMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RootAuthStateMigrationError';
    this.code = code;
  }
}

function withinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function maybeStat(candidate, lstatFn) {
  try { return await lstatFn(candidate); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertPrivateDirectory(metadata) {
  if (!metadata?.isDirectory?.() || metadata.isSymbolicLink?.() || (metadata.mode & 0o077) !== 0) {
    throw new RootAuthStateMigrationError('unsafe_auth_state_directory', 'Auth state directory must be a private non-symlink directory');
  }
}

function assertPrivateFile(metadata, allowedOwners) {
  if (!metadata?.isFile?.() || metadata.isSymbolicLink?.() || (metadata.mode & 0o077) !== 0 || !allowedOwners.has(metadata.uid)) {
    throw new RootAuthStateMigrationError('unsafe_auth_state_file', 'Auth state file must be private, regular and owned by the trusted state owner or root');
  }
}

export async function prepareRootAuthStateOwnership({
  filePath,
  processUid = process.getuid?.(),
  allowedRoot = PACKAGED_CONTROL_PLANE_ROOT,
  lstatFn = lstat,
  chownFn = chown,
} = {}) {
  if (processUid !== 0 || filePath === ':memory:') return Object.freeze({ migrated: false, files: 0 });
  if (typeof filePath !== 'string' || !filePath || typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
    throw new RootAuthStateMigrationError('invalid_auth_state_path', 'Auth state migration path is invalid');
  }
  const root = path.resolve(allowedRoot);
  const databasePath = path.resolve(filePath);
  const directory = path.dirname(databasePath);
  if (!withinRoot(databasePath, root)) return Object.freeze({ migrated: false, files: 0 });
  if (directory === root) {
    throw new RootAuthStateMigrationError('auth_state_directory_too_broad', 'Auth database must use a private child directory of the control-plane state root');
  }

  const directoryMetadata = await maybeStat(directory, lstatFn);
  if (!directoryMetadata) return Object.freeze({ migrated: false, files: 0 });
  assertPrivateDirectory(directoryMetadata);
  const trustedOwners = new Set([0, directoryMetadata.uid]);
  const existing = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const candidate = `${databasePath}${suffix}`;
    const metadata = await maybeStat(candidate, lstatFn);
    if (!metadata) continue;
    assertPrivateFile(metadata, trustedOwners);
    existing.push({ candidate, metadata });
  }

  let changedFiles = 0;
  for (const entry of existing) {
    if (entry.metadata.uid === 0) continue;
    await chownFn(entry.candidate, 0, 0);
    changedFiles += 1;
  }
  if (directoryMetadata.uid !== 0) await chownFn(directory, 0, 0);
  return Object.freeze({ migrated: directoryMetadata.uid !== 0 || changedFiles > 0, files: changedFiles });
}

export const rootAuthStateMigrationInternals = Object.freeze({
  packagedControlPlaneRoot: PACKAGED_CONTROL_PLANE_ROOT,
  sidecarSuffixes: SIDECAR_SUFFIXES,
  withinRoot,
  assertPrivateDirectory,
  assertPrivateFile,
});
