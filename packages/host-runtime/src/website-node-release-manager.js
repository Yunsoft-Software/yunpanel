import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertUuid,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeGithubRepositoryUrl,
  normalizeNodeRuntimeConfig,
} from '@yunpanel/shared';
import { createApplicationIdentity } from './application-identity.js';
import { gitAuthenticationPlan, gitFetchArguments, resolvedGitCommit } from './git-deployment.js';
import { createWebsiteIdentityManager } from './website-identity-manager.js';

const execFileAsync = promisify(execFile);
const RECEIPT_VERSION = 1;
const RECEIPT_ROOT = '/var/lib/yunpanel/staging/node-release';
const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';
const RUNUSER_PATH = '/usr/sbin/runuser';
const INSTALL_PATH = '/usr/bin/install';
const CHOWN_PATH = '/usr/bin/chown';
const GIT_PATH = '/usr/bin/git';
const NODE_PATHS = Object.freeze(['/usr/bin/node']);
const PACKAGE_MANAGER_PATHS = Object.freeze({
  npm: Object.freeze(['/usr/bin/npm', '/usr/local/bin/npm']),
  pnpm: Object.freeze(['/usr/bin/pnpm', '/usr/local/bin/pnpm']),
  yarn: Object.freeze(['/usr/bin/yarn', '/usr/local/bin/yarn']),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);
const RECEIPT_STATES = new Set(['preparing', 'prepared', 'active', 'compensated']);

export class WebsiteNodeReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteNodeReleaseError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

function parseNodeMajor(value) {
  const match = String(value ?? '').trim().match(/^v(\d{1,2})\.\d+\.\d+$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseCurrentRelease(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^releases\/([0-9a-f-]{36})$/i);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

function normalizeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteNodeReleaseError('website_node_release_invalid', 'Passenger Node release specification is invalid');
  }
  const allowed = new Set(['applicationId', 'deploymentId', 'repositoryUrl', 'branch', 'gitTarget', 'runtime', 'retention']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WebsiteNodeReleaseError('website_node_release_invalid', 'Passenger Node release specification contains unsupported fields');
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
    runtime = normalizeNodeRuntimeConfig(value.runtime, { requirePort: false });
  } catch {
    throw new WebsiteNodeReleaseError('website_node_release_invalid', 'Passenger Node release specification is invalid');
  }
  if (runtime.start.mode !== 'node' || !runtime.start.entryFile) {
    throw new WebsiteNodeReleaseError('website_node_release_start_mode_unsupported', 'Passenger Node release requires an explicit Node entry file');
  }
  const retention = Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20
    ? value.retention
    : 5;
  return Object.freeze({ applicationId, deploymentId, repositoryUrl, branch, gitTarget, runtime, retention });
}

function specDigest(spec) {
  return sha256(JSON.stringify({
    version: 1,
    applicationId: spec.applicationId,
    deploymentId: spec.deploymentId,
    repositoryUrl: spec.repositoryUrl,
    branch: spec.branch,
    gitTarget: spec.gitTarget,
    runtime: spec.runtime,
    retention: spec.retention,
  }));
}

function normalizeCompensationTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteNodeReleaseError('website_node_release_compensation_invalid', 'Passenger Node release compensation target is invalid');
  }
  let applicationId;
  let deploymentId;
  let previousReleaseId;
  try {
    applicationId = assertUuid(value.applicationId, 'applicationId');
    deploymentId = assertUuid(value.deploymentId, 'deploymentId');
    previousReleaseId = value.previousReleaseId == null ? null : assertUuid(value.previousReleaseId, 'previousReleaseId');
  } catch {
    throw new WebsiteNodeReleaseError('website_node_release_compensation_invalid', 'Passenger Node release compensation target is invalid');
  }
  if (previousReleaseId === deploymentId) {
    throw new WebsiteNodeReleaseError('website_node_release_compensation_invalid', 'Previous release cannot equal the operation-owned release');
  }
  return Object.freeze({ applicationId, deploymentId, previousReleaseId });
}

function safeBuildEnvironment(homeDirectory, runtimeBin, runtimeMode) {
  return Object.freeze({
    HOME: homeDirectory,
    PATH: `${runtimeBin}:/usr/bin:/bin`,
    CI: '1',
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NODE_ENV: runtimeMode,
  });
}

function installArguments(runtime) {
  if (runtime.packageManager === 'npm') {
    return runtime.installMode === 'ci'
      ? ['ci', '--no-audit', '--no-fund']
      : ['install', '--no-audit', '--no-fund'];
  }
  if (runtime.packageManager === 'pnpm') {
    return runtime.installMode === 'ci' ? ['install', '--frozen-lockfile'] : ['install'];
  }
  return runtime.installMode === 'ci' ? ['install', '--immutable'] : ['install'];
}

function publicReceipt(receipt) {
  return Object.freeze({
    version: receipt.version,
    applicationId: receipt.applicationId,
    deploymentId: receipt.deploymentId,
    releaseId: receipt.deploymentId,
    previousReleaseId: receipt.previousReleaseId,
    specDigest: receipt.specDigest,
    commitSha: receipt.commitSha,
    state: receipt.state,
  });
}

export function createWebsiteNodeReleaseManager({
  receiptRoot = RECEIPT_ROOT,
  managedNodeRoot = MANAGED_NODE_ROOT,
  nodePaths = NODE_PATHS,
  packageManagerPaths = PACKAGE_MANAGER_PATHS,
  websiteIdentityManager = createWebsiteIdentityManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
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
  recordLog = null,
} = {}) {
  if (!websiteIdentityManager || typeof websiteIdentityManager.inspect !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function' || typeof mkdirFn !== 'function'
    || typeof readFileFn !== 'function' || typeof readlinkFn !== 'function' || typeof realpathFn !== 'function'
    || typeof readdirFn !== 'function' || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof symlinkFn !== 'function' || typeof writeFileFn !== 'function'
    || (recordLog !== null && typeof recordLog !== 'function')) {
    throw new WebsiteNodeReleaseError('website_node_release_dependencies_invalid', 'Passenger Node release dependencies are invalid');
  }

  const releaseLocks = new Map();

  async function emitLog(spec, stage, level, message) {
    if (!recordLog) return;
    try { await recordLog({ jobId: spec.deploymentId, stage, level, message }); } catch { /* Logging never owns release state. */ }
  }

  async function runSafe(file, args, options = {}, code = 'website_node_release_command_failed') {
    try { return await run(file, args, options); }
    catch (error) {
      const wrapped = new WebsiteNodeReleaseError(code, 'Passenger Node release command failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function runAsUser(identity, runtimeBin, file, args, options = {}) {
    return runSafe(RUNUSER_PATH, ['-u', identity.unixUser, '--', file, ...args], {
      ...options,
      env: {
        ...safeBuildEnvironment(identity.paths.workspace.homeDirectory, runtimeBin, options.runtimeMode ?? 'production'),
        ...(options.env ?? {}),
      },
    });
  }

  async function inspectIdentity(identity) {
    const evidence = await websiteIdentityManager.inspect({
      user: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
    });
    if (!evidence?.satisfied) {
      throw new WebsiteNodeReleaseError('website_node_release_identity_missing', 'Website Unix identity must be provisioned before Passenger release preparation');
    }
    if (evidence.user !== identity.unixUser
      || evidence.homeDirectory !== identity.paths.workspace.homeDirectory
      || !Number.isSafeInteger(evidence.uid) || evidence.uid < 1
      || !Number.isSafeInteger(evidence.gid) || evidence.gid < 1
      || !NOLOGIN_SHELLS.has(evidence.shell)
      || evidence.homeMode !== 0o750) {
      throw new WebsiteNodeReleaseError('website_node_release_identity_drift', 'Website Unix identity does not match canonical release ownership');
    }
    return evidence;
  }

  async function findNode(spec) {
    const candidates = [
      path.posix.join(managedNodeRoot, `v${spec.runtime.nodeMajor}`, 'bin', 'node'),
      ...nodePaths,
    ];
    for (const candidate of [...new Set(candidates)]) {
      try {
        const result = await run(candidate, ['--version'], { timeout: 5_000 });
        if (parseNodeMajor(result?.stdout) === spec.runtime.nodeMajor) return candidate;
      } catch { /* Continue through fixed allowlisted candidates. */ }
    }
    throw new WebsiteNodeReleaseError('website_node_release_node_missing', 'Requested Node.js runtime is not installed');
  }

  async function findPackageManager(spec, nodeBinary) {
    const runtimeBin = path.posix.dirname(nodeBinary);
    const managedPrefix = `${path.posix.join(managedNodeRoot, `v${spec.runtime.nodeMajor}`)}/`;
    const candidates = nodeBinary.startsWith(managedPrefix)
      ? [path.posix.join(runtimeBin, spec.runtime.packageManager)]
      : packageManagerPaths?.[spec.runtime.packageManager] ?? [];
    for (const candidate of candidates) {
      try {
        await run(candidate, ['--version'], { timeout: 5_000 });
        return candidate;
      } catch { /* Continue through fixed allowlisted candidates. */ }
    }
    throw new WebsiteNodeReleaseError(
      'website_node_release_package_manager_missing',
      `${spec.runtime.packageManager} is not installed for the requested Node.js runtime`,
    );
  }

  function receiptPath(deploymentId) {
    return path.posix.join(receiptRoot, `${deploymentId}.json`);
  }

  function normalizeReceipt(value, spec = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== RECEIPT_VERSION
      || typeof value.applicationId !== 'string' || !UUID_PATTERN.test(value.applicationId)
      || typeof value.deploymentId !== 'string' || !UUID_PATTERN.test(value.deploymentId)
      || typeof value.specDigest !== 'string' || !SHA256_PATTERN.test(value.specDigest)
      || (value.previousReleaseId !== null && (typeof value.previousReleaseId !== 'string' || !UUID_PATTERN.test(value.previousReleaseId)))
      || (value.commitSha !== null && (typeof value.commitSha !== 'string' || !SHA1_PATTERN.test(value.commitSha)))
      || !RECEIPT_STATES.has(value.state)) {
      throw new WebsiteNodeReleaseError('website_node_release_receipt_invalid', 'Passenger Node release receipt is invalid');
    }
    const receipt = Object.freeze({
      version: RECEIPT_VERSION,
      applicationId: value.applicationId.toLowerCase(),
      deploymentId: value.deploymentId.toLowerCase(),
      previousReleaseId: value.previousReleaseId?.toLowerCase() ?? null,
      specDigest: value.specDigest,
      commitSha: value.commitSha?.toLowerCase() ?? null,
      state: value.state,
    });
    if (spec && (receipt.applicationId !== spec.applicationId
      || receipt.deploymentId !== spec.deploymentId
      || receipt.specDigest !== specDigest(spec))) {
      throw new WebsiteNodeReleaseError('website_node_release_receipt_conflict', 'Passenger Node release receipt conflicts with the requested release');
    }
    return receipt;
  }

  async function loadReceipt(deploymentId, spec = null) {
    let raw;
    try { raw = await readFileFn(receiptPath(deploymentId), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsiteNodeReleaseError('website_node_release_receipt_unavailable', 'Passenger Node release receipt could not be read');
    }
    try { return normalizeReceipt(JSON.parse(raw), spec); }
    catch (error) {
      if (error instanceof WebsiteNodeReleaseError) throw error;
      throw new WebsiteNodeReleaseError('website_node_release_receipt_invalid', 'Passenger Node release receipt is invalid');
    }
  }

  async function persistReceipt(receipt, spec = null) {
    const normalized = normalizeReceipt(receipt, spec);
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const target = receiptPath(normalized.deploymentId);
    const temporary = `${target}.${process.pid}.tmp`;
    await rmFn(temporary, { force: true }).catch(() => {});
    try {
      await writeFileFn(temporary, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
      await renameFn(temporary, target);
    } finally {
      await rmFn(temporary, { force: true }).catch(() => {});
    }
    return normalized;
  }

  async function currentRelease(identity) {
    try {
      const target = await readlinkFn(identity.paths.runtime.currentRelease);
      const releaseId = parseCurrentRelease(target);
      if (!releaseId) {
        throw new WebsiteNodeReleaseError('website_node_release_current_invalid', 'Passenger Node current release symlink is invalid');
      }
      return releaseId;
    } catch (error) {
      if (error instanceof WebsiteNodeReleaseError) throw error;
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'EINVAL') {
        throw new WebsiteNodeReleaseError('website_node_release_current_invalid', 'Passenger Node current release path is not a managed symlink');
      }
      throw new WebsiteNodeReleaseError('website_node_release_current_unavailable', 'Passenger Node current release could not be inspected');
    }
  }

  async function releaseEvidence(spec, identity, identityEvidence, releaseId) {
    const releaseRoot = path.posix.join(identity.paths.runtime.releasesDirectory, releaseId);
    let releaseInfo;
    let resolvedRelease;
    try {
      releaseInfo = await lstatFn(releaseRoot);
      resolvedRelease = await realpathFn(releaseRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsiteNodeReleaseError('website_node_release_inspection_failed', 'Passenger Node release could not be inspected');
    }
    if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()
      || releaseInfo.uid !== identityEvidence.uid || releaseInfo.gid !== identityEvidence.gid
      || modeOf(releaseInfo) !== 0o750 || resolvedRelease !== releaseRoot) {
      throw new WebsiteNodeReleaseError('website_node_release_drift', 'Passenger Node release ownership or path has drifted');
    }

    const requestedDocumentRoot = path.posix.join(releaseRoot, spec.runtime.documentRoot);
    let documentInfo;
    let documentRoot;
    try {
      documentInfo = await lstatFn(requestedDocumentRoot);
      documentRoot = await realpathFn(requestedDocumentRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsiteNodeReleaseError('website_node_release_inspection_failed', 'Passenger Node document root could not be inspected');
    }
    if (!documentInfo.isDirectory() || documentInfo.isSymbolicLink()
      || (documentRoot !== releaseRoot && !documentRoot.startsWith(`${releaseRoot}/`))) {
      throw new WebsiteNodeReleaseError('website_node_release_document_root_invalid', 'Passenger Node document root is not a real directory inside the release');
    }

    const startupPath = path.posix.join(documentRoot, spec.runtime.start.entryFile);
    let startupInfo;
    let resolvedStartup;
    try {
      startupInfo = await lstatFn(startupPath);
      if (startupInfo.isSymbolicLink()) {
        throw new WebsiteNodeReleaseError('website_node_release_startup_invalid', 'Passenger Node startup file must not be a symbolic link');
      }
      resolvedStartup = await realpathFn(startupPath);
    } catch (error) {
      if (error instanceof WebsiteNodeReleaseError) throw error;
      if (error?.code === 'ENOENT') return null;
      throw new WebsiteNodeReleaseError('website_node_release_inspection_failed', 'Passenger Node startup file could not be inspected');
    }
    if (!startupInfo.isFile() || !resolvedStartup.startsWith(`${documentRoot}/`)) {
      throw new WebsiteNodeReleaseError('website_node_release_startup_invalid', 'Passenger Node startup file is not a real file inside the application root');
    }

    return Object.freeze({ releaseRoot, documentRoot, startupPath: resolvedStartup });
  }

  async function inspectDeployment(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    const identity = createApplicationIdentity(spec.applicationId);
    const identityEvidence = await inspectIdentity(identity);
    const receipt = await loadReceipt(spec.deploymentId, spec);
    if (!receipt) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_receipt_missing',
        adapter: 'passenger-release',
        applicationId: spec.applicationId,
        deploymentId: spec.deploymentId,
      });
    }
    if (receipt.state === 'compensated') {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_compensated',
        adapter: 'passenger-release',
        applicationId: spec.applicationId,
        deploymentId: spec.deploymentId,
      });
    }
    const currentReleaseId = await currentRelease(identity);
    if (currentReleaseId !== spec.deploymentId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_not_current',
        adapter: 'passenger-release',
        applicationId: spec.applicationId,
        deploymentId: spec.deploymentId,
        currentReleaseId,
        previousReleaseId: receipt.previousReleaseId,
      });
    }
    const release = await releaseEvidence(spec, identity, identityEvidence, spec.deploymentId);
    if (!release || !receipt.commitSha) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_incomplete',
        adapter: 'passenger-release',
        applicationId: spec.applicationId,
        deploymentId: spec.deploymentId,
      });
    }
    const nodeBinary = await findNode(spec);
    return Object.freeze({
      satisfied: true,
      adapter: 'passenger-release',
      applicationId: spec.applicationId,
      deploymentId: spec.deploymentId,
      releaseId: spec.deploymentId,
      previousReleaseId: receipt.previousReleaseId,
      commitSha: receipt.commitSha,
      nodeBinary,
      appRoot: release.documentRoot,
      documentRoot: release.documentRoot,
      startupFile: spec.runtime.start.entryFile,
      unixUser: identity.unixUser,
      homeDirectory: identity.paths.workspace.homeDirectory,
      currentRelease: identity.paths.runtime.currentRelease,
      receiptState: receipt.state,
    });
  }

  async function atomicSwitchCurrent(identity, releaseId, suffix) {
    const current = identity.paths.runtime.currentRelease;
    const temporary = `${current}.${suffix}-${process.pid}`;
    await rmFn(temporary, { force: true });
    await symlinkFn(path.posix.join('releases', releaseId), temporary);
    await renameFn(temporary, current);
  }

  async function removeCurrent(identity) {
    await rmFn(identity.paths.runtime.currentRelease, { force: true });
  }

  async function cleanupOldReleases(identity, { currentReleaseId, previousReleaseId, retention }) {
    let entries;
    try { entries = await readdirFn(identity.paths.runtime.releasesDirectory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      return;
    }
    const releases = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const releasePath = path.posix.join(identity.paths.runtime.releasesDirectory, entry.name.toLowerCase());
      try {
        const info = await lstatFn(releasePath);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        releases.push({ id: entry.name.toLowerCase(), path: releasePath, mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0 });
      } catch { /* Ignore cleanup-only inspection failures. */ }
    }
    releases.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const keep = new Set([currentReleaseId, previousReleaseId].filter(Boolean));
    for (const release of releases) {
      if (keep.size >= retention) break;
      keep.add(release.id);
    }
    for (const release of releases) {
      if (!keep.has(release.id)) await rmFn(release.path, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function prepareUnlocked(spec, options = {}) {
    const identity = createApplicationIdentity(spec.applicationId);
    const identityEvidence = await inspectIdentity(identity);
    const nodeBinary = await findNode(spec);
    const packageManager = await findPackageManager(spec, nodeBinary);
    const runtimeBin = path.posix.dirname(nodeBinary);
    const digest = specDigest(spec);
    let receipt = await loadReceipt(spec.deploymentId, spec);
    let previousReleaseId = receipt?.previousReleaseId ?? await currentRelease(identity);
    let switched = false;
    let privateKeyPath = null;
    let releaseOwned = false;

    if (receipt?.state === 'compensated') {
      throw new WebsiteNodeReleaseError('website_node_release_operation_compensated', 'Compensated Passenger Node release operation cannot be re-applied');
    }
    if (!receipt) {
      receipt = await persistReceipt({
        version: RECEIPT_VERSION,
        applicationId: spec.applicationId,
        deploymentId: spec.deploymentId,
        previousReleaseId,
        specDigest: digest,
        commitSha: null,
        state: 'preparing',
      }, spec);
    }

    const currentBefore = await currentRelease(identity);
    if (currentBefore === spec.deploymentId) {
      const existing = await inspectDeployment(spec);
      if (existing.satisfied === true) {
        if (receipt.state !== 'active') {
          receipt = await persistReceipt({ ...receipt, state: 'active' }, spec);
        }
        return Object.freeze({ ...existing, receiptState: receipt.state });
      }
      throw new WebsiteNodeReleaseError('website_node_release_current_incomplete', 'Current Passenger Node release is incomplete and requires manual recovery');
    }
    if (currentBefore !== previousReleaseId) {
      throw new WebsiteNodeReleaseError('website_node_release_state_drift', 'Passenger Node current release changed after operation receipt creation');
    }

    const releaseDirectory = path.posix.join(identity.paths.runtime.releasesDirectory, spec.deploymentId);
    const privateKeyCandidate = path.posix.join(identity.paths.workspace.homeDirectory, `.yunpanel-git-key-${spec.deploymentId}`);
    let existingRelease = null;
    try { existingRelease = await releaseEvidence(spec, identity, identityEvidence, spec.deploymentId); }
    catch (error) {
      if (error instanceof WebsiteNodeReleaseError && receipt.state === 'preparing') {
        await rmFn(releaseDirectory, { recursive: true, force: true }).catch(() => {});
      } else throw error;
    }

    if (existingRelease && receipt.commitSha && ['prepared', 'active'].includes(receipt.state)) {
      await atomicSwitchCurrent(identity, spec.deploymentId, 'activate');
      switched = true;
      try {
        receipt = await persistReceipt({ ...receipt, state: 'active' }, spec);
      } catch (error) {
        if (previousReleaseId) await atomicSwitchCurrent(identity, previousReleaseId, 'rollback').catch(() => {});
        else await removeCurrent(identity).catch(() => {});
        switched = false;
        throw error;
      }
      await cleanupOldReleases(identity, { currentReleaseId: spec.deploymentId, previousReleaseId, retention: spec.retention });
      return inspectDeployment(spec);
    }

    await runSafe(INSTALL_PATH, ['-d', '-o', 'root', '-g', 'root', '-m', '0755', identity.paths.runtime.applicationRoot]);
    await runSafe(INSTALL_PATH, ['-d', '-o', 'root', '-g', 'root', '-m', '0755', identity.paths.runtime.releasesDirectory]);
    await runSafe(INSTALL_PATH, ['-d', '-o', identity.unixUser, '-g', identity.unixUser, '-m', '0750', releaseDirectory]);
    releaseOwned = true;

    let gitAuthentication;
    try {
      gitAuthentication = gitAuthenticationPlan({
        repositoryUrl: spec.repositoryUrl,
        credential: options.gitCredential ?? null,
        privateKeyPath: privateKeyCandidate,
      });
    } catch {
      throw new WebsiteNodeReleaseError('website_node_release_git_credential_invalid', 'Git deployment credential is invalid');
    }

    try {
      if (gitAuthentication.privateKey) {
        await writeFileFn(privateKeyCandidate, gitAuthentication.privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        privateKeyPath = privateKeyCandidate;
        await runSafe(CHOWN_PATH, [`${identity.unixUser}:${identity.unixUser}`, privateKeyPath], { timeout: 10_000 });
      }

      await emitLog(spec, 'git', 'info', 'Preparing Passenger Node release source.');
      await runAsUser(identity, runtimeBin, GIT_PATH, ['init', '.'], { cwd: releaseDirectory, timeout: 30_000, runtimeMode: spec.runtime.mode });
      await runAsUser(identity, runtimeBin, GIT_PATH, ['remote', 'add', 'origin', gitAuthentication.repositoryUrl], { cwd: releaseDirectory, timeout: 30_000, runtimeMode: spec.runtime.mode });
      await runAsUser(identity, runtimeBin, GIT_PATH, gitFetchArguments(spec.gitTarget, { depth: 1 }), {
        cwd: releaseDirectory,
        timeout: 5 * 60 * 1000,
        runtimeMode: spec.runtime.mode,
        env: gitAuthentication.environment,
      });
      const revision = await runAsUser(identity, runtimeBin, GIT_PATH, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
        cwd: releaseDirectory,
        timeout: 30_000,
        runtimeMode: spec.runtime.mode,
      });
      const commitSha = resolvedGitCommit(revision.stdout, spec.gitTarget);
      if (!commitSha) throw new WebsiteNodeReleaseError('website_node_release_revision_invalid', 'Git returned a revision that does not match the requested target');
      await runAsUser(identity, runtimeBin, GIT_PATH, ['checkout', '--detach', commitSha], {
        cwd: releaseDirectory,
        timeout: 60_000,
        runtimeMode: spec.runtime.mode,
      });
      if (privateKeyPath) {
        await rmFn(privateKeyPath, { force: true });
        privateKeyPath = null;
      }

      const requestedDocumentRoot = path.posix.join(releaseDirectory, spec.runtime.documentRoot);
      let documentInfo;
      let documentRoot;
      try {
        documentInfo = await lstatFn(requestedDocumentRoot);
        documentRoot = await realpathFn(requestedDocumentRoot);
      } catch {
        throw new WebsiteNodeReleaseError('website_node_release_document_root_missing', 'Passenger Node document root does not exist before dependency installation');
      }
      if (!documentInfo.isDirectory() || documentInfo.isSymbolicLink()
        || (documentRoot !== releaseDirectory && !documentRoot.startsWith(`${releaseDirectory}/`))) {
        throw new WebsiteNodeReleaseError('website_node_release_document_root_invalid', 'Passenger Node document root is not a real directory inside the release');
      }

      await emitLog(spec, 'dependencies', 'info', `Installing dependencies with ${spec.runtime.packageManager}.`);
      await runAsUser(identity, runtimeBin, packageManager, installArguments(spec.runtime), {
        cwd: documentRoot,
        timeout: 15 * 60 * 1000,
        runtimeMode: spec.runtime.mode,
      });
      if (spec.runtime.buildScript) {
        await emitLog(spec, 'build', 'info', `Running configured build script ${spec.runtime.buildScript}.`);
        await runAsUser(identity, runtimeBin, packageManager, ['run', spec.runtime.buildScript], {
          cwd: documentRoot,
          timeout: 15 * 60 * 1000,
          runtimeMode: spec.runtime.mode,
        });
      }

      const release = await releaseEvidence(spec, identity, identityEvidence, spec.deploymentId);
      if (!release) {
        throw new WebsiteNodeReleaseError('website_node_release_unverified', 'Passenger Node release files could not be verified after build');
      }
      await rmFn(path.posix.join(releaseDirectory, '.git'), { recursive: true, force: true });

      receipt = await persistReceipt({ ...receipt, commitSha, state: 'prepared' }, spec);
      await atomicSwitchCurrent(identity, spec.deploymentId, 'activate');
      switched = true;
      try {
        receipt = await persistReceipt({ ...receipt, state: 'active' }, spec);
      } catch (error) {
        if (previousReleaseId) await atomicSwitchCurrent(identity, previousReleaseId, 'rollback').catch(() => {});
        else await removeCurrent(identity).catch(() => {});
        switched = false;
        throw error;
      }

      await cleanupOldReleases(identity, { currentReleaseId: spec.deploymentId, previousReleaseId, retention: spec.retention });
      const verified = await inspectDeployment(spec);
      if (!verified.satisfied) throw new WebsiteNodeReleaseError('website_node_release_unverified', 'Passenger Node release did not become the verified current release');
      await emitLog(spec, 'complete', 'info', 'Passenger Node release preparation completed.');
      return verified;
    } catch (error) {
      if (privateKeyPath) await rmFn(privateKeyPath, { force: true }).catch(() => {});
      if (switched) {
        if (previousReleaseId) await atomicSwitchCurrent(identity, previousReleaseId, 'rollback').catch(() => {});
        else await removeCurrent(identity).catch(() => {});
      }
      if (releaseOwned && !switched) await rmFn(releaseDirectory, { recursive: true, force: true }).catch(() => {});
      await emitLog(spec, 'failed', 'error', `Passenger Node release preparation failed with ${error?.code ?? 'website_node_release_failed'}.`);
      if (error instanceof WebsiteNodeReleaseError) throw error;
      throw new WebsiteNodeReleaseError('website_node_release_failed', 'Passenger Node release preparation failed');
    }
  }

  function prepare(rawSpec, options = {}) {
    let spec;
    try { spec = normalizeSpec(rawSpec); }
    catch (error) { return Promise.reject(error); }
    const previous = releaseLocks.get(spec.applicationId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => prepareUnlocked(spec, options));
    let tracked;
    tracked = operation.finally(() => {
      if (releaseLocks.get(spec.applicationId) === tracked) releaseLocks.delete(spec.applicationId);
    });
    releaseLocks.set(spec.applicationId, tracked);
    return tracked;
  }

  async function inspectCompensation(rawTarget) {
    const target = normalizeCompensationTarget(rawTarget);
    const identity = createApplicationIdentity(target.applicationId);
    await inspectIdentity(identity);
    const receipt = await loadReceipt(target.deploymentId);
    if (!receipt || receipt.applicationId !== target.applicationId || receipt.previousReleaseId !== target.previousReleaseId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_compensation_receipt_missing',
        adapter: 'passenger-release',
        ...target,
      });
    }
    const currentReleaseId = await currentRelease(identity);
    let ownedReleaseExists = false;
    try {
      const info = await lstatFn(path.posix.join(identity.paths.runtime.releasesDirectory, target.deploymentId));
      ownedReleaseExists = info.isDirectory() && !info.isSymbolicLink();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new WebsiteNodeReleaseError('website_node_release_inspection_failed', 'Passenger Node compensation release could not be inspected');
    }

    const restored = target.previousReleaseId === null ? currentReleaseId === null : currentReleaseId === target.previousReleaseId;
    if (restored && !ownedReleaseExists) {
      return Object.freeze({
        satisfied: true,
        adapter: 'passenger-release',
        applicationId: target.applicationId,
        deploymentId: target.deploymentId,
        previousReleaseId: target.previousReleaseId,
        currentReleaseId,
        restoredPrevious: target.previousReleaseId !== null,
      });
    }
    if (currentReleaseId === target.deploymentId) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_node_release_compensation_pending',
        adapter: 'passenger-release',
        ...target,
        currentReleaseId,
      });
    }
    return Object.freeze({
      satisfied: false,
      reason: 'website_node_release_compensation_drift',
      adapter: 'passenger-release',
      ...target,
      currentReleaseId,
    });
  }

  async function compensate(rawTarget) {
    const target = normalizeCompensationTarget(rawTarget);
    const before = await inspectCompensation(target);
    if (before.satisfied) return before;
    if (before.reason !== 'website_node_release_compensation_pending') return before;

    const identity = createApplicationIdentity(target.applicationId);
    if (target.previousReleaseId) {
      let previousInfo;
      try { previousInfo = await lstatFn(path.posix.join(identity.paths.runtime.releasesDirectory, target.previousReleaseId)); }
      catch {
        throw new WebsiteNodeReleaseError('website_node_release_compensation_previous_missing', 'Previous Passenger Node release is unavailable for compensation');
      }
      if (!previousInfo.isDirectory() || previousInfo.isSymbolicLink()) {
        throw new WebsiteNodeReleaseError('website_node_release_compensation_previous_invalid', 'Previous Passenger Node release is invalid');
      }
      await atomicSwitchCurrent(identity, target.previousReleaseId, 'compensate');
    } else {
      await removeCurrent(identity);
    }
    await rmFn(path.posix.join(identity.paths.runtime.releasesDirectory, target.deploymentId), { recursive: true, force: true });
    const receipt = await loadReceipt(target.deploymentId);
    if (!receipt) throw new WebsiteNodeReleaseError('website_node_release_compensation_receipt_missing', 'Passenger Node release compensation receipt is unavailable');
    await persistReceipt({ ...receipt, state: 'compensated' });
    const after = await inspectCompensation(target);
    if (!after.satisfied) {
      throw new WebsiteNodeReleaseError('website_node_release_compensation_unverified', 'Passenger Node release compensation could not be verified');
    }
    return after;
  }

  return Object.freeze({
    prepare,
    inspectDeployment,
    compensate,
    inspectCompensation,
  });
}

export const websiteNodeReleaseInternals = Object.freeze({
  normalizeSpec,
  normalizeCompensationTarget,
  specDigest,
  safeBuildEnvironment,
  installArguments,
  parseNodeMajor,
  parseCurrentRelease,
  publicReceipt,
  paths: Object.freeze({
    RECEIPT_ROOT,
    MANAGED_NODE_ROOT,
    RUNUSER_PATH,
    INSTALL_PATH,
    CHOWN_PATH,
    GIT_PATH,
  }),
});
