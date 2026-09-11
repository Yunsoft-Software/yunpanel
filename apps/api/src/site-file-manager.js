import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SiteFileWorkerError } from './site-file-worker.js';

const execFileAsync = promisify(execFile);
const RUNUSER_PATH = '/usr/sbin/runuser';
const WORKER_PATH = fileURLToPath(new URL('./site-file-worker.js', import.meta.url));
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WORKER_BUFFER = 24 * 1024 * 1024;

export class SiteFileManagerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteFileManagerError';
    this.code = code;
    this.status = status;
  }
}

function appUnixUser(applicationId) {
  return `yunapp-${createHash('sha256').update(applicationId.toLowerCase()).digest('hex').slice(0, 12)}`;
}

function parseManagedAccount(passwdText, user) {
  if (typeof passwdText !== 'string' || !APP_USER_PATTERN.test(user)) {
    throw new SiteFileManagerError('site_file_account_invalid', 'Website file account is invalid', 409);
  }
  const matches = passwdText.split('\n').filter((line) => line.startsWith(`${user}:`));
  const fields = matches.length === 1 ? matches[0].split(':') : [];
  if (fields.length !== 7 || !/^[1-9][0-9]{0,9}$/.test(fields[2] ?? '') || !/^[1-9][0-9]{0,9}$/.test(fields[3] ?? '')) {
    throw new SiteFileManagerError('site_file_account_missing', 'Website file account is unavailable', 409);
  }
  return Object.freeze({ user, home: fields[5] });
}

function validateWebsite(website, localServerId) {
  if (!website) throw new SiteFileManagerError('website_not_found', 'Website not found', 404);
  if (!localServerId) throw new SiteFileManagerError('site_files_local_runtime_required', 'Site files require the active local server', 503);
  if (website.serverId !== localServerId) throw new SiteFileManagerError('site_files_remote_unsupported', 'Remote Website files are not supported', 409);
  if (!['static', 'node'].includes(website.runtimeType) || !UUID_PATTERN.test(website.applicationId ?? '')) {
    throw new SiteFileManagerError('site_files_unsupported', 'This Website does not have managed site files', 409);
  }
  const applicationId = website.applicationId.toLowerCase();
  const storageRoot = website.runtimeType === 'static' ? '/var/www/yunpanel/apps' : '/var/lib/yunpanel/apps';
  const current = `${storageRoot}/${applicationId}/current`;
  const user = appUnixUser(applicationId);
  if (website.documentRoot !== current || website.unixUser !== user || !APP_USER_PATTERN.test(user)) {
    throw new SiteFileManagerError('site_files_target_invalid', 'Website file target is outside managed application storage', 409);
  }
  return Object.freeze({ current, applicationId, user });
}

async function resolveRelease(target, dependencies) {
  let info;
  let root;
  try { [info, root] = await Promise.all([dependencies.stat(target.current), dependencies.realpath(target.current)]); }
  catch { throw new SiteFileManagerError('site_files_not_deployed', 'Website does not have an active release', 409); }
  const expected = new RegExp(`^${target.current.slice(0, -'/current'.length)}/releases/([0-9a-f-]{36})$`, 'i');
  const match = expected.exec(root);
  if (!info.isDirectory() || !match || !UUID_PATTERN.test(match[1])) {
    throw new SiteFileManagerError('site_files_release_invalid', 'Website active release escaped managed storage', 409);
  }
  return root;
}

function parseWorkerResult(output) {
  let payload;
  try { payload = JSON.parse(String(output ?? '')); }
  catch { throw new SiteFileManagerError('site_file_worker_failed', 'Site file worker returned an invalid response', 503); }
  if (payload?.ok === true && Object.hasOwn(payload, 'data')) return payload.data;
  if (payload?.ok === false && payload.error && typeof payload.error.code === 'string'
    && typeof payload.error.message === 'string' && Number.isInteger(payload.error.status)) {
    throw new SiteFileManagerError(payload.error.code, payload.error.message, payload.error.status);
  }
  throw new SiteFileManagerError('site_file_worker_failed', 'Site file worker returned an invalid response', 503);
}

async function executeWorker({ user, request }) {
  const options = {
    encoding: 'utf8',
    env: { HOME: '/', LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' },
    input: JSON.stringify(request),
    maxBuffer: MAX_WORKER_BUFFER,
    timeout: 30_000,
  };
  try {
    const result = await execFileAsync(RUNUSER_PATH, ['-u', user, '--', process.execPath, WORKER_PATH], options);
    return parseWorkerResult(result.stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout) return parseWorkerResult(error.stdout);
    throw new SiteFileManagerError('site_file_worker_failed', 'Site file worker could not complete the request', 503);
  }
}

export function createSiteFileManager({
  websiteRegistry,
  localServerId,
  runWorker = executeWorker,
  statFn = stat,
  realpathFn = realpath,
  readPasswd = () => readFile('/etc/passwd', 'utf8'),
  getuid = process.getuid?.bind(process),
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function' || typeof runWorker !== 'function'
    || typeof statFn !== 'function' || typeof realpathFn !== 'function' || typeof readPasswd !== 'function'
    || typeof getuid !== 'function') {
    throw new TypeError('Site file manager dependencies are invalid');
  }
  const applicationLocks = new Map();

  async function locked(applicationId, operation) {
    const previous = applicationLocks.get(applicationId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    applicationLocks.set(applicationId, current);
    try { return await current; }
    finally { if (applicationLocks.get(applicationId) === current) applicationLocks.delete(applicationId); }
  }

  async function execute(websiteId, operation) {
    if (getuid() !== 0) throw new SiteFileManagerError('site_files_root_runtime_required', 'Site files require the root panel service', 503);
    const target = validateWebsite(await websiteRegistry.getWebsite(websiteId), localServerId);
    return locked(target.applicationId, async () => {
      const [root] = await Promise.all([
        resolveRelease(target, { stat: statFn, realpath: realpathFn }),
        readPasswd().then((contents) => parseManagedAccount(contents, target.user)),
      ]);
      try { return await runWorker({ user: target.user, request: { ...operation, root } }); }
      catch (error) {
        if (error instanceof SiteFileManagerError || error instanceof SiteFileWorkerError) throw error;
        throw new SiteFileManagerError('site_file_worker_failed', 'Site file worker could not complete the request', 503);
      }
    });
  }

  return Object.freeze({ execute });
}

export const siteFileManagerInternals = Object.freeze({
  appUnixUser,
  parseManagedAccount,
  parseWorkerResult,
  validateWebsite,
});
