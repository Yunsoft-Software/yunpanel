import { createHash } from 'node:crypto';
import path from 'node:path';

const MANAGED_IDENTITY = /^yunapp-[a-f0-9]{12}$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SUPPORTED_PHP_VERSION = '8.3';

export class PhpFpmTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpFpmTemplateError';
    this.code = code;
  }
}

function managedIdentity(value, field) {
  if (typeof value !== 'string' || !MANAGED_IDENTITY.test(value)) {
    throw new PhpFpmTemplateError('php_fpm_identity_invalid', `${field} must use a managed Website identity`);
  }
  return value;
}

function safeAbsolutePath(value, field) {
  if (typeof value !== 'string' || !SAFE_ABSOLUTE_PATH.test(value)) {
    throw new PhpFpmTemplateError('php_fpm_path_invalid', `${field} must be a safe absolute path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new PhpFpmTemplateError('php_fpm_path_invalid', `${field} contains unsafe path segments`);
  }
  return value;
}

function phpVersion(value) {
  if (value !== SUPPORTED_PHP_VERSION) {
    throw new PhpFpmTemplateError('php_fpm_version_unsupported', `PHP ${value} is not supported by the distro PHP-FPM adapter`);
  }
  return value;
}

function positiveInteger(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PhpFpmTemplateError('php_fpm_limit_invalid', `${field} is outside the supported range`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const phpFpmTemplatePolicy = Object.freeze({
  phpVersion: SUPPORTED_PHP_VERSION,
  poolDirectory: '/etc/php/8.3/fpm/pool.d',
  socketDirectory: '/run/php',
  serviceUnit: 'php8.3-fpm.service',
  socketOwner: 'www-data',
  socketGroup: 'www-data',
  socketMode: '0660',
  poolMode: 0o600,
  defaultMaxChildren: 8,
  defaultMemoryLimitMb: 256,
  defaultMaxExecutionSeconds: 60,
});

export function phpFpmPoolName(unixUser) {
  return `yunpanel-${managedIdentity(unixUser, 'unixUser')}`;
}

export function phpFpmPoolPath(unixUser) {
  return path.posix.join(phpFpmTemplatePolicy.poolDirectory, `${phpFpmPoolName(unixUser)}.conf`);
}

export function phpFpmSocketPath(unixUser) {
  return path.posix.join(phpFpmTemplatePolicy.socketDirectory, `${phpFpmPoolName(unixUser)}.sock`);
}

export function renderWebsitePhpFpmPool({
  unixUser,
  unixGroup = unixUser,
  phpVersion: requestedPhpVersion = phpFpmTemplatePolicy.phpVersion,
  applicationRoot,
  documentRoot,
  homeDirectory,
  temporaryDirectory,
  logDirectory,
  maxChildren = phpFpmTemplatePolicy.defaultMaxChildren,
  memoryLimitMb = phpFpmTemplatePolicy.defaultMemoryLimitMb,
  maxExecutionSeconds = phpFpmTemplatePolicy.defaultMaxExecutionSeconds,
} = {}) {
  const user = managedIdentity(unixUser, 'unixUser');
  const group = managedIdentity(unixGroup, 'unixGroup');
  if (group !== user) {
    throw new PhpFpmTemplateError('php_fpm_identity_mismatch', 'PHP-FPM Website user and group must use the same dedicated identity');
  }
  const version = phpVersion(requestedPhpVersion);
  const appRoot = safeAbsolutePath(applicationRoot, 'applicationRoot');
  const docRoot = safeAbsolutePath(documentRoot, 'documentRoot');
  const home = safeAbsolutePath(homeDirectory, 'homeDirectory');
  const temp = safeAbsolutePath(temporaryDirectory, 'temporaryDirectory');
  const logs = safeAbsolutePath(logDirectory, 'logDirectory');
  const relativeDocumentRoot = path.posix.relative(appRoot, docRoot);
  if (relativeDocumentRoot.startsWith('..') || path.posix.isAbsolute(relativeDocumentRoot)) {
    throw new PhpFpmTemplateError('php_fpm_document_root_invalid', 'documentRoot must stay inside the managed application root');
  }
  const relativeTemp = path.posix.relative(home, temp);
  const relativeLogs = path.posix.relative(home, logs);
  if (!relativeTemp || relativeTemp.startsWith('..') || path.posix.isAbsolute(relativeTemp)
    || !relativeLogs || relativeLogs.startsWith('..') || path.posix.isAbsolute(relativeLogs)) {
    throw new PhpFpmTemplateError('php_fpm_workspace_invalid', 'PHP-FPM temporary and log directories must stay inside the Website home');
  }

  const children = positiveInteger(maxChildren, 'maxChildren', { min: 1, max: 64 });
  const memory = positiveInteger(memoryLimitMb, 'memoryLimitMb', { min: 64, max: 2048 });
  const execution = positiveInteger(maxExecutionSeconds, 'maxExecutionSeconds', { min: 5, max: 600 });
  const poolName = phpFpmPoolName(user);
  const socketPath = phpFpmSocketPath(user);
  const errorLog = path.posix.join(logs, 'php-error.log');
  const openBasedir = `${appRoot}:${home}`;

  return `[${poolName}]\nuser = ${user}\ngroup = ${group}\nlisten = ${socketPath}\nlisten.owner = ${phpFpmTemplatePolicy.socketOwner}\nlisten.group = ${phpFpmTemplatePolicy.socketGroup}\nlisten.mode = ${phpFpmTemplatePolicy.socketMode}\npm = ondemand\npm.max_children = ${children}\npm.process_idle_timeout = 10s\npm.max_requests = 500\nclear_env = yes\ncatch_workers_output = yes\nsecurity.limit_extensions = .php\nchdir = ${docRoot}\nenv[HOME] = ${home}\nphp_admin_value[open_basedir] = ${openBasedir}\nphp_admin_value[sys_temp_dir] = ${temp}\nphp_admin_value[upload_tmp_dir] = ${temp}\nphp_admin_value[session.save_path] = ${temp}\nphp_admin_flag[log_errors] = on\nphp_admin_flag[display_errors] = off\nphp_admin_value[error_log] = ${errorLog}\nphp_admin_value[memory_limit] = ${memory}M\nphp_admin_value[max_execution_time] = ${execution}\n; managed by YunPanel distro PHP ${version}\n`;
}

export function previewWebsitePhpFpmPool(input = {}) {
  const content = renderWebsitePhpFpmPool(input);
  const user = managedIdentity(input.unixUser, 'unixUser');
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    phpVersion: phpFpmTemplatePolicy.phpVersion,
    poolName: phpFpmPoolName(user),
    socketPath: phpFpmSocketPath(user),
    serviceUnit: phpFpmTemplatePolicy.serviceUnit,
    runtimeUser: user,
    runtimeGroup: user,
    sha256: digest,
    artifact: Object.freeze({
      path: phpFpmPoolPath(user),
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: phpFpmTemplatePolicy.poolMode,
    }),
  });
}

export const phpFpmTemplateInternals = Object.freeze({
  managedIdentity,
  safeAbsolutePath,
  phpVersion,
  positiveInteger,
});
