import { createHash } from 'node:crypto';
import path from 'node:path';

const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PHP_VERSION = '8.3';

export class ElFinderFpmTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderFpmTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ElFinderFpmTemplateError('elfinder_fpm_identity_invalid', `${field} is invalid`);
  }
  return value.toLowerCase();
}

function applicationUser(applicationId) {
  return `yunapp-${sha256(applicationId).slice(0, 12)}`;
}

function exactManagedUser(value, applicationId, field) {
  if (typeof value !== 'string' || !APP_USER_PATTERN.test(value)
    || value !== applicationUser(applicationId)) {
    throw new ElFinderFpmTemplateError(
      'elfinder_fpm_site_user_invalid',
      `${field} does not match the canonical Website identity`,
    );
  }
  return value;
}

function safePath(value, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)
    || path.posix.normalize(value) !== value || value === '/'
    || value.includes('/../') || value.endsWith('/..')) {
    throw new ElFinderFpmTemplateError('elfinder_fpm_path_invalid', `${field} is invalid`);
  }
  return value;
}

function expectedHome(applicationId) {
  return `/var/lib/yunpanel/data/${applicationId}`;
}

export const elFinderFpmTemplatePolicy = Object.freeze({
  phpVersion: PHP_VERSION,
  poolDirectory: '/etc/php/8.3/fpm/pool.d',
  socketDirectory: '/run/php',
  serviceUnit: 'php8.3-fpm.service',
  sharedApplicationRoot: '/usr/share/yunpanel/elfinder',
  connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
  socketOwner: 'www-data',
  socketGroup: 'www-data',
  socketMode: '0660',
  poolMode: 0o600,
  uploadLimit: '128M',
  disabledFunctions: Object.freeze([
    'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen', 'pcntl_exec',
  ]),
});

export function elFinderFpmPoolName(unixUser) {
  if (typeof unixUser !== 'string' || !APP_USER_PATTERN.test(unixUser)) {
    throw new ElFinderFpmTemplateError('elfinder_fpm_site_user_invalid', 'unixUser is invalid');
  }
  return `yunpanel-elfinder-${unixUser}`;
}

export function elFinderFpmPoolPath(unixUser) {
  return path.posix.join(
    elFinderFpmTemplatePolicy.poolDirectory,
    `${elFinderFpmPoolName(unixUser)}.conf`,
  );
}

export function elFinderFpmSocketPath(unixUser) {
  return path.posix.join(
    elFinderFpmTemplatePolicy.socketDirectory,
    `${elFinderFpmPoolName(unixUser)}.sock`,
  );
}

export function renderElFinderFpmPool({
  websiteId,
  applicationId,
  unixUser,
  unixGroup = unixUser,
  homeDirectory,
  temporaryDirectory,
  sharedApplicationRoot = elFinderFpmTemplatePolicy.sharedApplicationRoot,
} = {}) {
  const normalizedWebsiteId = uuid(websiteId, 'websiteId');
  const normalizedApplicationId = uuid(applicationId, 'applicationId');
  const user = exactManagedUser(unixUser, normalizedApplicationId, 'unixUser');
  const group = exactManagedUser(unixGroup, normalizedApplicationId, 'unixGroup');
  if (user !== group) {
    throw new ElFinderFpmTemplateError(
      'elfinder_fpm_site_group_invalid',
      'elFinder Website user and group must match',
    );
  }

  const home = safePath(homeDirectory, 'homeDirectory');
  const expected = expectedHome(normalizedApplicationId);
  if (home !== expected) {
    throw new ElFinderFpmTemplateError(
      'elfinder_fpm_home_invalid',
      'elFinder root must equal the canonical Website HOME/SFTP root',
    );
  }
  const temp = safePath(temporaryDirectory, 'temporaryDirectory');
  if (temp !== `${home}/tmp`) {
    throw new ElFinderFpmTemplateError(
      'elfinder_fpm_temp_invalid',
      'elFinder temporary directory must stay inside the Website HOME',
    );
  }
  const sharedRoot = safePath(sharedApplicationRoot, 'sharedApplicationRoot');
  if (sharedRoot !== elFinderFpmTemplatePolicy.sharedApplicationRoot) {
    throw new ElFinderFpmTemplateError(
      'elfinder_fpm_shared_root_invalid',
      'elFinder must use the packaged shared application root',
    );
  }

  const poolName = elFinderFpmPoolName(user);
  const socketPath = elFinderFpmSocketPath(user);
  const openBasedir = `${home}:${sharedRoot}`;
  const disabled = elFinderFpmTemplatePolicy.disabledFunctions.join(',');

  return `[${poolName}]
user = ${user}
group = ${group}
listen = ${socketPath}
listen.owner = ${elFinderFpmTemplatePolicy.socketOwner}
listen.group = ${elFinderFpmTemplatePolicy.socketGroup}
listen.mode = ${elFinderFpmTemplatePolicy.socketMode}
pm = ondemand
pm.max_children = 4
pm.process_idle_timeout = 10s
pm.max_requests = 300
clear_env = yes
catch_workers_output = no
security.limit_extensions = .php
chdir = ${home}
env[HOME] = ${home}
env[YUNPANEL_ELFINDER_ROOT] = ${home}
env[YUNPANEL_ELFINDER_WEBSITE_ID] = ${normalizedWebsiteId}
env[YUNPANEL_ELFINDER_APPLICATION_ID] = ${normalizedApplicationId}
env[YUNPANEL_ELFINDER_UNIX_USER] = ${user}
php_admin_value[open_basedir] = ${openBasedir}
php_admin_value[sys_temp_dir] = ${temp}
php_admin_value[upload_tmp_dir] = ${temp}
php_admin_value[session.save_path] = ${temp}
php_admin_value[upload_max_filesize] = ${elFinderFpmTemplatePolicy.uploadLimit}
php_admin_value[post_max_size] = ${elFinderFpmTemplatePolicy.uploadLimit}
php_admin_value[disable_functions] = ${disabled}
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
php_admin_flag[expose_php] = off
php_admin_flag[session.use_strict_mode] = on
php_admin_flag[session.cookie_secure] = on
php_admin_flag[session.cookie_httponly] = on
php_admin_value[session.cookie_samesite] = Strict
; managed by YunPanel elFinder Website connector
`;
}

export function previewElFinderFpmPool(input = {}) {
  const content = renderElFinderFpmPool(input);
  const normalizedApplicationId = uuid(input.applicationId, 'applicationId');
  const user = exactManagedUser(input.unixUser, normalizedApplicationId, 'unixUser');
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    phpVersion: PHP_VERSION,
    poolName: elFinderFpmPoolName(user),
    socketPath: elFinderFpmSocketPath(user),
    serviceUnit: elFinderFpmTemplatePolicy.serviceUnit,
    runtimeUser: user,
    runtimeGroup: user,
    root: expectedHome(normalizedApplicationId),
    connectorPath: elFinderFpmTemplatePolicy.connectorPath,
    sha256: digest,
    artifact: Object.freeze({
      path: elFinderFpmPoolPath(user),
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: elFinderFpmTemplatePolicy.poolMode,
    }),
  });
}

export const elFinderFpmTemplateInternals = Object.freeze({
  applicationUser,
  expectedHome,
  safePath,
  uuid,
  sha256,
});
