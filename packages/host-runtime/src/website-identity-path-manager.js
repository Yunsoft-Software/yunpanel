import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWebsiteIdentityManager } from './website-identity-manager.js';
import {
  createWebsitePathContract,
  WebsitePathContractError,
} from './website-path-contract.js';

const execFileAsync = promisify(execFile);
const INSTALL_PATH = '/usr/bin/install';
const DEFAULT_RECEIPT_ROOT = '/var/lib/yunpanel/staging/website-identity-paths';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_VERSION = 1;

export class WebsiteIdentityPathManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteIdentityPathManagerError';
    this.code = code;
  }
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.user !== 'string' || typeof value.homeDirectory !== 'string') {
    throw new WebsiteIdentityPathManagerError('website_identity_path_intent_invalid', 'Website identity path intent is invalid');
  }

  const pathBound = value.applicationId !== undefined || value.websiteId !== undefined;
  if (!pathBound) {
    return Object.freeze({
      baseIntent: Object.freeze({ user: value.user, homeDirectory: value.homeDirectory }),
      contract: null,
    });
  }
  if (typeof value.applicationId !== 'string' || typeof value.websiteId !== 'string') {
    throw new WebsiteIdentityPathManagerError('website_identity_path_intent_invalid', 'Website identity path scope requires Website and Application identities');
  }

  let contract;
  try {
    contract = createWebsitePathContract({
      websiteId: value.websiteId,
      applicationId: value.applicationId,
    });
  } catch (error) {
    if (error instanceof WebsitePathContractError) {
      throw new WebsiteIdentityPathManagerError('website_identity_path_intent_invalid', 'Website identity path scope is invalid');
    }
    throw error;
  }
  if (value.homeDirectory !== contract.workspace.homeDirectory) {
    throw new WebsiteIdentityPathManagerError('website_identity_path_drift', 'Website identity home does not match the managed path contract');
  }

  return Object.freeze({
    baseIntent: Object.freeze({ user: value.user, homeDirectory: value.homeDirectory }),
    contract,
  });
}

function modeString(value) {
  return value.toString(8).padStart(4, '0');
}

function contractEvidence(contract) {
  if (!contract) return null;
  return Object.freeze({
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    workspace: contract.workspace,
    backup: contract.backup,
  });
}

function workspaceTargets(contract) {
  if (!contract) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      name: 'temporary',
      directory: contract.workspace.temporaryDirectory,
      mode: contract.workspace.temporaryMode,
    }),
    Object.freeze({
      name: 'logs',
      directory: contract.workspace.logDirectory,
      mode: contract.workspace.logMode,
    }),
  ]);
}

function missingFile(error) {
  return error?.code === 'ENOENT';
}

function normalizeOperationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsiteIdentityPathManagerError('website_identity_path_operation_invalid', 'Website workspace preparation requires a durable operation id');
  }
  return value.toLowerCase();
}

function statMode(value) {
  return Number(value?.mode ?? 0) & 0o777;
}

export function createWebsiteIdentityPathManager({
  identityManager = createWebsiteIdentityManager(),
  receiptRoot = DEFAULT_RECEIPT_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 128 * 1024,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmdirFn = rmdir,
  writeFileFn = writeFile,
} = {}) {
  if (!identityManager
    || typeof identityManager.inspect !== 'function'
    || typeof identityManager.apply !== 'function'
    || typeof identityManager.compensate !== 'function'
    || typeof identityManager.inspectCompensation !== 'function'
    || typeof receiptRoot !== 'string' || !path.posix.isAbsolute(receiptRoot)
    || typeof run !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmdirFn !== 'function'
    || typeof writeFileFn !== 'function') {
    throw new WebsiteIdentityPathManagerError('website_identity_path_dependencies_invalid', 'Website identity path manager dependencies are invalid');
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  function normalizedReceipt(value, operationId, normalized) {
    const expectedTargets = new Map(workspaceTargets(normalized.contract).map((target) => [target.name, target]));
    const allowedFields = new Set([
      'version', 'operationId', 'websiteId', 'applicationId', 'user', 'homeDirectory',
      'uid', 'gid', 'state', 'targets',
    ]);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((field) => !allowedFields.has(field))
      || value.version !== RECEIPT_VERSION
      || value.operationId !== operationId
      || value.websiteId !== normalized.contract.websiteId
      || value.applicationId !== normalized.contract.applicationId
      || value.user !== normalized.baseIntent.user
      || value.homeDirectory !== normalized.baseIntent.homeDirectory
      || !Number.isSafeInteger(value.uid) || value.uid < 1
      || !Number.isSafeInteger(value.gid) || value.gid < 1
      || !['active', 'compensated'].includes(value.state)
      || !Array.isArray(value.targets)) {
      throw new WebsiteIdentityPathManagerError('website_identity_path_receipt_invalid', 'Website workspace ownership receipt is invalid');
    }
    const names = new Set();
    const targets = value.targets.map((target) => {
      const expected = expectedTargets.get(target?.name);
      if (!expected || !target || typeof target !== 'object' || Array.isArray(target)
        || Object.keys(target).some((field) => !['name', 'directory', 'mode', 'state'].includes(field))
        || names.has(target.name)
        || target.directory !== expected.directory || target.mode !== expected.mode
        || !['planned', 'created'].includes(target.state)) {
        throw new WebsiteIdentityPathManagerError('website_identity_path_receipt_invalid', 'Website workspace ownership receipt is invalid');
      }
      names.add(target.name);
      return Object.freeze({
        name: expected.name,
        directory: expected.directory,
        mode: expected.mode,
        state: target.state,
      });
    });
    return Object.freeze({
      version: RECEIPT_VERSION,
      operationId,
      websiteId: normalized.contract.websiteId,
      applicationId: normalized.contract.applicationId,
      user: normalized.baseIntent.user,
      homeDirectory: normalized.baseIntent.homeDirectory,
      uid: value.uid,
      gid: value.gid,
      state: value.state,
      targets: Object.freeze(targets),
    });
  }

  async function persistReceipt(receipt, normalized) {
    const verified = normalizedReceipt(receipt, receipt.operationId, normalized);
    const target = receiptPath(verified.operationId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    await writeFileFn(temporary, `${JSON.stringify(verified)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameFn(temporary, target);
    return verified;
  }

  async function loadReceipt(operationId, normalized) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missingFile(error)) return null;
      throw new WebsiteIdentityPathManagerError('website_identity_path_receipt_unavailable', 'Website workspace ownership receipt could not be read');
    }
    try { return normalizedReceipt(JSON.parse(raw), operationId, normalized); }
    catch (error) {
      if (error instanceof WebsiteIdentityPathManagerError) throw error;
      throw new WebsiteIdentityPathManagerError('website_identity_path_receipt_invalid', 'Website workspace ownership receipt is invalid');
    }
  }

  async function inspectTarget(target, identity) {
    let info;
    try { info = await lstatFn(target.directory); }
    catch (error) {
      if (missingFile(error)) return null;
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_inspection_failed', 'Website workspace directory could not be inspected');
    }
    if (!info || typeof info.isDirectory !== 'function' || !info.isDirectory()
      || info.uid !== identity.uid || info.gid !== identity.gid || statMode(info) !== target.mode) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_drift', 'Website workspace ownership or mode does not match managed state');
    }
    return Object.freeze({ uid: info.uid, gid: info.gid, mode: statMode(info) });
  }

  async function inspectWorkspace(contract, identity) {
    if (!contract) return Object.freeze({ satisfied: true, pathContract: null });
    for (const target of workspaceTargets(contract)) {
      if (!await inspectTarget(target, identity)) return Object.freeze({
        satisfied: false,
        reason: 'website_identity_workspace_missing',
        missingWorkspace: target.name,
      });
    }
    return Object.freeze({
      satisfied: true,
      pathContract: contractEvidence(contract),
    });
  }

  async function inspect(rawIntent) {
    const normalized = normalizeIntent(rawIntent);
    const identity = await identityManager.inspect(normalized.baseIntent);
    if (!identity?.satisfied || !normalized.contract) return identity;

    const workspace = await inspectWorkspace(normalized.contract, identity);
    if (!workspace.satisfied) {
      return Object.freeze({
        ...identity,
        satisfied: false,
        reason: workspace.reason,
        missingWorkspace: workspace.missingWorkspace,
      });
    }
    return Object.freeze({
      ...identity,
      pathContract: workspace.pathContract,
    });
  }

  async function prepareWorkspace(normalized, identity, operationId) {
    if (!normalized.contract) return null;
    let receipt = await loadReceipt(operationId, normalized);
    if (receipt?.state === 'compensated') {
      throw new WebsiteIdentityPathManagerError('website_identity_path_operation_compensated', 'Compensated Website workspace operation cannot be re-applied');
    }
    if (receipt && (receipt.uid !== identity.uid || receipt.gid !== identity.gid)) {
      throw new WebsiteIdentityPathManagerError('website_identity_path_receipt_drift', 'Website workspace identity no longer matches its ownership receipt');
    }
    if (!receipt) {
      const targets = [];
      for (const target of workspaceTargets(normalized.contract)) {
        if (!await inspectTarget(target, identity)) targets.push(Object.freeze({ ...target, state: 'planned' }));
      }
      receipt = await persistReceipt({
        version: RECEIPT_VERSION,
        operationId,
        websiteId: normalized.contract.websiteId,
        applicationId: normalized.contract.applicationId,
        user: normalized.baseIntent.user,
        homeDirectory: normalized.baseIntent.homeDirectory,
        uid: identity.uid,
        gid: identity.gid,
        state: 'active',
        targets,
      }, normalized);
    }

    for (const target of receipt.targets) {
      const current = await inspectTarget(target, identity);
      if (target.state === 'planned' && current) {
        throw new WebsiteIdentityPathManagerError(
          'website_identity_workspace_ownership_unknown',
          'Website workspace directory exists without a durable operation ownership checkpoint',
        );
      }
      if (target.state === 'created') {
        if (!current) {
          throw new WebsiteIdentityPathManagerError('website_identity_workspace_receipt_drift', 'Operation-owned Website workspace directory is missing');
        }
        continue;
      }
      try {
        await run(INSTALL_PATH, [
          '-d',
          '-o', identity.user,
          '-g', identity.user,
          '-m', modeString(target.mode),
          target.directory,
        ], { timeout: 10_000 });
      } catch {
        throw new WebsiteIdentityPathManagerError('website_identity_workspace_prepare_failed', 'Website workspace directory could not be prepared');
      }
      if (!await inspectTarget(target, identity)) {
        throw new WebsiteIdentityPathManagerError('website_identity_workspace_unverified', 'Website workspace could not be verified after preparation');
      }
      receipt = await persistReceipt({
        ...receipt,
        targets: receipt.targets.map((candidate) => candidate.name === target.name
          ? { ...candidate, state: 'created' }
          : candidate),
      }, normalized);
    }
    return receipt;
  }

  async function apply(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    const identity = await identityManager.apply(normalized.baseIntent, options);
    if (!identity?.satisfied || !normalized.contract) return identity;

    const operationId = normalizeOperationId(options.operationId);
    const receipt = await prepareWorkspace(normalized, identity, operationId);
    const verified = await inspect(rawIntent);
    if (!verified?.satisfied) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_unverified', 'Website workspace could not be verified after preparation');
    }
    return Object.freeze({
      ...verified,
      created: identity.created,
      receiptVersion: identity.receiptVersion,
      workspaceReceiptVersion: receipt.version,
      createdWorkspaceDirectories: receipt.targets.filter((target) => target.state === 'created').length,
    });
  }

  async function compensate(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) return identityManager.compensate(normalized.baseIntent, options);
    const operationId = normalizeOperationId(options.operationId);
    let receipt = await loadReceipt(operationId, normalized);
    if (!receipt) return identityManager.compensate(normalized.baseIntent, options);
    if (receipt.state !== 'compensated') {
      const identity = Object.freeze({ uid: receipt.uid, gid: receipt.gid });
      for (const target of [...receipt.targets].reverse()) {
        const current = await inspectTarget(target, identity);
        if (!current) continue;
        if (target.state !== 'created') {
          throw new WebsiteIdentityPathManagerError(
            'website_identity_workspace_ownership_unknown',
            'Website workspace compensation refused without a durable ownership checkpoint',
          );
        }
        try { await rmdirFn(target.directory); }
        catch (error) {
          if (missingFile(error)) continue;
          if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) {
            throw new WebsiteIdentityPathManagerError(
              'website_identity_workspace_compensation_not_empty',
              'Operation-owned Website workspace directory is not empty and will not be removed recursively',
            );
          }
          throw new WebsiteIdentityPathManagerError('website_identity_workspace_compensation_failed', 'Operation-owned Website workspace directory could not be removed');
        }
      }
    }
    const identityResult = await identityManager.compensate(normalized.baseIntent, options);
    if (identityResult?.satisfied !== true) return identityResult;
    if (receipt.state !== 'compensated') receipt = await persistReceipt({ ...receipt, state: 'compensated' }, normalized);
    return Object.freeze({
      ...identityResult,
      workspaceCompensated: true,
      removedWorkspaceDirectories: receipt.targets.filter((target) => target.state === 'created').length,
    });
  }

  async function inspectCompensation(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) return identityManager.inspectCompensation(normalized.baseIntent, options);
    const operationId = normalizeOperationId(options.operationId);
    const receipt = await loadReceipt(operationId, normalized);
    if (receipt?.state !== 'compensated') {
      const identity = receipt ? Object.freeze({ uid: receipt.uid, gid: receipt.gid }) : null;
      for (const target of receipt?.targets ?? []) {
        const current = await inspectTarget(target, identity);
        if (!current) continue;
        if (target.state !== 'created') {
          throw new WebsiteIdentityPathManagerError(
            'website_identity_workspace_ownership_unknown',
            'Website workspace compensation cannot be verified without an ownership checkpoint',
          );
        }
        return Object.freeze({
          satisfied: false,
          reason: 'website_identity_workspace_compensation_pending',
          pendingWorkspace: target.name,
        });
      }
    }
    const identityResult = await identityManager.inspectCompensation(normalized.baseIntent, options);
    if (identityResult?.satisfied !== true) return identityResult;
    return Object.freeze({
      ...identityResult,
      workspaceCompensated: true,
      removedWorkspaceDirectories: receipt?.targets.filter((target) => target.state === 'created').length ?? 0,
    });
  }

  return Object.freeze({ inspect, apply, compensate, inspectCompensation });
}

export const websiteIdentityPathManagerInternals = Object.freeze({
  normalizeIntent,
  modeString,
  contractEvidence,
  workspaceTargets,
  normalizeOperationId,
  receiptVersion: RECEIPT_VERSION,
});
