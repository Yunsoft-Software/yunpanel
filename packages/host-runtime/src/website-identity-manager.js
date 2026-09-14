import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_HOME_ROOT = '/var/lib/yunpanel/data';
const DEFAULT_RECEIPT_ROOT = '/var/lib/yunpanel/staging/website-identities';
const GETENT_PATH = '/usr/bin/getent';
const USERADD_PATH = '/usr/sbin/useradd';
const USERDEL_PATH = '/usr/sbin/userdel';
const GROUPDEL_PATH = '/usr/sbin/groupdel';
const INSTALL_PATH = '/usr/bin/install';
const USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);
const RECEIPT_VERSION = 1;
const MANAGED_HOME_MODE = 0o750;

export class WebsiteIdentityManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteIdentityManagerError';
    this.code = code;
  }
}

function normalizeIntent(value, homeRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['user', 'homeDirectory'].includes(key))) {
    throw new WebsiteIdentityManagerError('website_identity_invalid', 'Website identity intent is invalid');
  }
  if (typeof value.user !== 'string' || !USER_PATTERN.test(value.user)) {
    throw new WebsiteIdentityManagerError('website_identity_user_invalid', 'Website Unix user is invalid');
  }
  if (typeof value.homeDirectory !== 'string' || !path.posix.isAbsolute(value.homeDirectory)) {
    throw new WebsiteIdentityManagerError('website_identity_home_invalid', 'Website home directory is invalid');
  }
  const normalizedRoot = path.posix.resolve(homeRoot);
  const normalizedHome = path.posix.resolve(value.homeDirectory);
  const relative = path.posix.relative(normalizedRoot, normalizedHome);
  if (!UUID_PATTERN.test(relative) || normalizedHome !== path.posix.join(normalizedRoot, relative)) {
    throw new WebsiteIdentityManagerError('website_identity_home_invalid', 'Website home directory is outside the managed application data root');
  }
  return Object.freeze({ user: value.user, homeDirectory: normalizedHome });
}

function normalizeOperationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new WebsiteIdentityManagerError('website_identity_operation_invalid', 'Website identity operation id is invalid');
  }
  return value.toLowerCase();
}

function parsePasswdLine(stdout, expectedUser) {
  const line = String(stdout ?? '').trim();
  const fields = line.split(':');
  if (fields.length !== 7 || fields[0] !== expectedUser) {
    throw new WebsiteIdentityManagerError('website_identity_inspection_invalid', 'Website Unix identity inspection returned invalid data');
  }
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteIdentityManagerError('website_identity_inspection_invalid', 'Website Unix identity ids are invalid');
  }
  return Object.freeze({ user: fields[0], uid, gid, homeDirectory: fields[5], shell: fields[6] });
}

function parseGroupLine(stdout, expectedGroup) {
  const line = String(stdout ?? '').trim();
  const fields = line.split(':');
  if (fields.length !== 4 || fields[0] !== expectedGroup) {
    throw new WebsiteIdentityManagerError('website_identity_group_inspection_invalid', 'Website Unix group inspection returned invalid data');
  }
  const gid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteIdentityManagerError('website_identity_group_inspection_invalid', 'Website Unix group id is invalid');
  }
  const members = fields[3].length === 0 ? [] : fields[3].split(',').filter(Boolean);
  return Object.freeze({ group: fields[0], gid, members: Object.freeze(members) });
}

function receiptValue(value, { operationId, intent } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== RECEIPT_VERSION
    || value.operationId !== operationId
    || value.user !== intent.user
    || value.homeDirectory !== intent.homeDirectory
    || (value.uid !== null && (!Number.isSafeInteger(value.uid) || value.uid < 1))
    || (value.gid !== null && (!Number.isSafeInteger(value.gid) || value.gid < 1))
    || ((value.uid === null) !== (value.gid === null))) {
    throw new WebsiteIdentityManagerError('website_identity_receipt_invalid', 'Website identity ownership receipt is invalid');
  }
  return Object.freeze({
    version: RECEIPT_VERSION,
    operationId,
    user: intent.user,
    homeDirectory: intent.homeDirectory,
    uid: value.uid,
    gid: value.gid,
  });
}

function missingCommandState(error) {
  return Number.isInteger(error?.code) && error.code === 2;
}

function missingFileState(error) {
  return error?.code === 'ENOENT';
}

function modeOf(stat) {
  return Number(stat?.mode ?? 0) & 0o777;
}

export function createWebsiteIdentityManager({
  homeRoot = DEFAULT_HOME_ROOT,
  receiptRoot = DEFAULT_RECEIPT_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: 128 * 1024,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  renameFn = rename,
  rmFn = rm,
  writeFileFn = writeFile,
} = {}) {
  if (typeof homeRoot !== 'string' || !path.posix.isAbsolute(homeRoot)
    || typeof receiptRoot !== 'string' || !path.posix.isAbsolute(receiptRoot)
    || typeof run !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof readFileFn !== 'function'
    || typeof renameFn !== 'function' || typeof rmFn !== 'function'
    || typeof writeFileFn !== 'function') {
    throw new WebsiteIdentityManagerError('website_identity_dependencies_invalid', 'Website identity manager dependencies are invalid');
  }

  function receiptPath(operationId) {
    return path.posix.join(receiptRoot, `${operationId}.json`);
  }

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
    await renameFn(temporaryPath, targetPath);
  }

  async function loadReceipt(operationId, intent) {
    let raw;
    try { raw = await readFileFn(receiptPath(operationId), 'utf8'); }
    catch (error) {
      if (missingFileState(error)) return null;
      throw new WebsiteIdentityManagerError('website_identity_receipt_unavailable', 'Website identity ownership receipt could not be read');
    }
    try { return receiptValue(JSON.parse(raw), { operationId, intent }); }
    catch (error) {
      if (error instanceof WebsiteIdentityManagerError) throw error;
      throw new WebsiteIdentityManagerError('website_identity_receipt_invalid', 'Website identity ownership receipt is invalid');
    }
  }

  async function persistReceipt(operationId, intent, { uid = null, gid = null } = {}) {
    await mkdirFn(receiptRoot, { recursive: true, mode: 0o700 });
    const receipt = {
      version: RECEIPT_VERSION,
      operationId,
      user: intent.user,
      homeDirectory: intent.homeDirectory,
      uid,
      gid,
    };
    await atomicWrite(receiptPath(operationId), `${JSON.stringify(receipt)}\n`, 0o600);
    return receiptValue(receipt, { operationId, intent });
  }

  async function inspectAccount(intent) {
    let result;
    try { result = await run(GETENT_PATH, ['passwd', intent.user], { timeout: 5_000 }); }
    catch (error) {
      if (missingCommandState(error)) return null;
      throw new WebsiteIdentityManagerError('website_identity_inspection_failed', 'Website Unix identity inspection failed');
    }
    const account = parsePasswdLine(result?.stdout, intent.user);
    if (account.homeDirectory !== intent.homeDirectory || !NOLOGIN_SHELLS.has(account.shell)) {
      throw new WebsiteIdentityManagerError('website_identity_drift', 'Existing Website Unix identity does not match managed state');
    }
    return account;
  }

  async function inspectGroup(intent) {
    let result;
    try { result = await run(GETENT_PATH, ['group', intent.user], { timeout: 5_000 }); }
    catch (error) {
      if (missingCommandState(error)) return null;
      throw new WebsiteIdentityManagerError('website_identity_group_inspection_failed', 'Website Unix group inspection failed');
    }
    return parseGroupLine(result?.stdout, intent.user);
  }

  async function inspectHome(intent) {
    let stat;
    try { stat = await lstatFn(intent.homeDirectory); }
    catch (error) {
      if (missingFileState(error)) return null;
      throw new WebsiteIdentityManagerError('website_identity_home_inspection_failed', 'Website home directory could not be inspected');
    }
    if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
      throw new WebsiteIdentityManagerError('website_identity_home_drift', 'Website home path is not a managed directory');
    }
    return Object.freeze({ uid: stat.uid, gid: stat.gid, mode: modeOf(stat) });
  }

  async function inspect(rawIntent) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    const account = await inspectAccount(intent);
    if (!account) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_identity_user_missing',
        user: intent.user,
        homeDirectory: intent.homeDirectory,
      });
    }
    const group = await inspectGroup(intent);
    if (!group || group.gid !== account.gid || group.members.length !== 0) {
      throw new WebsiteIdentityManagerError('website_identity_group_drift', 'Website Unix group does not match managed state');
    }
    const home = await inspectHome(intent);
    if (!home) {
      return Object.freeze({
        satisfied: false,
        reason: 'website_identity_home_missing',
        ...account,
      });
    }
    if (home.uid !== account.uid || home.gid !== account.gid || home.mode !== MANAGED_HOME_MODE) {
      throw new WebsiteIdentityManagerError('website_identity_home_drift', 'Website home directory ownership or mode does not match managed state');
    }
    return Object.freeze({ satisfied: true, ...account, homeMode: home.mode });
  }

  async function assertCreationPreconditions(intent) {
    const group = await inspectGroup(intent);
    if (group) {
      throw new WebsiteIdentityManagerError('website_identity_group_conflict', 'Website Unix group already exists without the managed user');
    }
    const home = await inspectHome(intent);
    if (home) {
      throw new WebsiteIdentityManagerError('website_identity_home_conflict', 'Website home directory already exists without the managed user');
    }
  }

  async function checkpointCreatedIdentity(operationId, intent) {
    const account = await inspectAccount(intent);
    const group = await inspectGroup(intent);
    const home = await inspectHome(intent);
    if (!account || !group || !home
      || group.gid !== account.gid || group.members.length !== 0
      || home.uid !== account.uid || home.gid !== account.gid) {
      throw new WebsiteIdentityManagerError('website_identity_create_unverified', 'Website Unix identity ownership could not be verified after creation');
    }
    return persistReceipt(operationId, intent, { uid: account.uid, gid: account.gid });
  }

  async function apply(rawIntent, { operationId: rawOperationId = null } = {}) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    const operationId = rawOperationId === null ? null : normalizeOperationId(rawOperationId);
    const existingAccount = await inspectAccount(intent);
    const receipt = operationId ? await loadReceipt(operationId, intent) : null;

    if (existingAccount) {
      if (receipt && (receipt.uid === null || receipt.gid === null)) {
        throw new WebsiteIdentityManagerError('website_identity_partial_state', 'Website Unix identity exists without a durable ownership checkpoint and requires manual remediation');
      }
      if (receipt && (receipt.uid !== existingAccount.uid || receipt.gid !== existingAccount.gid)) {
        throw new WebsiteIdentityManagerError('website_identity_partial_state', 'Website Unix identity ownership does not match the durable operation receipt');
      }
      const verified = await inspect(intent);
      if (!verified.satisfied) {
        throw new WebsiteIdentityManagerError('website_identity_partial_state', 'Website Unix identity exists without complete managed home state');
      }
      return Object.freeze({
        ...verified,
        created: receipt !== null,
        receiptVersion: receipt?.version ?? null,
      });
    }

    if (!operationId) {
      throw new WebsiteIdentityManagerError('website_identity_operation_required', 'Website identity creation requires a durable operation id');
    }

    if (!receipt) {
      await assertCreationPreconditions(intent);
      await persistReceipt(operationId, intent);
    } else {
      const group = await inspectGroup(intent);
      const home = await inspectHome(intent);
      if (group || home) {
        if (receipt.uid === null || receipt.gid === null) {
          throw new WebsiteIdentityManagerError('website_identity_partial_state', 'Website identity has partial state without a durable ownership checkpoint and requires manual remediation');
        }
        throw new WebsiteIdentityManagerError('website_identity_partial_state', 'Website identity has partial operation-owned state that must be compensated before retry');
      }
    }

    try {
      await run(USERADD_PATH, [
        '--system',
        '--user-group',
        '--home-dir', intent.homeDirectory,
        '--create-home',
        '--shell', '/usr/sbin/nologin',
        intent.user,
      ], { timeout: 15_000 });
    } catch {
      throw new WebsiteIdentityManagerError('website_identity_create_failed', 'Website Unix identity could not be created');
    }

    await checkpointCreatedIdentity(operationId, intent);

    try {
      await run(INSTALL_PATH, ['-d', '-o', intent.user, '-g', intent.user, '-m', '0750', intent.homeDirectory], { timeout: 10_000 });
    } catch {
      throw new WebsiteIdentityManagerError('website_identity_home_prepare_failed', 'Website home directory could not be prepared');
    }
    const verified = await inspect(intent);
    if (!verified.satisfied) {
      throw new WebsiteIdentityManagerError('website_identity_create_unverified', 'Website Unix identity could not be verified after creation');
    }
    return Object.freeze({
      ...verified,
      created: true,
      receiptVersion: RECEIPT_VERSION,
    });
  }

  async function inspectCompensation(rawIntent, {
    operationId: rawOperationId = null,
    evidence = null,
  } = {}) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    const operationId = rawOperationId === null ? null : normalizeOperationId(rawOperationId);
    const receipt = operationId ? await loadReceipt(operationId, intent) : null;

    if (!receipt) {
      if (evidence?.created === true) {
        const account = await inspectAccount(intent);
        if (account) {
          throw new WebsiteIdentityManagerError('website_identity_compensation_receipt_missing', 'Website identity compensation refused without an ownership receipt');
        }
      }
      return Object.freeze({
        satisfied: true,
        removedUser: false,
        ...(evidence?.created === false ? { preservedExisting: true } : { preservedUnownedState: true }),
      });
    }

    const account = await inspectAccount(intent);
    const group = await inspectGroup(intent);
    const home = await inspectHome(intent);

    if (receipt.uid === null || receipt.gid === null) {
      if (account || group || home) {
        throw new WebsiteIdentityManagerError(
          'website_identity_compensation_ownership_unknown',
          'Website identity compensation refused because host state exists without a durable ownership checkpoint',
        );
      }
      return Object.freeze({
        satisfied: true,
        removedUser: true,
        removedGroup: true,
        removedHome: true,
        preservedExisting: false,
      });
    }

    if (account && (account.uid !== receipt.uid || account.gid !== receipt.gid)) {
      throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because account ownership has drifted');
    }
    if (group && (group.gid !== receipt.gid || group.members.length !== 0)) {
      throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because group ownership has drifted');
    }
    if (home && (home.uid !== receipt.uid || home.gid !== receipt.gid)) {
      throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because home ownership has drifted');
    }

    const satisfied = !account && !group && !home;
    return Object.freeze({
      satisfied,
      ...(satisfied ? {} : { reason: 'website_identity_compensation_pending' }),
      removedUser: !account,
      removedGroup: !group,
      removedHome: !home,
      uid: receipt.uid,
      gid: receipt.gid,
      preservedExisting: false,
    });
  }

  async function compensate(rawIntent, {
    operationId: rawOperationId,
    evidence = null,
  } = {}) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    const operationId = normalizeOperationId(rawOperationId);
    const receipt = await loadReceipt(operationId, intent);
    if (!receipt) {
      return inspectCompensation(intent, { operationId, evidence });
    }

    const initial = await inspectCompensation(intent, { operationId, evidence });
    if (initial.satisfied) return initial;
    if (receipt.uid === null || receipt.gid === null) {
      throw new WebsiteIdentityManagerError(
        'website_identity_compensation_ownership_unknown',
        'Website identity compensation refused without a durable ownership checkpoint',
      );
    }

    const account = await inspectAccount(intent);
    if (account) {
      if (receipt.uid !== account.uid || receipt.gid !== account.gid) {
        throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because account ownership has drifted');
      }
      try { await run(USERDEL_PATH, [intent.user], { timeout: 15_000 }); }
      catch {
        if (await inspectAccount(intent)) {
          throw new WebsiteIdentityManagerError('website_identity_compensation_user_failed', 'Website Unix user could not be removed');
        }
      }
    }

    const group = await inspectGroup(intent);
    if (group) {
      if (group.gid !== receipt.gid || group.members.length !== 0) {
        throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because group ownership has drifted');
      }
      try { await run(GROUPDEL_PATH, [intent.user], { timeout: 15_000 }); }
      catch {
        if (await inspectGroup(intent)) {
          throw new WebsiteIdentityManagerError('website_identity_compensation_group_failed', 'Website Unix group could not be removed');
        }
      }
    }

    const home = await inspectHome(intent);
    if (home) {
      if (home.uid !== receipt.uid || home.gid !== receipt.gid) {
        throw new WebsiteIdentityManagerError('website_identity_compensation_drift', 'Website identity compensation refused because home ownership has drifted');
      }
      try { await rmFn(intent.homeDirectory, { recursive: true, force: true }); }
      catch {
        throw new WebsiteIdentityManagerError('website_identity_compensation_home_failed', 'Website home directory could not be removed');
      }
    }

    const verified = await inspectCompensation(intent, { operationId, evidence });
    if (!verified.satisfied) {
      throw new WebsiteIdentityManagerError('website_identity_compensation_unverified', 'Website identity compensation could not be verified');
    }
    return verified;
  }

  return Object.freeze({ inspect, apply, compensate, inspectCompensation });
}

export const websiteIdentityManagerInternals = Object.freeze({
  normalizeIntent,
  normalizeOperationId,
  parsePasswdLine,
  parseGroupLine,
  receiptValue,
  USER_PATTERN,
  UUID_PATTERN,
  receiptVersion: RECEIPT_VERSION,
  managedHomeMode: MANAGED_HOME_MODE,
});
