import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  pythonApplicationUser,
  pythonServiceName,
  pythonSocketPath,
  renderPythonEnvironmentFile,
} from '@yunpanel/config-templates';
import { normalizePythonApplicationSpec } from '@yunpanel/shared';
import { gitAuthenticationPlan, gitFetchArguments, resolvedGitCommit } from './git-deployment.js';
import { createPythonSiteManager } from './python-site-manager.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';
const GIT_PATH = '/usr/bin/git';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PythonDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonDeploymentError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function requestHealth({ port, healthPath, timeoutMs = 2_000 }) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: healthPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: { host: 'localhost', connection: 'close' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function defaultWaitForHealth({ port, healthPath, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    if (await requestHealth({ port, healthPath })) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

export function createPythonDeploymentManager({
  appRoot = APP_ROOT,
  dataRoot = DATA_ROOT,
  envRoot = ENV_ROOT,
  pythonSiteManager = createPythonSiteManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readlinkFn = readlink,
  realpathFn = realpath,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
  waitForHealth = defaultWaitForHealth,
  recordLog = null,
} = {}) {
  const deploymentLocks = new Map();

  async function emitLog(context, level, message) {
    if (!recordLog || !context) return;
    try { await recordLog({ jobId: context.jobId, stage: context.stage, level, message }); } catch { /* Logs never decide deployment state. */ }
  }

  async function recordCommandOutput(context, result, failed = false) {
    if (!context) return;
    if (typeof result?.stdout === 'string' && result.stdout) await emitLog(context, 'info', result.stdout);
    if (typeof result?.stderr === 'string' && result.stderr) await emitLog(context, failed ? 'error' : 'warning', result.stderr);
  }

  async function runRoot(file, args, options = {}) {
    const { log = null, ...runOptions } = options;
    try {
      const result = await run(file, args, runOptions);
      await recordCommandOutput(log, result);
      return result;
    } catch (error) {
      await recordCommandOutput(log, error, true);
      const wrapped = new PythonDeploymentError('deployment_command_failed', 'Python deployment command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function atomicReplace(targetPath, content, mode = 0o600) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await renameFn(temporaryPath, targetPath);
    } catch (error) {
      try { await rmFn(temporaryPath, { force: true }); } catch {}
      throw error;
    }
  }

  async function pruneReleases(releasesDirectory, activeReleaseId, retention) {
    let entries = [];
    try {
      entries = await readdirFn(releasesDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    const releaseEntries = entries
      .filter((entry) => entry.isDirectory() && UUID_PATTERN.test(entry.name))
      .map((entry) => entry.name.toLowerCase());

    const staleReleases = releaseEntries.filter((id) => id !== activeReleaseId);
    if (staleReleases.length + 1 <= retention) return;

    const excessCount = (staleReleases.length + 1) - retention;
    const candidates = [];
    for (const releaseId of staleReleases) {
      try {
        const stats = await lstatFn(path.join(releasesDirectory, releaseId));
        candidates.push({ releaseId, mtimeMs: stats.mtimeMs });
      } catch {
        // Skip unreadable release
      }
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const toDelete = candidates.slice(0, excessCount);
    for (const candidate of toDelete) {
      try {
        await rmFn(path.join(releasesDirectory, candidate.releaseId), { recursive: true, force: true });
      } catch {
        // Best effort deletion
      }
    }
  }

  async function deployPython(spec, { gitCredential = null, logContext = null } = {}) {
    const normalized = normalizePythonApplicationSpec(spec);
    const applicationId = normalized.applicationId;
    const unixUser = pythonApplicationUser(applicationId);

    if (deploymentLocks.has(applicationId)) {
      throw new PythonDeploymentError('application_job_conflict', 'Python deployment is already in progress');
    }
    deploymentLocks.set(applicationId, true);

    try {
      const appDir = path.join(appRoot, applicationId);
      const releasesDir = path.join(appDir, 'releases');
      const currentLink = path.join(appDir, 'current');
      const envFilePath = path.join(envRoot, `${applicationId}.env`);

      const releaseId = normalized.deploymentId ?? randomUUID();
      const releasePath = path.join(releasesDir, releaseId);

      await mkdirFn(releasesDir, { recursive: true, mode: 0o750 });
      await mkdirFn(releasePath, { recursive: true, mode: 0o750 });

      // Git fetch / clone
      const authPlan = gitAuthenticationPlan({
        repositoryUrl: normalized.repositoryUrl,
        credential: gitCredential,
      });

      await runRoot(GIT_PATH, ['init'], { cwd: releasePath, log: logContext });
      await runRoot(GIT_PATH, ['remote', 'add', 'origin', authPlan.repositoryUrl], { cwd: releasePath, log: logContext });

      const fetchArgs = gitFetchArguments(normalized.gitTarget, { depth: 1 });
      await runRoot(GIT_PATH, fetchArgs, {
        cwd: releasePath,
        env: { ...process.env, ...authPlan.environment },
        log: logContext,
      });

      await runRoot(GIT_PATH, ['checkout', '--detach', 'FETCH_HEAD'], { cwd: releasePath, log: logContext });

      const revParseResult = await runRoot(GIT_PATH, ['rev-parse', 'HEAD'], { cwd: releasePath, log: logContext });
      const commit = resolvedGitCommit(revParseResult?.stdout ?? revParseResult, normalized.gitTarget);
      if (!commit) {
        throw new PythonDeploymentError('git_commit_resolution_failed', 'Could not resolve git commit after checkout');
      }

      // Ensure virtualenv
      await pythonSiteManager.ensureVirtualenv({
        applicationId,
        unixUser,
      });

      // Install requirements
      await pythonSiteManager.installRequirements({
        applicationId,
        releasePath,
        requirementsFile: normalized.runtime.requirementsFile,
        unixUser,
      });

      // Render & write environment file
      const envContent = renderPythonEnvironmentFile({
        applicationId,
        runtime: normalized.runtime,
        environment: spec.environment ?? {},
      });
      await mkdirFn(envRoot, { recursive: true, mode: 0o700 });
      await atomicReplace(envFilePath, envContent, 0o600);

      // Atomic switch of current symlink
      const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      await symlinkFn(`releases/${releaseId}`, tempLink);
      await renameFn(tempLink, currentLink);

      // Apply systemd service
      const applyResult = await pythonSiteManager.apply({
        operationId: releaseId,
        websiteId: spec.websiteId ?? null,
        applicationId,
        unixUser,
        runtime: normalized.runtime,
        environmentFile: envFilePath,
      });

      // Health verification
      if (normalized.runtime.port) {
        const healthy = await waitForHealth({
          port: normalized.runtime.port,
          healthPath: normalized.runtime.healthPath,
          timeoutSeconds: normalized.runtime.healthTimeoutSeconds,
        });
        if (!healthy) {
          throw new PythonDeploymentError('application_health_failed', 'Python application did not pass health check');
        }
      } else {
        const inspected = await pythonSiteManager.inspect({ applicationId, releaseId });
        if (!inspected.active) {
          throw new PythonDeploymentError('application_health_failed', 'Python application service is not active');
        }
      }

      // Retention cleanup
      await pruneReleases(releasesDir, releaseId, normalized.retention);

      return Object.freeze({
        releaseId,
        commit,
        serviceName: applyResult.serviceName,
        socketPath: applyResult.socketPath,
        port: applyResult.port,
        active: true,
        healthy: true,
        applied: true,
      });
    } finally {
      deploymentLocks.delete(applicationId);
    }
  }

  return Object.freeze({
    deployPython,
  });
}

export const pythonDeploymentManagerInternals = Object.freeze({
  parseCurrentRelease,
  APP_ROOT,
  DATA_ROOT,
  ENV_ROOT,
});
