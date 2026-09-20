import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RESTIC_PATHS = Object.freeze(['/usr/bin/restic', '/usr/local/bin/restic', '/bin/restic']);
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{8,64}$/i;
const DEFAULT_TIMEOUT = 60 * 60 * 1000; // 1 hour

export class ResticError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ResticError';
    this.code = code;
    this.status = status;
  }
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string' || repository.trim().length < 1) {
    throw new ResticError('restic_repository_invalid', 'Restic repository path or target is required');
  }
  return repository.trim();
}

function normalizePassword(password) {
  if (typeof password !== 'string' || password.length < 1) {
    throw new ResticError('restic_password_invalid', 'Restic repository password is required');
  }
  return password;
}

function normalizeSnapshotId(snapshotId) {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ResticError('restic_snapshot_id_invalid', 'Restic snapshot ID is invalid');
  }
  return snapshotId;
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length < 1)) {
    throw new ResticError('restic_argument_invalid', `${field} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

async function findResticBinary(customPath, accessFn) {
  if (customPath) {
    try {
      await accessFn(customPath);
      return customPath;
    } catch {
      return null;
    }
  }
  for (const candidate of RESTIC_PATHS) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue search in fixed allowlist.
    }
  }
  return null;
}

function mapResticError(error, context = '') {
  if (error instanceof ResticError) return error;
  const stderr = (error?.stderr || '').toString();
  const stdout = (error?.stdout || '').toString();
  const raw = `${stderr}\n${stdout}`.trim() || error?.message || '';
  const lower = raw.toLowerCase();

  if (lower.includes('is already locked') || lower.includes('unable to create lock')) {
    return new ResticError('restic_repo_locked', `Restic repository is locked: ${stderr.trim() || raw}`, 409);
  }
  if (lower.includes('wrong password') || lower.includes('ciphertext verification failed') || lower.includes('keys do not match')) {
    return new ResticError('restic_password_invalid', 'Restic repository password is incorrect', 401);
  }
  if (lower.includes('repository does not exist') || lower.includes('is there a repository at the following location') || lower.includes('config file not found')) {
    return new ResticError('restic_repo_not_initialized', 'Restic repository is not initialized', 404);
  }
  if (lower.includes('config file already exists') || lower.includes('repository already initialized')) {
    return new ResticError('restic_repo_already_initialized', 'Restic repository is already initialized', 409);
  }
  if (lower.includes('no snapshot found') || lower.includes('specified snapshot does not exist')) {
    return new ResticError('restic_snapshot_not_found', 'Restic snapshot was not found', 404);
  }
  return new ResticError('restic_command_failed', `Restic command failed (${context}): ${stderr.trim() || raw}`, 500);
}

function defaultRunCommand(file, args, { env = {}, timeout = DEFAULT_TIMEOUT } = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin:/usr/local/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      ...env,
    },
    windowsHide: true,
  });
}

function parseJsonLines(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const objects = [];
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      // Non-JSON progress line, ignore
    }
  }
  return objects;
}

export function createResticManager({
  resticPath = null,
  accessFn = access,
  runCommand = defaultRunCommand,
  now = () => Date.now(),
} = {}) {
  async function requireBinary() {
    const binary = await findResticBinary(resticPath, accessFn);
    if (!binary) {
      throw new ResticError('restic_binary_missing', 'Restic executable not found in allowlisted paths', 503);
    }
    return binary;
  }

  async function execRestic(args, { repository, password, extraEnv = {}, timeout = DEFAULT_TIMEOUT, context = 'exec' } = {}) {
    const binary = await requireBinary();
    const env = {
      RESTIC_REPOSITORY: normalizeRepository(repository),
      RESTIC_PASSWORD: normalizePassword(password),
      ...extraEnv,
    };
    try {
      return await runCommand(binary, args, { env, timeout });
    } catch (error) {
      throw mapResticError(error, context);
    }
  }

  async function init({ repository, password }) {
    const context = 'init';
    const result = await execRestic(['init', '--json'], { repository, password, context });
    let data = {};
    try {
      data = JSON.parse(result.stdout.trim());
    } catch {
      data = { message: result.stdout.trim() };
    }
    return Object.freeze({
      repository: normalizeRepository(repository),
      id: data.id ?? null,
      initializedAt: new Date(now()).toISOString(),
    });
  }

  async function check({ repository, password, readDataSubset = null }) {
    const context = 'check';
    const args = ['check', '--json'];
    if (readDataSubset !== null) {
      if (typeof readDataSubset !== 'string' || readDataSubset.trim().length < 1) {
        throw new ResticError('restic_argument_invalid', 'readDataSubset must be a non-empty string');
      }
      args.push(`--read-data-subset=${readDataSubset.trim()}`);
    }
    const result = await execRestic(args, { repository, password, context });
    return Object.freeze({
      healthy: true,
      output: result.stdout.trim(),
      checkedAt: new Date(now()).toISOString(),
    });
  }

  async function unlock({ repository, password, removeAll = false }) {
    const context = 'unlock';
    const args = ['unlock'];
    if (removeAll) args.push('--remove-all');
    await execRestic(args, { repository, password, context });
    return Object.freeze({
      unlocked: true,
      unlockedAt: new Date(now()).toISOString(),
    });
  }

  async function createSnapshot({
    repository,
    password,
    paths,
    tags = [],
    excludes = [],
    parentSnapshotId = null,
  }) {
    const context = 'backup';
    const normalizedPaths = normalizeStringArray(paths, 'paths');
    if (normalizedPaths.length < 1) {
      throw new ResticError('restic_argument_invalid', 'At least one path must be specified for backup');
    }
    const normalizedTags = normalizeStringArray(tags, 'tags');
    const normalizedExcludes = normalizeStringArray(excludes, 'excludes');

    const args = ['backup', '--json'];
    for (const tag of normalizedTags) {
      args.push('--tag', tag);
    }
    for (const exclude of normalizedExcludes) {
      args.push('--exclude', exclude);
    }
    if (parentSnapshotId !== null) {
      args.push('--parent', normalizeSnapshotId(parentSnapshotId));
    }
    args.push(...normalizedPaths);

    const result = await execRestic(args, { repository, password, context });
    const jsonObjects = parseJsonLines(result.stdout);
    const summary = jsonObjects.find((item) => item.message_type === 'summary') ?? null;

    if (!summary || !summary.snapshot_id) {
      throw new ResticError('restic_snapshot_failed', 'Restic backup completed but no summary was produced', 500);
    }

    return Object.freeze({
      snapshotId: summary.snapshot_id,
      shortId: summary.snapshot_id.slice(0, 8),
      filesNew: summary.files_new ?? 0,
      filesChanged: summary.files_changed ?? 0,
      filesUnmodified: summary.files_unmodified ?? 0,
      dirsNew: summary.dirs_new ?? 0,
      dirsChanged: summary.dirs_changed ?? 0,
      dirsUnmodified: summary.dirs_unmodified ?? 0,
      bytesAdded: summary.data_added ?? 0,
      totalFiles: summary.total_files_processed ?? 0,
      totalBytes: summary.total_bytes_processed ?? 0,
      durationSeconds: summary.total_duration ?? 0,
      createdAt: new Date(now()).toISOString(),
    });
  }

  async function listSnapshots({ repository, password, tags = [], path: filterPath = null }) {
    const context = 'snapshots';
    const normalizedTags = normalizeStringArray(tags, 'tags');
    const args = ['snapshots', '--json'];
    for (const tag of normalizedTags) {
      args.push('--tag', tag);
    }
    if (filterPath !== null) {
      if (typeof filterPath !== 'string' || filterPath.trim().length < 1) {
        throw new ResticError('restic_argument_invalid', 'path must be a non-empty string');
      }
      args.push('--path', filterPath.trim());
    }

    const result = await execRestic(args, { repository, password, context });
    let rawSnapshots = [];
    try {
      rawSnapshots = JSON.parse(result.stdout.trim() || '[]');
    } catch {
      throw new ResticError('restic_command_failed', 'Failed to parse snapshots JSON output', 500);
    }

    const snapshots = rawSnapshots.map((item) => Object.freeze({
      id: item.id,
      shortId: item.short_id ?? item.id.slice(0, 8),
      time: item.time,
      paths: Object.freeze(item.paths ?? []),
      tags: Object.freeze(item.tags ?? []),
      hostname: item.hostname ?? null,
      username: item.username ?? null,
      summary: item.summary ? Object.freeze({ ...item.summary }) : null,
    }));

    return Object.freeze(snapshots);
  }

  async function forget({
    repository,
    password,
    policy = {},
    prune = false,
  }) {
    const context = 'forget';
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new ResticError('restic_argument_invalid', 'Policy must be an object');
    }
    const args = ['forget', '--json'];
    if (Number.isSafeInteger(policy.keepLast) && policy.keepLast > 0) args.push('--keep-last', String(policy.keepLast));
    if (Number.isSafeInteger(policy.keepHourly) && policy.keepHourly > 0) args.push('--keep-hourly', String(policy.keepHourly));
    if (Number.isSafeInteger(policy.keepDaily) && policy.keepDaily > 0) args.push('--keep-daily', String(policy.keepDaily));
    if (Number.isSafeInteger(policy.keepWeekly) && policy.keepWeekly > 0) args.push('--keep-weekly', String(policy.keepWeekly));
    if (Number.isSafeInteger(policy.keepMonthly) && policy.keepMonthly > 0) args.push('--keep-monthly', String(policy.keepMonthly));
    if (Number.isSafeInteger(policy.keepYearly) && policy.keepYearly > 0) args.push('--keep-yearly', String(policy.keepYearly));
    if (typeof policy.keepWithin === 'string' && policy.keepWithin.trim().length > 0) args.push('--keep-within', policy.keepWithin.trim());

    if (Array.isArray(policy.keepTags)) {
      for (const tag of normalizeStringArray(policy.keepTags, 'keepTags')) {
        args.push('--keep-tag', tag);
      }
    }
    if (prune) args.push('--prune');

    const result = await execRestic(args, { repository, password, context });
    let forgetResult = [];
    try {
      forgetResult = JSON.parse(result.stdout.trim() || '[]');
    } catch {
      // In older restic or when output is mixed, handle fallback
    }

    const keptSnapshots = [];
    const removedSnapshots = [];
    if (Array.isArray(forgetResult)) {
      for (const group of forgetResult) {
        if (Array.isArray(group.keep)) {
          for (const s of group.keep) keptSnapshots.push(s.id);
        }
        if (Array.isArray(group.remove)) {
          for (const s of group.remove) removedSnapshots.push(s.id);
        }
      }
    }

    return Object.freeze({
      keptSnapshots: Object.freeze([...new Set(keptSnapshots)]),
      removedSnapshots: Object.freeze([...new Set(removedSnapshots)]),
      pruned: prune,
      executedAt: new Date(now()).toISOString(),
    });
  }

  async function prune({ repository, password }) {
    const context = 'prune';
    const result = await execRestic(['prune', '--json'], { repository, password, context });
    const jsonObjects = parseJsonLines(result.stdout);
    const summary = jsonObjects.find((item) => item.message_type === 'summary' || item.bytes_freed !== undefined) ?? null;

    return Object.freeze({
      bytesFreed: summary?.bytes_freed ?? 0,
      packsRemoved: summary?.packs_removed ?? summary?.files_deleted ?? 0,
      prunedAt: new Date(now()).toISOString(),
    });
  }

  async function restore({
    repository,
    password,
    snapshotId,
    targetDirectory,
    include = [],
    exclude = [],
  }) {
    const context = 'restore';
    const id = normalizeSnapshotId(snapshotId);
    if (typeof targetDirectory !== 'string' || !path.isAbsolute(targetDirectory)) {
      throw new ResticError('restic_argument_invalid', 'targetDirectory must be an absolute path');
    }
    const normalizedIncludes = normalizeStringArray(include, 'include');
    const normalizedExcludes = normalizeStringArray(exclude, 'exclude');

    const args = ['restore', id, '--target', targetDirectory];
    for (const inc of normalizedIncludes) {
      args.push('--include', inc);
    }
    for (const exc of normalizedExcludes) {
      args.push('--exclude', exc);
    }

    await execRestic(args, { repository, password, context });

    return Object.freeze({
      snapshotId: id,
      targetDirectory: path.resolve(targetDirectory),
      restoredAt: new Date(now()).toISOString(),
    });
  }

  async function stats({ repository, password, mode = 'restore-size' }) {
    const context = 'stats';
    const validModes = new Set(['restore-size', 'files-by-contents', 'raw-data', 'blobs-per-file']);
    if (!validModes.has(mode)) {
      throw new ResticError('restic_argument_invalid', `Invalid stats mode: ${mode}`);
    }
    const result = await execRestic(['stats', '--mode', mode, '--json'], { repository, password, context });
    let data = {};
    try {
      data = JSON.parse(result.stdout.trim());
    } catch {
      throw new ResticError('restic_command_failed', 'Failed to parse stats JSON output', 500);
    }
    return Object.freeze({
      totalBytes: data.total_size ?? 0,
      totalFiles: data.total_file_count ?? 0,
      mode,
    });
  }

  return Object.freeze({
    init,
    check,
    unlock,
    createSnapshot,
    listSnapshots,
    forget,
    prune,
    restore,
    stats,
  });
}

export const resticManagerInternals = Object.freeze({
  RESTIC_PATHS,
  findResticBinary,
  mapResticError,
  normalizeRepository,
  normalizePassword,
  normalizeSnapshotId,
  parseJsonLines,
});
