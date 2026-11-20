import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readlink, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  pythonApplicationUser,
  renderPythonEnvironmentFile,
} from '@yunpanel/config-templates';
import { normalizePythonApplicationSpec } from '@yunpanel/shared';
import { gitAuthenticationPlan, gitFetchArguments, resolvedGitCommit } from './git-deployment.js';
import {
  createPythonSiteManager,
  defaultWaitForPythonHealth,
  requestPythonHealth,
} from './python-site-manager.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';
const GIT_PATH = '/usr/bin/git';
const INSTALL_PATH = '/usr/bin/install';
const RUNUSER_PATH = '/usr/sbin/runuser';
const CHOWN_PATH = '/usr/bin/chown';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PythonDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PythonDeploymentError';
    this.code = code;
  }
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function safePythonGitEnvironment(homeDirectory, extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDirectory,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export function createPythonDeploymentManager({
  appRoot = APP_ROOT,
  dataRoot = DATA_ROOT,
  envRoot = ENV_ROOT,
  gitPath = GIT_PATH,
  installPath = INSTALL_PATH,
  runuserPath = RUNUSER_PATH,
  chownPath = CHOWN_PATH,
  pythonSiteManager = createPythonSiteManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  readlinkFn = readlink,
  realpathFn = realpath,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
  waitForHealth = defaultWaitForPythonHealth,
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

  async function runAsSiteUser(unixUser, homeDirectory, file, args, options = {}) {
    return runRoot(runuserPath, ['-u', unixUser, '--', file, ...args], {
      ...options,
      env: safePythonGitEnvironment(homeDirectory, options.env ?? {}),
    });
  }

  async function removeIfPresent(targetPath, options = {}) {
    try {
      await rmFn(targetPath, { ...options, force: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async function readOptionalFile(targetPath) {
    try {
      return await readFileFn(targetPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function readCurrentReleaseId(currentLink) {
    try {
      return parseCurrentRelease(await readlinkFn(currentLink));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function ensureSharedRoot(rootPath) {
    try {
      const info = await lstatFn(rootPath);
      if (!info.isDirectory() || info.isSymbolicLink?.()) {
        throw new PythonDeploymentError('python_shared_root_invalid', `Managed root is not a real directory: ${rootPath}`);
      }
      return;
    } catch (error) {
      if (error instanceof PythonDeploymentError) throw error;
      if (!isNotFound(error)) throw error;
    }
    await mkdirFn(rootPath, { recursive: true, mode: 0o755 });
    await chmodFn(rootPath, 0o755);
  }

  async function atomicReplace(targetPath, content, mode = 0o600) {
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
      await chmodFn(temporaryPath, mode);
      await renameFn(temporaryPath, targetPath);
    } catch (error) {
      try {
        await removeIfPresent(temporaryPath);
      } catch {
        // Preserve original write/chmod/rename error.
      }
      throw error;
    }
  }

  async function switchCurrentLink(appDir, currentLink, targetReleaseId) {
    const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await symlinkFn(`releases/${targetReleaseId}`, tempLink);
      await renameFn(tempLink, currentLink);
    } catch (error) {
      try {
        await removeIfPresent(tempLink);
      } catch {
        // Preserve original symlink/rename error.
      }
      throw error;
    }
  }

  async function pruneReleases(releasesDirectory, activeReleaseId, previousReleaseId, retention) {
    let entries = [];
    try {
      entries = await readdirFn(releasesDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      return;
    }
    const releaseEntries = entries
      .filter((entry) => entry.isDirectory() && UUID_PATTERN.test(entry.name))
      .map((entry) => entry.name.toLowerCase());

    const protectedReleases = new Set([activeReleaseId, previousReleaseId].filter(Boolean));
    const staleReleases = releaseEntries.filter((id) => !protectedReleases.has(id));
    const totalCount = new Set([...releaseEntries, activeReleaseId]).size;
    if (totalCount <= retention) return;

    const excessCount = Math.min(staleReleases.length, totalCount - retention);
    if (excessCount <= 0) return;

    const candidates = [];
    for (const releaseId of staleReleases) {
      try {
        const stats = await lstatFn(path.join(releasesDirectory, releaseId));
        if (!stats.isDirectory() || stats.isSymbolicLink?.()) continue;
        candidates.push({ releaseId, mtimeMs: stats.mtimeMs });
      } catch {
        // Skip unreadable release
      }
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const toDelete = candidates.slice(0, excessCount);
    for (const candidate of toDelete) {
      try {
        await removeIfPresent(path.join(releasesDirectory, candidate.releaseId), { recursive: true });
      } catch {
        // Retention cleanup must not turn a healthy deploy into a failure.
      }
    }
  }

  async function deployPython(spec, { gitCredential = null, logContext = null } = {}) {
    const {
      environment = {},
      websiteId = null,
      ...rawSpec
    } = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};

    const normalized = normalizePythonApplicationSpec(rawSpec);
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
      const dataDir = path.join(dataRoot, applicationId);
      const envFilePath = path.join(envRoot, `${applicationId}.env`);

      const releaseId = normalized.deploymentId ?? randomUUID();
      const releasePath = path.join(releasesDir, releaseId);
      const privateKeyPath = path.join(dataDir, `.git-key-${releaseId}`);

      const previousReleaseId = await readCurrentReleaseId(currentLink);
      const previousEnvContent = await readOptionalFile(envFilePath);

      await pythonSiteManager.ensureVirtualenv({
        applicationId,
        unixUser,
      });

      await ensureSharedRoot(appRoot);
      await runRoot(installPath, ['-d', '-o', 'root', '-g', unixUser, '-m', '0750', appDir], { timeout: 10_000, log: logContext });
      await runRoot(installPath, ['-d', '-o', 'root', '-g', unixUser, '-m', '0750', releasesDir], { timeout: 10_000, log: logContext });
      await runRoot(installPath, ['-d', '-o', unixUser, '-g', unixUser, '-m', '0750', releasePath], { timeout: 10_000, log: logContext });

      const authPlan = gitAuthenticationPlan({
        repositoryUrl: normalized.repositoryUrl,
        credential: gitCredential,
        privateKeyPath,
      });

      let privateKeyCreated = false;
      let commit;
      try {
        if (authPlan.privateKey) {
          await writeFileFn(privateKeyPath, authPlan.privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          privateKeyCreated = true;
          await chmodFn(privateKeyPath, 0o600);
          await runRoot(chownPath, [`${unixUser}:${unixUser}`, privateKeyPath], { timeout: 10_000, log: logContext });
        }

        await runAsSiteUser(unixUser, dataDir, gitPath, ['init', '.'], { cwd: releasePath, timeout: 30_000, log: logContext });
        await runAsSiteUser(unixUser, dataDir, gitPath, ['remote', 'add', 'origin', authPlan.repositoryUrl], { cwd: releasePath, timeout: 30_000, log: logContext });

        const fetchArgs = gitFetchArguments(normalized.gitTarget, { depth: 1 });
        await runAsSiteUser(unixUser, dataDir, gitPath, fetchArgs, {
          cwd: releasePath,
          env: authPlan.environment,
          timeout: 5 * 60 * 1000,
          log: logContext,
        });

        await runAsSiteUser(unixUser, dataDir, gitPath, ['checkout', '--detach', 'FETCH_HEAD'], { cwd: releasePath, timeout: 60_000, log: logContext });

        const revParseResult = await runAsSiteUser(unixUser, dataDir, gitPath, ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: releasePath, timeout: 30_000, log: logContext });
        commit = resolvedGitCommit(revParseResult?.stdout ?? revParseResult, normalized.gitTarget);
        if (!commit) {
          throw new PythonDeploymentError('git_commit_resolution_failed', 'Could not resolve git commit after checkout');
        }
      } finally {
        if (privateKeyCreated) {
          await removeIfPresent(privateKeyPath);
        }
      }

      if (normalized.runtime.documentRoot !== '.') {
        const requestedDocRoot = path.join(releasePath, normalized.runtime.documentRoot);
        let docRootInfo;
        let resolvedDocRoot;
        let resolvedReleasePath;
        try {
          docRootInfo = await lstatFn(requestedDocRoot);
          resolvedDocRoot = await realpathFn(requestedDocRoot);
          resolvedReleasePath = await realpathFn(releasePath);
        } catch {
          throw new PythonDeploymentError('python_document_root_missing', 'Python application document root does not exist');
        }
        if (!docRootInfo.isDirectory() || docRootInfo.isSymbolicLink?.()) {
          throw new PythonDeploymentError('python_document_root_invalid', 'Python application document root must be a real directory');
        }
        if (resolvedDocRoot !== resolvedReleasePath && !resolvedDocRoot.startsWith(`${resolvedReleasePath}${path.sep}`)) {
          throw new PythonDeploymentError('python_document_root_escape', 'Python application document root resolves outside the release');
        }
      }

      await removeIfPresent(path.join(releasePath, '.git'), { recursive: true });

      await pythonSiteManager.installRequirements({
        applicationId,
        releasePath,
        requirementsFile: normalized.runtime.requirementsFile,
        unixUser,
      });

      const envContent = renderPythonEnvironmentFile({
        applicationId,
        runtime: normalized.runtime,
        environment,
      });
      await mkdirFn(envRoot, { recursive: true, mode: 0o700 });
      await atomicReplace(envFilePath, envContent, 0o600);

      await switchCurrentLink(appDir, currentLink, releaseId);

      let applyResult;
      let activationError = null;
      try {
        applyResult = await pythonSiteManager.apply({
          operationId: releaseId,
          websiteId,
          applicationId,
          unixUser,
          runtime: normalized.runtime,
          environmentFile: envFilePath,
        });

        const healthy = await waitForHealth({
          port: normalized.runtime.port ?? null,
          socketPath: normalized.runtime.port ? null : applyResult.socketPath,
          healthPath: normalized.runtime.healthPath,
          timeoutSeconds: normalized.runtime.healthTimeoutSeconds,
        });
        const inspected = await pythonSiteManager.inspect({ applicationId, releaseId });
        if (!healthy || !inspected.active) {
          activationError = new PythonDeploymentError('application_health_failed', 'Python application did not pass health check');
        }
      } catch (error) {
        activationError = error;
      }

      if (activationError) {
        try {
          if (previousReleaseId) {
            await switchCurrentLink(appDir, currentLink, previousReleaseId);
            if (previousEnvContent !== null) {
              await atomicReplace(envFilePath, previousEnvContent, 0o600);
            } else {
              await removeIfPresent(envFilePath);
            }
            if (applyResult && typeof pythonSiteManager.compensate === 'function') {
              await pythonSiteManager.compensate({ operationId: releaseId, applicationId });
            } else if (typeof pythonSiteManager.restart === 'function') {
              await pythonSiteManager.restart({ applicationId, releaseId: previousReleaseId });
            }
          } else {
            await removeIfPresent(currentLink);
            if (previousEnvContent === null) {
              await removeIfPresent(envFilePath);
            }
            if (applyResult && typeof pythonSiteManager.compensate === 'function') {
              await pythonSiteManager.compensate({ operationId: releaseId, applicationId });
            }
          }
        } catch {
          // Preserve the primary activation failure after best-effort restore.
        }
        throw activationError;
      }

      await pruneReleases(releasesDir, releaseId, previousReleaseId, normalized.retention);

      return Object.freeze({
        deploymentId: releaseId,
        releaseId,
        previousReleaseId,
        commit,
        commitSha: commit,
        gitTarget: normalized.gitTarget,
        serviceName: applyResult.serviceName,
        socketPath: applyResult.socketPath,
        port: applyResult.port,
        healthPath: normalized.runtime.healthPath,
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
  GIT_PATH,
  INSTALL_PATH,
  RUNUSER_PATH,
  CHOWN_PATH,
  safePythonGitEnvironment,
  requestPythonHealth,
});
