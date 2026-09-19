import { createHash } from 'node:crypto';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cronTaskFileName,
  renderCronTaskFile,
} from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const CRON_DIRECTORY = '/etc/cron.d';
const SYSTEMCTL = '/usr/bin/systemctl';
const MANAGED_MARKER = '# Managed by YunPanel. Manual edits are overwritten.\n';
const MAX_BYTES = 16 * 1024;

export class WebsiteCronManagerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteCronManagerError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function desiredTask(input) {
  let content;
  let fileName;
  try {
    fileName = cronTaskFileName(input?.taskId);
    content = renderCronTaskFile(input);
  } catch (error) {
    throw new WebsiteCronManagerError(
      'website_cron_task_invalid',
      error?.message ?? 'Website cron task is invalid',
      400,
    );
  }
  return Object.freeze({
    taskId: input.taskId,
    fileName,
    filePath: path.posix.join(CRON_DIRECTORY, fileName),
    content,
    contentSha256: sha256(content),
  });
}

function managedBytes(value) {
  if (!Buffer.isBuffer(value) || value.length > MAX_BYTES) {
    throw new WebsiteCronManagerError(
      'website_cron_file_invalid',
      'Managed cron task file is invalid',
      409,
    );
  }
  const text = value.toString('utf8');
  if (!text.startsWith(MANAGED_MARKER)) {
    throw new WebsiteCronManagerError(
      'website_cron_file_conflict',
      'Cron task path contains a file not owned by YunPanel',
      409,
    );
  }
  return text;
}

function safeStat(info) {
  if (!info || typeof info.isFile !== 'function' || !info.isFile()
    || info.isSymbolicLink?.() === true
    || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o777) !== 0o644
    || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_BYTES) {
    throw new WebsiteCronManagerError(
      'website_cron_file_ownership_invalid',
      'Managed cron task file ownership or mode is invalid',
      409,
    );
  }
}

export function createWebsiteCronManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 32 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  lstatFn = lstat,
  readFileFn = readFile,
  mkdirFn = mkdir,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  chmodFn = chmod,
  chownFn = chown,
} = {}) {
  if ([run, lstatFn, readFileFn, mkdirFn, writeFileFn, renameFn, rmFn, chmodFn, chownFn]
    .some((dependency) => typeof dependency !== 'function')) {
    throw new WebsiteCronManagerError(
      'website_cron_dependencies_invalid',
      'Website cron manager dependencies are unavailable',
    );
  }

  async function cronServiceActive() {
    try {
      const result = await run(SYSTEMCTL, ['is-active', 'cron'], { timeout: 10_000 });
      return String(result?.stdout ?? result ?? '').trim() === 'active';
    } catch {
      return false;
    }
  }

  async function readManagedFile(filePath, { allowMissing = true } = {}) {
    let info;
    try { info = await lstatFn(filePath); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      throw new WebsiteCronManagerError(
        'website_cron_file_inspection_failed',
        'Managed cron task file could not be inspected',
      );
    }
    safeStat(info);
    let bytes;
    try { bytes = await readFileFn(filePath); }
    catch {
      throw new WebsiteCronManagerError(
        'website_cron_file_inspection_failed',
        'Managed cron task file could not be read',
      );
    }
    const content = managedBytes(bytes);
    return Object.freeze({
      content,
      contentSha256: sha256(content),
      bytes: Buffer.byteLength(content),
    });
  }

  async function inspect(input) {
    const desired = desiredTask(input);
    const [current, serviceActive] = await Promise.all([
      readManagedFile(desired.filePath),
      cronServiceActive(),
    ]);
    return Object.freeze({
      taskId: desired.taskId,
      fileName: desired.fileName,
      exists: current !== null,
      exact: current?.contentSha256 === desired.contentSha256,
      desiredSha256: desired.contentSha256,
      currentSha256: current?.contentSha256 ?? null,
      cronServiceActive: serviceActive,
      ready: current?.contentSha256 === desired.contentSha256 && serviceActive,
      sideEffects: false,
    });
  }

  async function atomicWrite(filePath, content) {
    const temporary = `${filePath}.${process.pid}.tmp`;
    await mkdirFn(CRON_DIRECTORY, { recursive: true, mode: 0o755 });
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await chownFn(temporary, 0, 0);
      await chmodFn(temporary, 0o644);
      await renameFn(temporary, filePath);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
  }

  async function restore(filePath, snapshot) {
    if (snapshot === null) {
      await rmFn(filePath, { force: true });
      return;
    }
    await atomicWrite(filePath, snapshot.content);
  }

  async function apply(input) {
    const desired = desiredTask(input);
    const before = await readManagedFile(desired.filePath);
    if (before?.contentSha256 === desired.contentSha256) {
      const current = await inspect(input);
      if (!current.cronServiceActive) {
        throw new WebsiteCronManagerError(
          'website_cron_service_unavailable',
          'Cron service is not active',
        );
      }
      return Object.freeze({ changed: false, ...current, sideEffects: false });
    }

    try {
      await atomicWrite(desired.filePath, desired.content);
      const after = await inspect(input);
      if (!after.exact || !after.cronServiceActive) {
        throw new WebsiteCronManagerError(
          after.exact ? 'website_cron_service_unavailable' : 'website_cron_apply_unconfirmed',
          after.exact ? 'Cron service is not active' : 'Cron task file did not reach expected state',
        );
      }
      return Object.freeze({
        changed: true,
        ...after,
        sideEffects: true,
      });
    } catch (error) {
      try { await restore(desired.filePath, before); }
      catch {
        throw new WebsiteCronManagerError(
          'website_cron_apply_rollback_failed',
          'Cron task apply failed and previous state could not be restored',
        );
      }
      if (error instanceof WebsiteCronManagerError) throw error;
      throw new WebsiteCronManagerError('website_cron_apply_failed', 'Cron task could not be applied');
    }
  }

  async function remove(input) {
    const desired = desiredTask(input);
    const before = await readManagedFile(desired.filePath);
    if (before === null) {
      return Object.freeze({
        taskId: desired.taskId,
        removed: false,
        previousSha256: null,
        sideEffects: false,
      });
    }
    if (before.contentSha256 !== desired.contentSha256) {
      throw new WebsiteCronManagerError(
        'website_cron_remove_drift',
        'Cron task file differs from the expected managed configuration',
        409,
      );
    }
    try {
      await rmFn(desired.filePath);
      const current = await readManagedFile(desired.filePath);
      if (current !== null) {
        throw new WebsiteCronManagerError(
          'website_cron_remove_unconfirmed',
          'Cron task file still exists after removal',
        );
      }
      return Object.freeze({
        taskId: desired.taskId,
        removed: true,
        previousSha256: before.contentSha256,
        sideEffects: true,
      });
    } catch (error) {
      if (error instanceof WebsiteCronManagerError) throw error;
      throw new WebsiteCronManagerError('website_cron_remove_failed', 'Cron task file could not be removed');
    }
  }

  return Object.freeze({ inspect, apply, remove });
}

export const websiteCronManagerInternals = Object.freeze({
  cronDirectory: CRON_DIRECTORY,
  systemctlPath: SYSTEMCTL,
  managedMarker: MANAGED_MARKER,
  maxBytes: MAX_BYTES,
  desiredTask,
  managedBytes,
  safeStat,
});
