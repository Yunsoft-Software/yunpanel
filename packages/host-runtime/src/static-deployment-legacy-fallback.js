import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApplicationIdentity } from './application-identity.js';
import { createStaticDeploymentManager } from './static-deployment-manager.js';

const execFileAsync = promisify(execFile);
const GETENT_PATH = '/usr/bin/getent';
const USERADD_PATH = '/usr/sbin/useradd';
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);

export class StaticDeploymentLegacyFallbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StaticDeploymentLegacyFallbackError';
    this.code = code;
  }
}

function missingGetent(error) {
  return Number.isInteger(error?.code) && error.code === 2;
}

function parsePasswd(stdout, expectedUser) {
  const fields = String(stdout ?? '').trim().split(':');
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (fields.length !== 7 || fields[0] !== expectedUser
    || !Number.isSafeInteger(uid) || uid < 1
    || !Number.isSafeInteger(gid) || gid < 1) {
    throw new StaticDeploymentLegacyFallbackError(
      'legacy_static_identity_invalid',
      'Legacy static Unix identity inspection returned invalid data',
    );
  }
  return Object.freeze({ user: fields[0], uid, gid, homeDirectory: fields[5], shell: fields[6] });
}

function parseGroup(stdout, expectedGroup) {
  const fields = String(stdout ?? '').trim().split(':');
  const gid = Number.parseInt(fields[2], 10);
  if (fields.length !== 4 || fields[0] !== expectedGroup || !Number.isSafeInteger(gid) || gid < 1) {
    throw new StaticDeploymentLegacyFallbackError(
      'legacy_static_identity_invalid',
      'Legacy static Unix group inspection returned invalid data',
    );
  }
  return Object.freeze({
    group: fields[0],
    gid,
    members: Object.freeze(fields[3] ? fields[3].split(',').filter(Boolean) : []),
  });
}

export function createStaticDeploymentLegacyFallback({
  buildRoot = '/var/lib/yunpanel/build',
  webRoot = '/var/www/yunpanel/apps',
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  createLegacyManager = createStaticDeploymentManager,
  ...managerOptions
} = {}) {
  if (typeof run !== 'function' || typeof createLegacyManager !== 'function') {
    throw new StaticDeploymentLegacyFallbackError(
      'legacy_static_dependencies_invalid',
      'Legacy static deployment fallback dependencies are invalid',
    );
  }

  const guardedRun = (file, args, options = {}) => {
    if (file === USERADD_PATH) {
      throw new StaticDeploymentLegacyFallbackError(
        'legacy_static_identity_create_forbidden',
        'Legacy static deployment fallback cannot create Unix identities',
      );
    }
    return run(file, args, options);
  };

  const legacyManager = createLegacyManager({
    buildRoot,
    webRoot,
    run: guardedRun,
    ...managerOptions,
  });
  if (!legacyManager || typeof legacyManager.deployStatic !== 'function') {
    throw new StaticDeploymentLegacyFallbackError(
      'legacy_static_dependencies_invalid',
      'Legacy static deployment fallback manager is invalid',
    );
  }

  async function inspectLegacyIdentity(applicationId) {
    let identity;
    try {
      identity = createApplicationIdentity(applicationId, {
        staticBuildRoot: buildRoot,
        staticPublishRoot: webRoot,
      });
    } catch {
      throw new StaticDeploymentLegacyFallbackError(
        'legacy_static_identity_invalid',
        'Legacy static Application identity is invalid',
      );
    }

    let passwdResult;
    try { passwdResult = await run(GETENT_PATH, ['passwd', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        return Object.freeze({
          eligible: false,
          reason: 'legacy_static_identity_missing',
          applicationId: identity.applicationId,
          unixUser: identity.unixUser,
        });
      }
      throw new StaticDeploymentLegacyFallbackError(
        'legacy_static_identity_inspection_failed',
        'Legacy static Unix identity inspection failed',
      );
    }
    const account = parsePasswd(passwdResult?.stdout, identity.unixUser);
    const expectedHome = path.posix.join(path.posix.resolve(buildRoot), identity.applicationId);
    if (account.homeDirectory !== expectedHome || !NOLOGIN_SHELLS.has(account.shell)) {
      return Object.freeze({
        eligible: false,
        reason: 'legacy_static_identity_drift',
        applicationId: identity.applicationId,
        unixUser: identity.unixUser,
      });
    }

    let groupResult;
    try { groupResult = await run(GETENT_PATH, ['group', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        return Object.freeze({
          eligible: false,
          reason: 'legacy_static_group_missing',
          applicationId: identity.applicationId,
          unixUser: identity.unixUser,
        });
      }
      throw new StaticDeploymentLegacyFallbackError(
        'legacy_static_identity_inspection_failed',
        'Legacy static Unix group inspection failed',
      );
    }
    const group = parseGroup(groupResult?.stdout, identity.unixUser);
    if (group.gid !== account.gid || group.members.length !== 0) {
      return Object.freeze({
        eligible: false,
        reason: 'legacy_static_group_drift',
        applicationId: identity.applicationId,
        unixUser: identity.unixUser,
      });
    }

    return Object.freeze({
      eligible: true,
      reason: null,
      applicationId: identity.applicationId,
      unixUser: identity.unixUser,
      uid: account.uid,
      gid: account.gid,
      homeDirectory: expectedHome,
    });
  }

  async function deployStatic(spec, options = {}) {
    const inspection = await inspectLegacyIdentity(spec?.applicationId);
    if (inspection.eligible !== true) {
      throw new StaticDeploymentLegacyFallbackError(
        inspection.reason ?? 'legacy_static_identity_unproven',
        'Legacy static deployment requires a positively verified pre-existing Unix identity',
      );
    }
    return legacyManager.deployStatic(spec, options);
  }

  return Object.freeze({ deployStatic, inspectLegacyIdentity });
}

export const staticDeploymentLegacyFallbackInternals = Object.freeze({
  missingGetent,
  parsePasswd,
  parseGroup,
  paths: Object.freeze({ GETENT_PATH, USERADD_PATH }),
});
