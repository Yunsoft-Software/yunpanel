import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, lstat, mkdir, readlink, realpath, readdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeStaticApplicationSpec } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const BUILD_ROOT = '/var/lib/yunpanel/build';
const WEB_ROOT = '/var/www/yunpanel/apps';
const RUNUSER_PATH = '/usr/sbin/runuser';
const USERADD_PATH = '/usr/sbin/useradd';
const ID_PATH = '/usr/bin/id';
const INSTALL_PATH = '/usr/bin/install';
const CHOWN_PATH = '/usr/bin/chown';
const PKILL_PATH = '/usr/bin/pkill';
const GIT_PATH = '/usr/bin/git';
const NPM_PATHS = Object.freeze(['/usr/bin/npm', '/usr/local/bin/npm']);
const ARTIFACT_WORKER_PATH = fileURLToPath(new URL('./static-artifact-worker.js', import.meta.url));
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StaticDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticDeploymentError';
    this.code = code;
  }
}

function appUsername(applicationId) {
  const digest = createHash('sha256').update(applicationId).digest('hex').slice(0, 12);
  return `yunapp-${digest}`;
}

function safeEnvironment(home) {
  return {
    HOME: home,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    CI: '1',
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function findExecutable(paths, accessFn) {
  for (const candidate of paths) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue through the fixed executable allowlist.
    }
  }
  return null;
}

function parsePreviousRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export function createStaticDeploymentManager({
  buildRoot = BUILD_ROOT,
  webRoot = WEB_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  accessFn = access,
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readlinkFn = readlink,
  realpathFn = realpath,
  readdirFn = readdir,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  nodePath = process.execPath,
  artifactWorkerPath = ARTIFACT_WORKER_PATH,
  npmPaths = NPM_PATHS,
} = {}) {
  const deploymentLocks = new Map();

  async function runRoot(file, args, options = {}) {
    try {
      return await run(file, args, options);
    } catch (error) {
      const wrapped = new StaticDeploymentError('deployment_command_failed', 'Static deployment command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function runAsUser(username, home, file, args, options = {}) {
    return runRoot(RUNUSER_PATH, ['-u', username, '--', file, ...args], { ...options, env: safeEnvironment(home) });
  }

  async function ensureAppUser(username, appBuildRoot) {
    await mkdirFn(path.dirname(appBuildRoot), { recursive: true, mode: 0o755 });
    try {
      await runRoot(ID_PATH, ['-u', username], { timeout: 5_000 });
    } catch {
      await runRoot(USERADD_PATH, [
        '--system', '--user-group', '--home-dir', appBuildRoot, '--create-home', '--shell', '/usr/sbin/nologin', username,
      ], { timeout: 15_000 });
    }
    await runRoot(INSTALL_PATH, ['-d', '-o', username, '-g', username, '-m', '0750', appBuildRoot]);
    await runRoot(INSTALL_PATH, ['-d', '-o', username, '-g', username, '-m', '0750', path.join(appBuildRoot, 'worktrees')]);
  }

  async function stopAppProcesses(username) {
    try {
      await run(PKILL_PATH, ['-KILL', '-u', username], { timeout: 5_000 });
    } catch {
      // pkill exits non-zero when the dedicated app user has no remaining processes.
    }
  }

  async function verifyAndNormalizeArtifact(directory) {
    async function visit(current) {
      const entries = await readdirFn(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        const info = await lstatFn(entryPath);
        if (info.isSymbolicLink()) throw new StaticDeploymentError('artifact_symlink_rejected', 'Published artifact contains a symbolic link');
        if (info.isDirectory()) {
          await chmodFn(entryPath, 0o755);
          await visit(entryPath);
          continue;
        }
        if (!info.isFile()) throw new StaticDeploymentError('artifact_entry_rejected', 'Published artifact contains an unsupported filesystem entry');
        await chmodFn(entryPath, 0o644);
      }
    }

    await chmodFn(directory, 0o755);
    await visit(directory);
    await runRoot(CHOWN_PATH, ['--recursive', '--no-dereference', 'root:root', directory], { timeout: 60_000 });
  }

  async function cleanupOldReleases({ releasesPath, currentReleaseId, previousReleaseId, retention }) {
    try {
      const entries = await readdirFn(releasesPath, { withFileTypes: true });
      const releases = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
        const releasePath = path.join(releasesPath, entry.name);
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
      // Retention cleanup is best effort and must never roll back a successful atomic switch.
    }
  }

  async function deployUnlocked(rawSpec) {
    let spec;
    try {
      spec = normalizeStaticApplicationSpec(rawSpec);
    } catch {
      throw new StaticDeploymentError('invalid_static_deployment', 'Static deployment specification is invalid');
    }

    const username = appUsername(spec.applicationId);
    const appBuildRoot = path.join(buildRoot, spec.applicationId);
    const repositoryPath = path.join(appBuildRoot, 'repository');
    const worktreePath = path.join(appBuildRoot, 'worktrees', spec.deploymentId);
    const appWebRoot = path.join(webRoot, spec.applicationId);
    const releasesPath = path.join(appWebRoot, 'releases');
    const servedReleasePath = path.join(releasesPath, spec.deploymentId);
    const currentPath = path.join(appWebRoot, 'current');
    const temporaryCurrentPath = path.join(appWebRoot, `.current-${spec.deploymentId}`);
    let worktreeCreated = false;
    let artifactCreated = false;

    await ensureAppUser(username, appBuildRoot);

    try {
      try {
        await accessFn(path.join(repositoryPath, '.git'));
        await runAsUser(username, appBuildRoot, GIT_PATH, ['-C', repositoryPath, 'remote', 'set-url', 'origin', spec.repositoryUrl]);
      } catch {
        await runAsUser(username, appBuildRoot, GIT_PATH, ['clone', '--no-checkout', spec.repositoryUrl, repositoryPath], { timeout: 5 * 60 * 1000 });
      }

      await runAsUser(username, appBuildRoot, GIT_PATH, ['-C', repositoryPath, 'fetch', '--prune', '--no-tags', 'origin', spec.branch], { timeout: 5 * 60 * 1000 });
      const revision = await runAsUser(username, appBuildRoot, GIT_PATH, ['-C', repositoryPath, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
      const commitSha = String(revision.stdout ?? '').trim().toLowerCase();
      if (!COMMIT_PATTERN.test(commitSha)) throw new StaticDeploymentError('invalid_git_revision', 'Git returned an invalid commit revision');

      await runAsUser(username, appBuildRoot, GIT_PATH, ['-C', repositoryPath, 'worktree', 'add', '--detach', worktreePath, commitSha], { timeout: 60_000 });
      worktreeCreated = true;

      if (spec.build.mode === 'npm') {
        const npmPath = await findExecutable(npmPaths, accessFn);
        if (!npmPath) throw new StaticDeploymentError('npm_not_installed', 'npm is not installed on the managed server');
        const installArgs = spec.build.installMode === 'ci' ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
        await runAsUser(username, appBuildRoot, npmPath, installArgs, { cwd: worktreePath, timeout: 15 * 60 * 1000 });
        await runAsUser(username, appBuildRoot, npmPath, ['run', spec.build.buildScript], { cwd: worktreePath, timeout: 15 * 60 * 1000 });
      }

      const requestedOutput = spec.build.outputDir === '.' ? worktreePath : path.join(worktreePath, spec.build.outputDir);
      let outputPath;
      try {
        outputPath = await realpathFn(requestedOutput);
      } catch {
        throw new StaticDeploymentError('build_output_missing', 'Static build output directory does not exist');
      }
      const safePrefix = `${worktreePath}${path.sep}`;
      if (outputPath !== worktreePath && !outputPath.startsWith(safePrefix)) throw new StaticDeploymentError('build_output_escape', 'Static build output resolves outside the deployment worktree');
      const outputInfo = await lstatFn(outputPath);
      if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new StaticDeploymentError('invalid_build_output', 'Static build output must be a real directory');

      await mkdirFn(releasesPath, { recursive: true, mode: 0o755 });
      await mkdirFn(servedReleasePath, { recursive: false, mode: 0o755 });
      artifactCreated = true;
      await runRoot(CHOWN_PATH, [`${username}:${username}`, servedReleasePath], { timeout: 10_000 });

      const artifactCopy = await runAsUser(
        username,
        appBuildRoot,
        nodePath,
        [artifactWorkerPath, outputPath, servedReleasePath, spec.build.healthFile],
        { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 },
      );
      let artifact;
      try {
        artifact = JSON.parse(String(artifactCopy.stdout ?? '').trim());
      } catch {
        throw new StaticDeploymentError('invalid_artifact_manifest', 'Artifact copier returned invalid metadata');
      }
      if (
        !Number.isInteger(artifact.files)
        || artifact.files < 1
        || !Number.isFinite(artifact.bytes)
        || artifact.bytes < 0
        || artifact.healthFile !== spec.build.healthFile
      ) {
        throw new StaticDeploymentError('invalid_artifact_manifest', 'Artifact copier returned invalid metadata');
      }

      await stopAppProcesses(username);
      await verifyAndNormalizeArtifact(servedReleasePath);

      let previousReleaseId = null;
      try {
        previousReleaseId = parsePreviousRelease(await readlinkFn(currentPath));
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'EINVAL') throw error;
      }

      await rmFn(temporaryCurrentPath, { force: true });
      await symlinkFn(path.join('releases', spec.deploymentId), temporaryCurrentPath);
      await renameFn(temporaryCurrentPath, currentPath);
      await cleanupOldReleases({
        releasesPath,
        currentReleaseId: spec.deploymentId,
        previousReleaseId,
        retention: spec.retention,
      });

      return {
        deploymentId: spec.deploymentId,
        releaseId: spec.deploymentId,
        commitSha,
        previousReleaseId,
        artifactFiles: artifact.files,
        artifactBytes: artifact.bytes,
      };
    } catch (error) {
      await stopAppProcesses(username);
      if (artifactCreated) await rmFn(servedReleasePath, { recursive: true, force: true }).catch(() => {});
      if (error instanceof StaticDeploymentError) throw error;
      throw new StaticDeploymentError('static_deployment_failed', 'Static deployment failed');
    } finally {
      if (worktreeCreated) {
        try {
          await runAsUser(username, appBuildRoot, GIT_PATH, ['-C', repositoryPath, 'worktree', 'remove', '--force', worktreePath], { timeout: 60_000 });
        } catch {
          // Stale worktrees can be pruned by a later maintenance job; deployment result is already known.
        }
      }
    }
  }

  function deployStatic(spec) {
    const key = spec?.applicationId ?? 'invalid';
    const previous = deploymentLocks.get(key) ?? Promise.resolve();
    const runDeployment = previous.catch(() => {}).then(() => deployUnlocked(spec));
    let tracked;
    tracked = runDeployment.finally(() => {
      if (deploymentLocks.get(key) === tracked) deploymentLocks.delete(key);
    });
    deploymentLocks.set(key, tracked);
    return runDeployment;
  }

  return { deployStatic };
}

export const staticDeploymentManager = createStaticDeploymentManager();
