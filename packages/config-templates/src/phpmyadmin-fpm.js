import { createHash } from 'node:crypto';
import path from 'node:path';
import { phpMyAdminSignonTemplatePolicy } from './phpmyadmin-signon.js';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class PhpMyAdminFpmTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminFpmTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactIdentity(value, expected, field) {
  if (value !== expected) {
    throw new PhpMyAdminFpmTemplateError(
      'invalid_phpmyadmin_fpm_identity',
      `${field} must use the managed phpMyAdmin identity`,
    );
  }
  return value;
}

function exactPath(value, expected, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value
    || value === '/' || value.includes('/../') || value.endsWith('/..') || value !== expected) {
    throw new PhpMyAdminFpmTemplateError(
      'invalid_phpmyadmin_fpm_path',
      `${field} must use the managed phpMyAdmin path`,
    );
  }
  return value;
}

export const phpMyAdminFpmTemplatePolicy = Object.freeze({
  phpVersion: '8.3',
  poolName: 'yunpanel-phpmyadmin',
  poolPath: '/etc/php/8.3/fpm/pool.d/yunpanel-phpmyadmin.conf',
  socketPath: '/run/php/yunpanel-phpmyadmin.sock',
  serviceUnit: 'php8.3-fpm.service',
  runtimeUser: 'yunpanel-phpmyadmin',
  runtimeGroup: 'yunpanel-phpmyadmin',
  socketOwner: 'www-data',
  socketGroup: 'www-data',
  temporaryDirectory: '/var/lib/yunpanel/phpmyadmin/tmp',
  sessionDirectory: '/var/lib/yunpanel/phpmyadmin/sessions',
  poolMode: 0o640,
  socketMode: '0660',
});

export function renderPhpMyAdminFpmPool({
  runtimeUser = phpMyAdminFpmTemplatePolicy.runtimeUser,
  runtimeGroup = phpMyAdminFpmTemplatePolicy.runtimeGroup,
  socketOwner = phpMyAdminFpmTemplatePolicy.socketOwner,
  socketGroup = phpMyAdminFpmTemplatePolicy.socketGroup,
  socketPath = phpMyAdminFpmTemplatePolicy.socketPath,
  temporaryDirectory = phpMyAdminFpmTemplatePolicy.temporaryDirectory,
  sessionDirectory = phpMyAdminFpmTemplatePolicy.sessionDirectory,
} = {}) {
  const user = exactIdentity(runtimeUser, phpMyAdminFpmTemplatePolicy.runtimeUser, 'runtimeUser');
  const group = exactIdentity(runtimeGroup, phpMyAdminFpmTemplatePolicy.runtimeGroup, 'runtimeGroup');
  const owner = exactIdentity(socketOwner, phpMyAdminFpmTemplatePolicy.socketOwner, 'socketOwner');
  const socketGroupName = exactIdentity(socketGroup, phpMyAdminFpmTemplatePolicy.socketGroup, 'socketGroup');
  const socket = exactPath(socketPath, phpMyAdminFpmTemplatePolicy.socketPath, 'socketPath');
  const temp = exactPath(
    temporaryDirectory,
    phpMyAdminFpmTemplatePolicy.temporaryDirectory,
    'temporaryDirectory',
  );
  const sessions = exactPath(
    sessionDirectory,
    phpMyAdminFpmTemplatePolicy.sessionDirectory,
    'sessionDirectory',
  );

  return `[${phpMyAdminFpmTemplatePolicy.poolName}]\nuser = ${user}\ngroup = ${group}\nlisten = ${socket}\nlisten.owner = ${owner}\nlisten.group = ${socketGroupName}\nlisten.mode = ${phpMyAdminFpmTemplatePolicy.socketMode}\npm = ondemand\npm.max_children = 10\npm.process_idle_timeout = 10s\npm.max_requests = 500\nclear_env = yes\ncatch_workers_output = no\nsecurity.limit_extensions = .php\nphp_admin_flag[display_errors] = off\nphp_admin_flag[log_errors] = on\nphp_admin_flag[expose_php] = off\nphp_admin_flag[session.use_strict_mode] = on\nphp_admin_flag[session.cookie_secure] = on\nphp_admin_flag[session.cookie_httponly] = on\nphp_admin_value[session.cookie_samesite] = Strict\nphp_admin_value[session.cookie_path] = ${phpMyAdminSignonTemplatePolicy.gatewayBasePath}\nphp_admin_value[session.save_path] = ${sessions}\nphp_admin_value[sys_temp_dir] = ${temp}\nphp_admin_value[upload_tmp_dir] = ${temp}\nphp_admin_value[upload_max_filesize] = 128M\nphp_admin_value[post_max_size] = 128M\n`;
}

export function previewPhpMyAdminFpmPool(input = {}) {
  const content = renderPhpMyAdminFpmPool(input);
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path: phpMyAdminFpmTemplatePolicy.poolPath,
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: phpMyAdminFpmTemplatePolicy.poolMode,
    }),
    socketPath: phpMyAdminFpmTemplatePolicy.socketPath,
    serviceUnit: phpMyAdminFpmTemplatePolicy.serviceUnit,
    runtimeUser: phpMyAdminFpmTemplatePolicy.runtimeUser,
    runtimeGroup: phpMyAdminFpmTemplatePolicy.runtimeGroup,
    temporaryDirectory: phpMyAdminFpmTemplatePolicy.temporaryDirectory,
    sessionDirectory: phpMyAdminFpmTemplatePolicy.sessionDirectory,
  });
}

export const phpMyAdminFpmTemplateInternals = Object.freeze({ exactIdentity, exactPath, sha256 });
