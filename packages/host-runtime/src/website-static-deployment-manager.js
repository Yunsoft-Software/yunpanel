import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeStaticApplicationSpec } from '@yunpanel/shared';
import { createApplicationIdentity } from './application-identity.js';
import { createStaticDeploymentManager } from './static-deployment-manager.js';

const execFileAsync = promisify(execFile);
const GETENT_PATH = '/usr/bin/getent';
const USERADD_PATH = '/usr/sbin/useradd';
const RUNUSER_PATH = '/usr/sbin/runuser';
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);

export class WebsiteStaticDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteStaticDeploymentError';
    this.code = code;
  }
}

function parsePasswd(stdout, expectedUser) {
  const fields = String(stdout ?? '').trim().split(':');
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (fields.length !== 7 || fields[0] !== expectedUser
    || !Number.isSafeInteger(uid) || uid < 1
    || !Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteStaticDeploymentError('website_static_identity_invalid', 'Website static Unix identity inspection returned invalid data');
  }
  return Object.freeze({ user: fields[0], uid, gid, homeDirectory: fields[5], shell: fields[6] });
}

function parseGroup(stdout, expectedGroup) {
  const fields = String(stdout ?? '').trim().split(':');
  const gid = Number.parseInt(fields[2], 10);
  if (fields.length !== 4 || fields[0] !== expectedGroup || !Number.isSafeInteger(gid) || gid < 1) {
    throw new WebsiteStaticDeploymentError('website_static_identity_invalid', 'Website static Unix group inspection returned invalid data');
  }
  const members = fields[3] ? fields[3].split(',').filter(Boolean) : [];
  return Object.freeze({ group: fields[0], gid, members: Object.freeze(members) });
}

function missingGetent(error) {
  return Number.isInteger(error?.code) && error.code === 2;
}

export function createWebsiteStaticDeploymentManager({
  buildRoot = '/var/lib/yunpanel/build',
  webRoot = '/var/www/yunpanel/apps',
  dataRoot = '/var/lib/yunpanel/data',
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10 * 60 * 1000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  }),
  createDeploymentManager = createStaticDeploymentManager,
  recordLog = null,
} = {}) {
  if (typeof run !== 'function' || typeof createDeploymentManager !== 'function'
    || (recordLog !== null && typeof recordLog !== 'function')) {
    throw new WebsiteStaticDeploymentError('website_static_dependencies_invalid', 'Website static deployment dependencies are invalid');
  }

  let activeHome = null;
  async function guardedRun(file, args, options = {}) {
    if (file === USERADD_PATH) {
      throw new WebsiteStaticDeploymentError(
        'website_static_identity_create_forbidden',
        'Website static deployment cannot create Unix identities outside provisioning',
      );
    }
    if (file === RUNUSER_PATH && activeHome) {
      return run(file, args, {
        ...options,
        env: { ...(options.env ?? {}), HOME: activeHome },
      });
    }
    return run(file, args, options);
  }

  const deploymentManager = createDeploymentManager({
    buildRoot,
    webRoot,
    run: guardedRun,
    recordLog,
  });
  if (!deploymentManager || typeof deploymentManager.deployStatic !== 'function') {
    throw new WebsiteStaticDeploymentError('website_static_dependencies_invalid', 'Website static deployment manager is invalid');
  }

  async function inspectIdentity(identity) {
    let passwdResult;
    try { passwdResult = await run(GETENT_PATH, ['passwd', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        throw new WebsiteStaticDeploymentError('website_static_identity_missing', 'Website static Unix identity must be provisioned before deployment');
      }
      throw new WebsiteStaticDeploymentError('website_static_identity_inspection_failed', 'Website static Unix identity inspection failed');
    }
    const account = parsePasswd(passwdResult?.stdout, identity.unixUser);
    if (account.homeDirectory !== identity.paths.workspace.homeDirectory || !NOLOGIN_SHELLS.has(account.shell)) {
      throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix identity does not match the canonical path contract');
    }

    let groupResult;
    try { groupResult = await run(GETENT_PATH, ['group', identity.unixUser], { timeout: 5_000 }); }
    catch (error) {
      if (missingGetent(error)) {
        throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix group is missing');
      }
      throw new WebsiteStaticDeploymentError('website_static_identity_inspection_failed', 'Website static Unix group inspection failed');
    }
    const group = parseGroup(groupResult?.stdout, identity.unixUser);
    if (group.gid !== account.gid || group.members.length !== 0) {
      throw new WebsiteStaticDeploymentError('website_static_identity_drift', 'Website static Unix group does not match the canonical identity');
    }
    return Object.freeze({ account, group });
  }

  async function deployStatic(rawSpec, options = {}) {
    let spec;
    try { spec = normalizeStaticApplicationSpec(rawSpec); }
    catch {
      throw new WebsiteStaticDeploymentError('invalid_static_deployment', 'Static deployment specification is invalid');
    }
    const identity = createApplicationIdentity(spec.applicationId, {
      dataRoot,
      staticBuildRoot: buildRoot,
      staticPublishRoot: webRoot,
    });
    await inspectIdentity(identity);

    activeHome = identity.paths.workspace.homeDirectory;
    try {
      return await deploymentManager.deployStatic(spec, options);
    } finally {
      activeHome = null;
    }
  }

  return Object.freeze({ deployStatic, inspectIdentity });
}

export const websiteStaticDeploymentInternals = Object.freeze({
  parsePasswd,
  parseGroup,
  missingGetent,
  paths: Object.freeze({ GETENT_PATH, USERADD_PATH, RUNUSER_PATH }),
});
