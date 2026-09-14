import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_HOME_ROOT = '/var/lib/yunpanel/data';
const GETENT_PATH = '/usr/bin/getent';
const USERADD_PATH = '/usr/sbin/useradd';
const INSTALL_PATH = '/usr/bin/install';
const USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOLOGIN_SHELLS = new Set(['/usr/sbin/nologin', '/sbin/nologin']);

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

export function createWebsiteIdentityManager({
  homeRoot = DEFAULT_HOME_ROOT,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: 128 * 1024,
  }),
} = {}) {
  if (typeof homeRoot !== 'string' || !path.posix.isAbsolute(homeRoot) || typeof run !== 'function') {
    throw new WebsiteIdentityManagerError('website_identity_dependencies_invalid', 'Website identity manager dependencies are invalid');
  }

  async function inspect(rawIntent) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    let result;
    try {
      result = await run(GETENT_PATH, ['passwd', intent.user], { timeout: 5_000 });
    } catch (error) {
      if (Number.isInteger(error?.code) && error.code !== 2) {
        throw new WebsiteIdentityManagerError('website_identity_inspection_failed', 'Website Unix identity inspection failed');
      }
      return Object.freeze({ satisfied: false, user: intent.user, homeDirectory: intent.homeDirectory });
    }
    const account = parsePasswdLine(result?.stdout, intent.user);
    if (account.homeDirectory !== intent.homeDirectory || !NOLOGIN_SHELLS.has(account.shell)) {
      throw new WebsiteIdentityManagerError('website_identity_drift', 'Existing Website Unix identity does not match managed state');
    }
    return Object.freeze({ satisfied: true, ...account });
  }

  async function apply(rawIntent) {
    const intent = normalizeIntent(rawIntent, homeRoot);
    const existing = await inspect(intent);
    if (!existing.satisfied) {
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
    }
    try {
      await run(INSTALL_PATH, ['-d', '-o', intent.user, '-g', intent.user, '-m', '0750', intent.homeDirectory], { timeout: 10_000 });
    } catch {
      throw new WebsiteIdentityManagerError('website_identity_home_prepare_failed', 'Website home directory could not be prepared');
    }
    const verified = await inspect(intent);
    if (!verified.satisfied) {
      throw new WebsiteIdentityManagerError('website_identity_create_unverified', 'Website Unix identity could not be verified after creation');
    }
    return verified;
  }

  return Object.freeze({ inspect, apply });
}

export const websiteIdentityManagerInternals = Object.freeze({
  normalizeIntent,
  parsePasswdLine,
  USER_PATTERN,
  UUID_PATTERN,
});
