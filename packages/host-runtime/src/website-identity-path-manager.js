import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createWebsiteIdentityManager } from './website-identity-manager.js';
import {
  createWebsitePathContract,
  WebsitePathContractError,
} from './website-path-contract.js';

const execFileAsync = promisify(execFile);
const INSTALL_PATH = '/usr/bin/install';

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

function statMode(value) {
  return Number(value?.mode ?? 0) & 0o777;
}

export function createWebsiteIdentityPathManager({
  identityManager = createWebsiteIdentityManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 128 * 1024,
  }),
  lstatFn = lstat,
} = {}) {
  if (!identityManager
    || typeof identityManager.inspect !== 'function'
    || typeof identityManager.apply !== 'function'
    || typeof identityManager.compensate !== 'function'
    || typeof identityManager.inspectCompensation !== 'function'
    || typeof run !== 'function' || typeof lstatFn !== 'function') {
    throw new WebsiteIdentityPathManagerError('website_identity_path_dependencies_invalid', 'Website identity path manager dependencies are invalid');
  }

  async function inspectWorkspace(contract, identity) {
    if (!contract) return Object.freeze({ satisfied: true, pathContract: null });
    for (const target of workspaceTargets(contract)) {
      let info;
      try { info = await lstatFn(target.directory); }
      catch (error) {
        if (missingFile(error)) {
          return Object.freeze({
            satisfied: false,
            reason: 'website_identity_workspace_missing',
            missingWorkspace: target.name,
          });
        }
        throw new WebsiteIdentityPathManagerError('website_identity_workspace_inspection_failed', 'Website workspace directory could not be inspected');
      }
      if (!info || typeof info.isDirectory !== 'function' || !info.isDirectory()
        || info.uid !== identity.uid || info.gid !== identity.gid || statMode(info) !== target.mode) {
        throw new WebsiteIdentityPathManagerError('website_identity_workspace_drift', 'Website workspace ownership or mode does not match managed state');
      }
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

  async function prepareWorkspace(contract, identity) {
    if (!contract) return;
    for (const target of workspaceTargets(contract)) {
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
    }
  }

  async function apply(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    const identity = await identityManager.apply(normalized.baseIntent, options);
    if (!identity?.satisfied || !normalized.contract) return identity;

    await prepareWorkspace(normalized.contract, identity);
    const verified = await inspect(rawIntent);
    if (!verified?.satisfied) {
      throw new WebsiteIdentityPathManagerError('website_identity_workspace_unverified', 'Website workspace could not be verified after preparation');
    }
    return Object.freeze({
      ...verified,
      created: identity.created,
      receiptVersion: identity.receiptVersion,
    });
  }

  async function compensate(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    return identityManager.compensate(normalized.baseIntent, options);
  }

  async function inspectCompensation(rawIntent, options = {}) {
    const normalized = normalizeIntent(rawIntent);
    return identityManager.inspectCompensation(normalized.baseIntent, options);
  }

  return Object.freeze({ inspect, apply, compensate, inspectCompensation });
}

export const websiteIdentityPathManagerInternals = Object.freeze({
  normalizeIntent,
  modeString,
  contractEvidence,
  workspaceTargets,
});
