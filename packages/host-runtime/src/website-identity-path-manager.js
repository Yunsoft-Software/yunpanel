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

  async function inspectWorkspaceState(contract, identity) {
    if (!contract) return Object.freeze({ satisfied: true, pathContract: null });
    const missingWorkspaces = [];
    for (const target of workspaceTargets(contract)) {
      if (!await inspectTarget(target, identity)) missingWorkspaces.push(target.name);
    }
    if (missingWorkspaces.length > 0) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_identity_workspace_missing',
        missingWorkspace: missingWorkspaces[0],
        missingWorkspaces: Object.freeze(missingWorkspaces),
      });
    }
    return Object.freeze({
      satisfied: true,
      pathContract: contractEvidence(contract),
    });
  }

  async function previewMigration(rawIntent) {
    const normalized = normalizeIntent(rawIntent);
    if (typeof identityManager.previewMigration !== 'function') {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_migration_preview_unavailable',
        'Website Unix identity migration preview is unavailable',
      );
    }
    const preview = await identityManager.previewMigration(normalized.baseIntent);
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_migration_preview_invalid',
        'Website Unix identity migration preview is invalid',
      );
    }
    return Object.freeze({
      ...preview,
      pathContract: contractEvidence(normalized.contract),
    });
  }

  async function inspect(rawIntent) {
    const normalized = normalizeIntent(rawIntent);
    const identity = await identityManager.inspect(normalized.baseIntent);
    if (!identity?.satisfied || !normalized.contract) return identity;

    const workspace = await inspectWorkspaceState(normalized.contract, identity);
    if (!workspace.satisfied) {
      return Object.freeze({
        ...identity,
        satisfied: false,
        reason: workspace.reason,
        missingWorkspace: workspace.missingWorkspace,
        missingWorkspaces: workspace.missingWorkspaces,
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

  function requireWorkspaceIdentity(identity) {
    if (!identity?.satisfied || !Number.isSafeInteger(identity.uid) || identity.uid < 1
      || !Number.isSafeInteger(identity.gid) || identity.gid < 1) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_workspace_identity_required',
        'Canonical Website Unix identity must be satisfied before workspace migration',
      );
    }
    return identity;
  }

  function requireIdentityMigrationScope(normalized) {
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_migration_scope_required',
        'Website Unix identity migration requires canonical Website and Application scope',
      );
    }
    return normalized;
  }

  async function inspectIdentityOperation(rawIntent, options = {}) {
    const normalized = requireIdentityMigrationScope(normalizeIntent(rawIntent));
    if (typeof identityManager.inspectOperation !== 'function') {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_operation_inspection_unavailable',
        'Website Unix identity operation inspection is unavailable',
      );
    }
    const result = await identityManager.inspectOperation(normalized.baseIntent, {
      operationId: normalizeOperationId(options.operationId),
    });
    return Object.freeze({
      ...result,
      pathContract: contractEvidence(normalized.contract),
    });
  }

  async function applyIdentityMigration(rawIntent, options = {}) {
    const normalized = requireIdentityMigrationScope(normalizeIntent(rawIntent));
    const preview = await previewMigration(rawIntent);
    if (preview.satisfied === true) {
      return Object.freeze({
        satisfied: true,
        createdUnixIdentity: false,
        preservedExisting: true,
        pathContract: contractEvidence(normalized.contract),
      });
    }
    if (preview.safeCreateCandidate !== true) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_migration_not_safe_create',
        'Website Unix identity migration is blocked because canonical user, group or HOME state already exists',
      );
    }
    const result = await identityManager.apply(normalized.baseIntent, {
      operationId: normalizeOperationId(options.operationId),
    });
    if (!result?.satisfied || result.created !== true || result.receiptVersion !== 1) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_migration_unverified',
        'Website Unix identity migration did not return durable creation evidence',
      );
    }
    return Object.freeze({
      ...result,
      createdUnixIdentity: true,
      identityReceiptVersion: result.receiptVersion,
      pathContract: contractEvidence(normalized.contract),
    });
  }

  async function compensateIdentityMigration(rawIntent, options = {}) {
    const normalized = requireIdentityMigrationScope(normalizeIntent(rawIntent));
    const result = await identityManager.compensate(normalized.baseIntent, {
      operationId: normalizeOperationId(options.operationId),
      evidence: options.evidence ?? null,
    });
    return Object.freeze({
      ...result,
      pathContract: contractEvidence(normalized.contract),
    });
  }

  async function inspectIdentityMigrationCompensation(rawIntent, options = {}) {
    const normalized = requireIdentityMigrationScope(normalizeIntent(rawIntent));
    const result = await identityManager.inspectCompensation(normalized.baseIntent, {
      operationId: normalizeOperationId(options.operationId),
      evidence: options.evidence ?? null,
    });
    return Object.freeze({
      ...result,
      pathContract: contractEvidence(normalized.contract),
    });
  }

  async function inspectWorkspace(rawIntent) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_scope_required', 'Website workspace migration requires canonical Website and Application scope');
    }
    const identity = requireWorkspaceIdentity(await identityManager.inspect(normalized.baseIntent));
    return inspectWorkspaceState(normalized.contract, identity);
  }

  async function inspectWorkspaceOperation(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_scope_required', 'Website workspace migration requires canonical Website and Application scope');
    }
    const operationId = normalizeOperationId(options.operationId);
    const identity = requireWorkspaceIdentity(await identityManager.inspect(normalized.baseIntent));
    const inspected = await inspectWorkspaceState(normalized.contract, identity);
    if (!inspected.satisfied) return inspected;
    const receipt = await loadReceipt(operationId, normalized);
    if (!receipt) return Object.freeze({ ...inspected, createdWorkspaceDirectories: 0 });
    if (receipt.state === 'compensated') {
      return Object.freeze({ satisfied: false, reason: 'website_identity_workspace_operation_compensated' });
    }
    if (receipt.targets.some((target) => target.state !== 'created')) {
      throw new WebsiteIdentityPathManagerError(
        'website_identity_workspace_ownership_unknown',
        'Website workspace operation completed without durable ownership checkpoints',
      );
    }
    return Object.freeze({
      ...inspected,
      workspaceReceiptVersion: receipt.version,
      createdWorkspaceDirectories: receipt.targets.length,
    });
  }

  async function applyWorkspace(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_scope_required', 'Website workspace migration requires canonical Website and Application scope');
    }
    const operationId = normalizeOperationId(options.operationId);
    const identity = requireWorkspaceIdentity(await identityManager.inspect(normalized.baseIntent));
    const receipt = await prepareWorkspace(normalized, identity, operationId);
    const verified = await inspectWorkspaceState(normalized.contract, identity);
    if (!verified.satisfied) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_unverified', 'Website workspace could not be verified after migration');
    }
    return Object.freeze({
      ...verified,
      workspaceReceiptVersion: receipt.version,
      createdWorkspaceDirectories: receipt.targets.filter((target) => target.state === 'created').length,
    });
  }

  async function inspectWorkspaceCompensation(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_scope_required', 'Website workspace migration requires canonical Website and Application scope');
    }
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
    return Object.freeze({
      satisfied: true,
      workspaceCompensated: true,
      removedWorkspaceDirectories: receipt?.targets.filter((target) => target.state === 'created').length ?? 0,
      preservedUnownedWorkspace: receipt === null,
    });
  }

  async function compensateWorkspace(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_scope_required', 'Website workspace migration requires canonical Website and Application scope');
    }
    const operationId = normalizeOperationId(options.operationId);
    let receipt = await loadReceipt(operationId, normalized);
    if (!receipt) return inspectWorkspaceCompensation(rawIntent, options);
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
      receipt = await persistReceipt({ ...receipt, state: 'compensated' }, normalized);
    }
    return Object.freeze({
      satisfied: true,
      workspaceCompensated: true,
      removedWorkspaceDirectories: receipt.targets.filter((target) => target.state === 'created').length,
      preservedUnownedWorkspace: false,
    });
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
    const workspaceResult = await compensateWorkspace(rawIntent, options);
    const identityResult = await identityManager.compensate(normalized.baseIntent, options);
    if (identityResult?.satisfied !== true) return identityResult;
    if (workspaceResult.preservedUnownedWorkspace) return identityResult;
    return Object.freeze({
      ...identityResult,
      ...workspaceResult,
    });
  }

  async function inspectCompensation(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    if (!normalized.contract) return identityManager.inspectCompensation(normalized.baseIntent, options);
    const workspaceResult = await inspectWorkspaceCompensation(rawIntent, options);
    if (workspaceResult.satisfied !== true) return workspaceResult;
    const identityResult = await identityManager.inspectCompensation(normalized.baseIntent, options);
    if (identityResult?.satisfied !== true) return identityResult;
    if (workspaceResult.preservedUnownedWorkspace) return identityResult;
    return Object.freeze({
      ...identityResult,
      ...workspaceResult,
    });
  }

  return Object.freeze({
    inspect,
    previewMigration,
    apply,
    compensate,
    inspectCompensation,
    inspectIdentityOperation,
    applyIdentityMigration,
    compensateIdentityMigration,
    inspectIdentityMigrationCompensation,
    inspectWorkspace,
    inspectWorkspaceOperation,
    applyWorkspace,
    compensateWorkspace,
    inspectWorkspaceCompensation,
  });
}

export const websiteIdentityPathManagerInternals = Object.freeze({
  normalizeIntent,
  modeString,
  contractEvidence,
  workspaceTargets,
  normalizeOperationId,
  receiptVersion: RECEIPT_VERSION,
});
