import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  pythonApplicationUser,
  pythonServiceName,
} from '@yunpanel/config-templates';
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WebsitePythonReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsitePythonReleaseError';
    this.code = code;
  }
}

function parseCurrentRelease(linkTarget) {
  if (typeof linkTarget !== 'string') return null;
  const match = linkTarget.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
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
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  symlinkFn = symlink,
  writeFileFn = writeFile,
} = {}) {
  async function prepare(spec, { gitCredential = null } = {}) {
    const normalized = normalizeSpec(spec);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;
    const unixUser = pythonApplicationUser(applicationId);

    const appDir = path.join(appRoot, applicationId);
    const releasesDir = path.join(appDir, 'releases');
    const releasePath = path.join(releasesDir, deploymentId);
    const currentLink = path.join(appDir, 'current');

    let previousReleaseId = null;
    try {
      const link = await readlinkFn(currentLink);
      previousReleaseId = parseCurrentRelease(link);
    } catch {
      // current link may not exist yet
    }

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
    await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

    await mkdirFn(releasesDir, { recursive: true, mode: 0o750 });
    await mkdirFn(releasePath, { recursive: true, mode: 0o750 });

    const authPlan = gitAuthenticationPlan({
      repositoryUrl: normalized.repositoryUrl,
      credential: gitCredential,
    });

    await run(GIT_PATH, ['init'], { cwd: releasePath });
    await run(GIT_PATH, ['remote', 'add', 'origin', authPlan.repositoryUrl], { cwd: releasePath });
    const fetchArgs = gitFetchArguments(normalized.gitTarget, { depth: 1 });
    await run(GIT_PATH, fetchArgs, {
      cwd: releasePath,
      env: { ...process.env, ...authPlan.environment },
    });
    await run(GIT_PATH, ['checkout', '--detach', 'FETCH_HEAD'], { cwd: releasePath });

    const revParseResult = await run(GIT_PATH, ['rev-parse', 'HEAD'], { cwd: releasePath });
    const commit = resolvedGitCommit(revParseResult?.stdout ?? revParseResult, normalized.gitTarget);

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

    // Atomic current symlink update
    const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await symlinkFn(`releases/${deploymentId}`, tempLink);
    await renameFn(tempLink, currentLink);

    receipt.state = 'prepared';
    receipt.commit = commit;
    await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

    return Object.freeze({
      satisfied: true,
      applicationId,
      releaseId: deploymentId,
      previousReleaseId,
      commit,
    });
  }

  async function inspectDeployment(spec) {
    const normalized = normalizeSpec(spec);
    const applicationId = normalized.applicationId;
    const deploymentId = normalized.deploymentId;

    const appDir = path.join(appRoot, applicationId);
    const releasePath = path.join(appDir, 'releases', deploymentId);
    const currentLink = path.join(appDir, 'current');

    try {
      const stats = await lstatFn(releasePath);
      if (!stats.isDirectory()) return Object.freeze({ satisfied: false, reason: 'release_not_directory' });

      const link = await readlinkFn(currentLink);
      const activeRelease = parseCurrentRelease(link);
      if (activeRelease !== deploymentId) {
        return Object.freeze({ satisfied: false, reason: 'current_link_mismatch' });
      }

      return Object.freeze({
        satisfied: true,
        applicationId,
        releaseId: deploymentId,
      });
    } catch {
      return Object.freeze({ satisfied: false, reason: 'release_missing' });
    }
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
      try {
        await lstatFn(previousReleasePath);
        const tempLink = path.join(appDir, `current.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        await symlinkFn(`releases/${previousReleaseId}`, tempLink);
        await renameFn(tempLink, currentLink);
      } catch {
        // Previous release missing
      }
    } else {
      try {
        await rmFn(currentLink, { force: true });
      } catch {
        // Ignore
      }
    }

    try {
      await rmFn(releasePath, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    const receiptPath = path.join(receiptRoot, `${deploymentId}.json`);
    try {
      const receiptContent = await readFileFn(receiptPath, 'utf8');
      const receipt = JSON.parse(receiptContent);
      receipt.state = 'compensated';
      await writeFileFn(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
    } catch {
      // Receipt may not exist
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

    try {
      await lstatFn(releasePath);
      return Object.freeze({ satisfied: false, reason: 'release_still_exists' });
    } catch {
      // Release is removed, good
    }

    if (previousReleaseId) {
      try {
        const link = await readlinkFn(currentLink);
        if (parseCurrentRelease(link) !== previousReleaseId) {
          return Object.freeze({ satisfied: false, reason: 'current_link_not_restored' });
        }
      } catch {
        return Object.freeze({ satisfied: false, reason: 'current_link_missing' });
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
