import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pythonApplicationUser } from '@yunpanel/config-templates';
import {
  assertUuid,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeGithubRepositoryUrl,
  normalizePythonRuntimeConfig,
} from '@yunpanel/shared';
import { gitAuthenticationPlan, gitFetchArguments, resolvedGitCommit } from './git-deployment.js';
import { createPythonSiteManager } from './python-site-manager.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = '/var/lib/yunpanel/apps';
const DATA_ROOT = '/var/lib/yunpanel/data';
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/python-release';
const RECEIPT_VERSION = 1;
const GIT_PATH = '/usr/bin/git';
const INSTALL_PATH = '/usr/bin/install';
const RUNUSER_PATH = '/usr/sbin/runuser';
const CHOWN_PATH = '/usr/bin/chown';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export class WebsitePythonReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsitePythonReleaseError';
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

function normalizeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsitePythonReleaseError('website_python_release_invalid', 'Python release specification is invalid');
  }
  const allowed = new Set(['applicationId', 'deploymentId', 'repositoryUrl', 'branch', 'gitTarget', 'runtime', 'retention']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WebsitePythonReleaseError('website_python_release_invalid', 'Python release specification contains unsupported fields');
  }
  let applicationId;
  let deploymentId;
  let repositoryUrl;
  let branch;
  let gitTarget;
  let runtime;
  try {
    applicationId = assertUuid(value.applicationId, 'applicationId');
    deploymentId = assertUuid(value.deploymentId, 'deploymentId');
    repositoryUrl = normalizeGithubRepositoryUrl(value.repositoryUrl);
    branch = normalizeGitBranch(value.branch ?? 'main');
    gitTarget = normalizeGitDeploymentTarget(value.gitTarget, { defaultBranch: branch });
    runtime = normalizePythonRuntimeConfig(value.runtime);
  } catch {
    throw new WebsitePythonReleaseError('website_python_release_invalid', 'Python release specification is invalid');
  }
  const retention = Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20
    ? value.retention
    : 5;
  return Object.freeze({ applicationId, deploymentId, repositoryUrl, branch, gitTarget, runtime, retention });
}

function normalizeCompensationTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsitePythonReleaseError('website_python_release_compensation_invalid', 'Python release compensation target is invalid');
  }
  let applicationId;
  let deploymentId;
  let previousReleaseId;
  try {
    applicationId = assertUuid(value.applicationId, 'applicationId');
    deploymentId = assertUuid(value.deploymentId, 'deploymentId');
    previousReleaseId = value.previousReleaseId == null ? null : assertUuid(value.previousReleaseId, 'previousReleaseId');
  } catch {
    throw new WebsitePythonReleaseError('website_python_release_compensation_invalid', 'Python release compensation target is invalid');
  }
  if (previousReleaseId === deploymentId) {
    throw new WebsitePythonReleaseError('website_python_release_compensation_invalid', 'Previous release cannot equal the operation-owned release');
  }
  return Object.freeze({ applicationId, deploymentId, previousReleaseId });
}

export function createWebsitePythonReleaseManager({
  appRoot = APP_ROOT,
  dataRoot = DATA_ROOT,
  receiptRoot = RECEIPT_ROOT,
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
  readlinkFn = readlink,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
} = {}) {
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
        throw new WebsitePythonReleaseError('website_python_release_root_invalid', `Managed root is not a real directory: ${rootPath}`);
      }
      return;
    } catch (error) {
      if (error instanceof WebsitePythonReleaseError) throw error;
      if (!isNotFound(error)) throw error;
    }
    await mkdirFn(rootPath, { recursive: true, mode: 0o755 });
    await chmodFn(rootPath, 0o755);
  }

  async function writeManagedFile(targetPath, content, mode = 0o600) {
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

  async function runAsSiteUser(unixUser, homeDirectory, file, args, options = {}) {
    return run(runuserPath, ['-u', unixUser, '--', file, ...args], {
      ...options,
      env: safePythonGitEnvironment(homeDirectory, options.env ?? {}),
    });
  }

  async function prepare(spec, { gitCredential = null } = {}) {
    const normalized = normalizeSpec(spec);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;
    const unixUser = pythonApplicationUser(applicationId);

    const appDir = path.join(appRoot, applicationId);
    const releasesDir = path.join(appDir, 'releases');
    const releasePath = path.join(releasesDir, deploymentId);
    const currentLink = path.join(appDir, 'current');
    const dataDir = path.join(dataRoot, applicationId);
    const privateKeyPath = path.join(dataDir, `.git-key-${deploymentId}`);

    const previousReleaseId = await readCurrentReleaseId(currentLink);

    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(receiptRoot, `${deploymentId}.json`);

    const receipt = {
      version: RECEIPT_VERSION,
      applicationId,
      deploymentId,
      previousReleaseId,
      state: 'preparing',
      timestamp: new Date().toISOString(),
    };
    await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);

    // Prepare site virtualenv and site-owned dataDir before Git operations so HOME and
    // temporary private SSH key paths stay inside the site's isolated data directory.
    await pythonSiteManager.ensureVirtualenv({
      applicationId,
      unixUser,
    });

    await ensureSharedRoot(appRoot);
    await run(installPath, ['-d', '-o', 'root', '-g', unixUser, '-m', '0750', appDir], { timeout: 10_000 });
    await run(installPath, ['-d', '-o', 'root', '-g', unixUser, '-m', '0750', releasesDir], { timeout: 10_000 });
    await run(installPath, ['-d', '-o', unixUser, '-g', unixUser, '-m', '0750', releasePath], { timeout: 10_000 });

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
        await run(chownPath, [`${unixUser}:${unixUser}`, privateKeyPath], { timeout: 10_000 });
      }

      await runAsSiteUser(unixUser, dataDir, gitPath, ['init', '.'], { cwd: releasePath, timeout: 30_000 });
      await runAsSiteUser(unixUser, dataDir, gitPath, ['remote', 'add', 'origin', authPlan.repositoryUrl], { cwd: releasePath, timeout: 30_000 });
      const fetchArgs = gitFetchArguments(normalized.gitTarget, { depth: 1 });
      await runAsSiteUser(unixUser, dataDir, gitPath, fetchArgs, {
        cwd: releasePath,
        env: authPlan.environment,
        timeout: 5 * 60 * 1000,
      });
      await runAsSiteUser(unixUser, dataDir, gitPath, ['checkout', '--detach', 'FETCH_HEAD'], { cwd: releasePath, timeout: 60_000 });

      const revParseResult = await runAsSiteUser(unixUser, dataDir, gitPath, ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: releasePath, timeout: 30_000 });
      commit = resolvedGitCommit(revParseResult?.stdout ?? revParseResult, normalized.gitTarget);
      if (!commit) {
        throw new WebsitePythonReleaseError('website_python_release_commit_invalid', 'Could not resolve git commit after checkout');
      }
    } finally {
      if (privateKeyCreated) {
        await removeIfPresent(privateKeyPath);
      }
    }

    await removeIfPresent(path.join(releasePath, '.git'), { recursive: true });

    await pythonSiteManager.installRequirements({
      applicationId,
      releasePath,
      requirementsFile: normalized.runtime.requirementsFile,
      unixUser,
    });

    await switchCurrentLink(appDir, currentLink, deploymentId);

    receipt.state = 'prepared';
    receipt.commit = commit;
    receipt.commitSha = commit;
    await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);

    return Object.freeze({
      satisfied: true,
      adapter: 'python-release',
      applicationId,
      deploymentId,
      releaseId: deploymentId,
      previousReleaseId,
      commit,
      commitSha: commit,
    });
  }

  async function inspectDeployment(spec) {
    const normalized = normalizeSpec(spec);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;

    const appDir = path.join(appRoot, applicationId);
    const releasePath = path.join(appDir, 'releases', deploymentId);
    const currentLink = path.join(appDir, 'current');
    const receiptPath = path.join(receiptRoot, `${deploymentId}.json`);

    let stats;
    try {
      stats = await lstatFn(releasePath);
    } catch (error) {
      if (isNotFound(error)) return Object.freeze({ satisfied: false, reason: 'release_missing' });
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink?.()) {
      return Object.freeze({ satisfied: false, reason: 'release_not_directory' });
    }

    const activeRelease = await readCurrentReleaseId(currentLink);
    if (activeRelease !== deploymentId) {
      return Object.freeze({ satisfied: false, reason: 'current_link_mismatch' });
    }

    const receiptRaw = await readOptionalFile(receiptPath);
    if (receiptRaw === null) {
      return Object.freeze({ satisfied: false, reason: 'release_receipt_missing' });
    }

    let receipt;
    try {
      receipt = JSON.parse(receiptRaw);
    } catch {
      return Object.freeze({ satisfied: false, reason: 'release_receipt_invalid' });
    }

    const commitSha = typeof receipt.commitSha === 'string'
      ? receipt.commitSha.toLowerCase()
      : (typeof receipt.commit === 'string' ? receipt.commit.toLowerCase() : null);

    if (
      receipt.applicationId !== applicationId
      || receipt.deploymentId !== deploymentId
      || receipt.state !== 'prepared'
      || !commitSha
      || !COMMIT_PATTERN.test(commitSha)
      || (receipt.previousReleaseId !== null && receipt.previousReleaseId !== undefined && typeof receipt.previousReleaseId !== 'string')
    ) {
      return Object.freeze({ satisfied: false, reason: 'release_receipt_invalid' });
    }

    return Object.freeze({
      satisfied: true,
      adapter: 'python-release',
      applicationId,
      deploymentId,
      releaseId: deploymentId,
      previousReleaseId: receipt.previousReleaseId ?? null,
      commit: commitSha,
      commitSha,
    });
  }

  async function compensate(target) {
    const normalized = normalizeCompensationTarget(target);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;
    const previousReleaseId = normalized.previousReleaseId;

    const appDir = path.join(appRoot, applicationId);
    const currentLink = path.join(appDir, 'current');
    const releasePath = path.join(appDir, 'releases', deploymentId);

    if (previousReleaseId) {
      const previousReleasePath = path.join(appDir, 'releases', previousReleaseId);
      let prevStats = null;
      try {
        prevStats = await lstatFn(previousReleasePath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (prevStats && prevStats.isDirectory() && !prevStats.isSymbolicLink?.()) {
        await switchCurrentLink(appDir, currentLink, previousReleaseId);
      }
    } else {
      await removeIfPresent(currentLink);
    }

    await removeIfPresent(releasePath, { recursive: true });

    const receiptPath = path.join(receiptRoot, `${deploymentId}.json`);
    const receiptContent = await readOptionalFile(receiptPath);
    if (receiptContent !== null) {
      const receipt = JSON.parse(receiptContent);
      receipt.state = 'compensated';
      await writeManagedFile(receiptPath, JSON.stringify(receipt, null, 2), 0o600);
    }

    return Object.freeze({
      satisfied: true,
      compensated: true,
    });
  }

  async function inspectCompensation(target) {
    const normalized = normalizeCompensationTarget(target);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;
    const previousReleaseId = normalized.previousReleaseId;

    const appDir = path.join(appRoot, applicationId);
    const releasePath = path.join(appDir, 'releases', deploymentId);
    const currentLink = path.join(appDir, 'current');

    let releaseExists = false;
    try {
      await lstatFn(releasePath);
      releaseExists = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (releaseExists) {
      return Object.freeze({ satisfied: false, reason: 'release_still_exists' });
    }

    if (previousReleaseId) {
      const activeRelease = await readCurrentReleaseId(currentLink);
      if (activeRelease === null) {
        return Object.freeze({ satisfied: false, reason: 'current_link_missing' });
      }
      if (activeRelease !== previousReleaseId) {
        return Object.freeze({ satisfied: false, reason: 'current_link_not_restored' });
      }
    }

    return Object.freeze({
      satisfied: true,
      compensated: true,
    });
  }

  return Object.freeze({
    prepare,
    inspectDeployment,
    compensate,
    inspectCompensation,
  });
}

export const websitePythonReleaseManagerInternals = Object.freeze({
  APP_ROOT,
  DATA_ROOT,
  RECEIPT_ROOT,
  GIT_PATH,
  INSTALL_PATH,
  RUNUSER_PATH,
  CHOWN_PATH,
  safePythonGitEnvironment,
});
