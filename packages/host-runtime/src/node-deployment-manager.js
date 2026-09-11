import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  nodeApplicationUser,
  nodeServiceName,
  renderNodeSystemdUnit,
} from '@yunpanel/config-templates';
import { normalizeNodeApplicationSpec } from '@yunpanel/shared';
import { gitAuthenticationPlan, gitFetchArguments, resolvedGitCommit } from './git-deployment.js';
import { createNodeEnvironmentWriter, NodeEnvironmentWriteError } from './node-environment-writer.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const ENV_ROOT = '/etc/yunpanel/apps';
const SYSTEMD_ROOT = '/etc/systemd/system';
const RUNUSER_PATH = '/usr/sbin/runuser';
const USERADD_PATH = '/usr/sbin/useradd';
const ID_PATH = '/usr/bin/id';
const INSTALL_PATH = '/usr/bin/install';
const CHOWN_PATH = '/usr/bin/chown';
const SYSTEMCTL_PATHS = Object.freeze(['/usr/bin/systemctl', '/bin/systemctl']);
const NODE_PATHS = Object.freeze(['/usr/bin/node']);
const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';
const NPM_PATHS = Object.freeze(['/usr/bin/npm', '/usr/local/bin/npm']);
const PACKAGE_MANAGER_PATHS = Object.freeze({
  npm: NPM_PATHS,
  pnpm: Object.freeze(['/usr/bin/pnpm', '/usr/local/bin/pnpm']),
  yarn: Object.freeze(['/usr/bin/yarn', '/usr/local/bin/yarn']),
});
const GIT_PATH = '/usr/bin/git';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeDeploymentError';
    this.code = code;
  }
}

function safeBuildEnvironment(home, runtimeBin) {
  return {
    HOME: home,
    PATH: `${runtimeBin}:/usr/bin:/bin`,
    CI: '1',
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function findExecutable(paths, run) {
  for (const candidate of paths) {
    try {
      await run(candidate, ['--version'], { timeout: 5_000 });
      return candidate;
    } catch {
      // Continue through fixed allowlisted executable paths.
    }
  }
  return null;
}

function parseNodeMajor(value) {
  const match = String(value ?? '').trim().match(/^v(\d{1,2})\.\d+\.\d+$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function findNodeExecutable(paths, requestedMajor, run) {
  for (const candidate of paths) {
    try {
      const { stdout } = await run(candidate, ['--version'], { timeout: 5_000 });
      if (parseNodeMajor(stdout) === requestedMajor) return candidate;
    } catch { /* Continue through fixed version-bound paths. */ }
  }
  return null;
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

export function createNodeDeploymentManager({
  appRoot = APP_ROOT,
  dataRoot = DATA_ROOT,
  envRoot = ENV_ROOT,
  systemdRoot = SYSTEMD_ROOT,
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
  nodePaths = null,
  managedNodeRoot = MANAGED_NODE_ROOT,
  npmPaths = NPM_PATHS,
  packageManagerPaths = PACKAGE_MANAGER_PATHS,
  systemctlPaths = SYSTEMCTL_PATHS,
} = {}) {
  const deploymentLocks = new Map();
  const environmentWriter = createNodeEnvironmentWriter({ envRoot, mkdirFn, renameFn, rmFn, writeFileFn });

  async function runSafe(file, args, options = {}) {
    try {
      return await run(file, args, options);
    } catch (error) {
      const wrapped = new NodeDeploymentError('node_deployment_command_failed', 'Node deployment command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function runAsUser(user, home, runtimeBin, file, args, options = {}) {
    return runSafe(RUNUSER_PATH, ['-u', user, '--', file, ...args], {
      ...options,
      env: { ...safeBuildEnvironment(home, runtimeBin), ...(options.env ?? {}) },
    });
  }

  async function ensureAppUser(applicationId, user, dataDirectory) {
    await mkdirFn(path.dirname(dataDirectory), { recursive: true, mode: 0o755 });
    try {
      await runSafe(ID_PATH, ['-u', user], { timeout: 5_000 });
    } catch {
      await runSafe(USERADD_PATH, [
        '--system',
        '--user-group',
        '--home-dir', dataDirectory,
        '--create-home',
        '--shell', '/usr/sbin/nologin',
        user,
      ], { timeout: 15_000 });
    }
    await runSafe(INSTALL_PATH, ['-d', '-o', user, '-g', user, '-m', '0750', dataDirectory]);
    return applicationId;
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
    await renameFn(temporaryPath, targetPath);
  }

  async function switchCurrent(currentPath, releaseId, temporarySuffix = 'next') {
    const temporaryPath = `${currentPath}.${temporarySuffix}-${process.pid}`;
    await rmFn(temporaryPath, { force: true });
    await symlinkFn(path.join('releases', releaseId), temporaryPath);
    await renameFn(temporaryPath, currentPath);
  }

  async function cleanupOldReleases({ releasesDirectory, currentReleaseId, previousReleaseId, retention }) {
    try {
      const entries = await readdirFn(releasesDirectory, { withFileTypes: true });
      const releases = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
        const releasePath = path.join(releasesDirectory, entry.name);
        const info = await lstatFn(releasePath);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        releases.push({ id: entry.name.toLowerCase(), path: releasePath, mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0 });
      }
      releases.sort((left, right) => right.mtimeMs - left.mtimeMs);
      const keep = new Set([currentReleaseId, previousReleaseId].filter(Boolean));
      for (const release of releases) {
        if (keep.size >= retention) break;
        keep.add(release.id);
      }
      for (const release of releases) {
        if (!keep.has(release.id)) await rmFn(release.path, { recursive: true, force: true });
      }
    } catch {
      // Retention cleanup must not turn a healthy deploy into a failure.
    }
  }

  async function deployUnlocked(rawSpec, { gitCredential = null } = {}) {
    let spec;
    try {
      spec = normalizeNodeApplicationSpec(rawSpec);
    } catch {
      throw new NodeDeploymentError('invalid_node_deployment', 'Node deployment specification is invalid');
    }

    const user = nodeApplicationUser(spec.applicationId);
    const serviceName = nodeServiceName(spec.applicationId);
    const applicationDirectory = path.join(appRoot, spec.applicationId);
    const releasesDirectory = path.join(applicationDirectory, 'releases');
    const releaseDirectory = path.join(releasesDirectory, spec.deploymentId);
    const currentPath = path.join(applicationDirectory, 'current');
    const dataDirectory = path.join(dataRoot, spec.applicationId);
    const unitPath = path.join(systemdRoot, serviceName);
    const privateKeyPath = path.join(dataDirectory, `.git-key-${spec.deploymentId}`);
    let gitAuthentication;
    try { gitAuthentication = gitAuthenticationPlan({ repositoryUrl: spec.repositoryUrl, credential: gitCredential, privateKeyPath }); }
    catch { throw new NodeDeploymentError('invalid_git_credential', 'Git deployment credential is invalid'); }
    let releaseCreated = false;
    let newReleaseActive = false;
    let previousReleaseId = null;
    let environmentTransaction = null;
    let environmentRestored = false;
    let privateKeyCreated = false;

    const candidates = Array.isArray(nodePaths)
      ? nodePaths
      : [path.join(managedNodeRoot, `v${spec.runtime.nodeMajor}`, 'bin', 'node'), ...NODE_PATHS];
    const nodePath = await findNodeExecutable(candidates, spec.runtime.nodeMajor, run);
    if (!nodePath) throw new NodeDeploymentError('node_not_installed', 'An allowlisted Node.js runtime is not installed');
    const runtimeBin = path.dirname(nodePath);

    const managedNodePrefix = `${path.join(managedNodeRoot, `v${spec.runtime.nodeMajor}`)}${path.sep}`;
    const managerPaths = nodePath.startsWith(managedNodePrefix)
      ? [path.join(runtimeBin, spec.runtime.packageManager)]
      : spec.runtime.packageManager === 'npm'
        ? npmPaths
        : packageManagerPaths?.[spec.runtime.packageManager];
    const packageManagerPath = Array.isArray(managerPaths) ? await findExecutable(managerPaths, run) : null;
    if (!packageManagerPath) {
      throw new NodeDeploymentError(`${spec.runtime.packageManager}_not_installed`, `${spec.runtime.packageManager} is not installed on the managed server`);
    }
    const systemctlPath = await findExecutable(systemctlPaths, run);
    if (!systemctlPath) throw new NodeDeploymentError('systemd_not_available', 'systemctl is not available on the managed server');

    await ensureAppUser(spec.applicationId, user, dataDirectory);
    await runSafe(INSTALL_PATH, ['-d', '-o', 'root', '-g', 'root', '-m', '0755', applicationDirectory]);
    await runSafe(INSTALL_PATH, ['-d', '-o', 'root', '-g', 'root', '-m', '0755', releasesDirectory]);
    await runSafe(INSTALL_PATH, ['-d', '-o', user, '-g', user, '-m', '0750', releaseDirectory]);
    releaseCreated = true;

    try {
      if (gitAuthentication.privateKey) {
        await writeFileFn(privateKeyPath, gitAuthentication.privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        privateKeyCreated = true;
        await runSafe(CHOWN_PATH, [`${user}:${user}`, privateKeyPath], { timeout: 10_000 });
      }
      await runAsUser(user, dataDirectory, runtimeBin, GIT_PATH, ['init', '.'], {
        cwd: releaseDirectory, timeout: 30_000,
      });
      await runAsUser(user, dataDirectory, runtimeBin, GIT_PATH, ['remote', 'add', 'origin', gitAuthentication.repositoryUrl], {
        cwd: releaseDirectory, timeout: 30_000,
      });
      await runAsUser(user, dataDirectory, runtimeBin, GIT_PATH, gitFetchArguments(spec.gitTarget, { depth: 1 }), {
        cwd: releaseDirectory, timeout: 5 * 60 * 1000, env: gitAuthentication.environment,
      });

      const revision = await runAsUser(user, dataDirectory, runtimeBin, GIT_PATH, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
        cwd: releaseDirectory,
        timeout: 30_000,
      });
      const commitSha = resolvedGitCommit(revision.stdout, spec.gitTarget);
      if (!commitSha) throw new NodeDeploymentError('invalid_git_revision', 'Git returned a revision that does not match the deployment target');
      await runAsUser(user, dataDirectory, runtimeBin, GIT_PATH, ['checkout', '--detach', commitSha], {
        cwd: releaseDirectory, timeout: 60_000,
      });
      if (privateKeyCreated) {
        await rmFn(privateKeyPath, { force: true });
        privateKeyCreated = false;
      }

      const requestedDocumentRoot = path.join(releaseDirectory, spec.runtime.documentRoot);
      let documentRoot;
      let requestedDocumentRootInfo;
      try {
        requestedDocumentRootInfo = await lstatFn(requestedDocumentRoot);
        documentRoot = await realpathFn(requestedDocumentRoot);
      }
      catch { throw new NodeDeploymentError('node_document_root_missing', 'Node application document root does not exist'); }
      if (!requestedDocumentRootInfo.isDirectory() || requestedDocumentRootInfo.isSymbolicLink()) {
        throw new NodeDeploymentError('node_document_root_invalid', 'Node application document root must be a real directory');
      }
      if (documentRoot !== releaseDirectory && !documentRoot.startsWith(`${releaseDirectory}${path.sep}`)) {
        throw new NodeDeploymentError('node_document_root_escape', 'Node application document root resolves outside the release');
      }

      const installArgs = spec.runtime.packageManager === 'npm'
        ? (spec.runtime.installMode === 'ci' ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'])
        : spec.runtime.packageManager === 'pnpm'
          ? (spec.runtime.installMode === 'ci' ? ['install', '--frozen-lockfile'] : ['install'])
          : (spec.runtime.installMode === 'ci' ? ['install', '--immutable'] : ['install']);
      await runAsUser(user, dataDirectory, runtimeBin, packageManagerPath, installArgs, { cwd: documentRoot, timeout: 15 * 60 * 1000 });
      if (spec.runtime.buildScript) {
        await runAsUser(user, dataDirectory, runtimeBin, packageManagerPath, ['run', spec.runtime.buildScript], { cwd: documentRoot, timeout: 15 * 60 * 1000 });
      }

      if (spec.runtime.start.mode === 'node') {
        const requestedEntry = path.join(documentRoot, spec.runtime.start.entryFile);
        let resolvedEntry;
        try {
          resolvedEntry = await realpathFn(requestedEntry);
        } catch {
          throw new NodeDeploymentError('node_entry_missing', 'Node application entry file does not exist');
        }
        if (!resolvedEntry.startsWith(`${documentRoot}${path.sep}`)) {
          throw new NodeDeploymentError('node_entry_escape', 'Node application entry file resolves outside the release');
        }
        const entryInfo = await lstatFn(resolvedEntry);
        if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) {
          throw new NodeDeploymentError('node_entry_invalid', 'Node application entry must be a real file');
        }
      }

      await rmFn(path.join(releaseDirectory, '.git'), { recursive: true, force: true });
      await mkdirFn(systemdRoot, { recursive: true, mode: 0o755 });

      try {
        environmentTransaction = await environmentWriter.writeEnvironment({
          applicationId: spec.applicationId,
          runtime: spec.runtime,
          environment: rawSpec.environment ?? {},
        });
      } catch (error) {
        if (error instanceof NodeEnvironmentWriteError) {
          throw new NodeDeploymentError(error.code, error.message);
        }
        throw error;
      }

      const unit = renderNodeSystemdUnit({
        applicationId: spec.applicationId,
        user,
        nodePath,
        packageManagerPath,
        runtime: spec.runtime,
      });
      await atomicWrite(unitPath, unit, 0o644);

      try {
        previousReleaseId = parseCurrentRelease(await readlinkFn(currentPath));
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
      }

      await switchCurrent(currentPath, spec.deploymentId);
      newReleaseActive = true;

      let activationError = null;
      try {
        await runSafe(systemctlPath, ['daemon-reload'], { timeout: 30_000 });
        await runSafe(systemctlPath, ['enable', serviceName], { timeout: 30_000 });
        await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
        const healthy = await waitForHealth({
          port: spec.runtime.port,
          healthPath: spec.runtime.healthPath,
          timeoutSeconds: spec.runtime.healthTimeoutSeconds,
        });
        if (!healthy) {
          activationError = new NodeDeploymentError('node_health_failed', 'New Node release failed health checks and was not kept active');
        }
      } catch (error) {
        activationError = error;
      }

      if (activationError) {
        try {
          if (previousReleaseId) {
            await switchCurrent(currentPath, previousReleaseId, 'rollback');
            newReleaseActive = false;
            await environmentTransaction.restore();
            environmentRestored = true;
            await runSafe(systemctlPath, ['restart', serviceName], { timeout: 30_000 });
            const rollbackHealthy = await waitForHealth({
              port: spec.runtime.port,
              healthPath: spec.runtime.healthPath,
              timeoutSeconds: spec.runtime.healthTimeoutSeconds,
            });
            if (!rollbackHealthy) throw new Error('previous release failed health check');
          } else {
            newReleaseActive = false;
            await environmentTransaction.restore();
            environmentRestored = true;
            await runSafe(systemctlPath, ['stop', serviceName], { timeout: 30_000 }).catch(() => {});
            await runSafe(systemctlPath, ['disable', serviceName], { timeout: 30_000 }).catch(() => {});
            await rmFn(currentPath, { force: true });
          }
        } catch {
          throw new NodeDeploymentError('node_rollback_failed', 'Node activation failed and the previous service state could not be restored');
        }
        throw activationError;
      }

      environmentTransaction.commit();
      await cleanupOldReleases({
        releasesDirectory,
        currentReleaseId: spec.deploymentId,
        previousReleaseId,
        retention: spec.retention,
      });

      return {
        deploymentId: spec.deploymentId,
        releaseId: spec.deploymentId,
        previousReleaseId,
        commitSha,
        serviceName,
        port: spec.runtime.port,
        healthPath: spec.runtime.healthPath,
        healthy: true,
      };
    } catch (error) {
      if (privateKeyCreated) await rmFn(privateKeyPath, { force: true }).catch(() => {});
      if (environmentTransaction && !environmentRestored) await environmentTransaction.restore().catch(() => {});
      if (!newReleaseActive && releaseCreated) {
        await rmFn(releaseDirectory, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof NodeDeploymentError) throw error;
      throw new NodeDeploymentError('node_deployment_failed', 'Node deployment failed');
    }
  }

  function deployNode(spec, options = {}) {
    const key = spec?.applicationId ?? 'invalid';
    const previous = deploymentLocks.get(key) ?? Promise.resolve();
    const runDeployment = previous.catch(() => {}).then(() => deployUnlocked(spec, options));
    let tracked;
    tracked = runDeployment.finally(() => {
      if (deploymentLocks.get(key) === tracked) deploymentLocks.delete(key);
    });
    deploymentLocks.set(key, tracked);
    return tracked;
  }

  return { deployNode };
}

export const nodeDeploymentManager = createNodeDeploymentManager();
export const nodeDeploymentInternals = Object.freeze({ safeBuildEnvironment, findExecutable, parseNodeMajor, findNodeExecutable });
