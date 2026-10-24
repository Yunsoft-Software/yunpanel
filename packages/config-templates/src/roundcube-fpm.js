import { createHash } from 'node:crypto';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class RoundcubeFpmTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeFpmTemplateError';
    this.code = code;
  }
}

function exactIdentity(value, expected, field) {
  if (value !== expected) {
    throw new RoundcubeFpmTemplateError('invalid_roundcube_fpm_identity', `${field} must use the managed Roundcube identity`);
  }
  return value;
}

function safePath(value, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.includes('/../') || value.endsWith('/..')) {
    throw new RoundcubeFpmTemplateError('invalid_roundcube_fpm_path', `${field} is invalid`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const roundcubeFpmTemplatePolicy = Object.freeze({
  phpVersion: '8.3',
  poolName: 'yunpanel-roundcube',
  poolPath: '/etc/php/8.3/fpm/pool.d/yunpanel-roundcube.conf',
  socketPath: '/run/php/yunpanel-roundcube.sock',
  serviceUnit: 'php8.3-fpm.service',
  runtimeUser: 'yunpanel-roundcube',
  runtimeGroup: 'yunpanel-roundcube',
  socketOwner: 'www-data',
  socketGroup: 'www-data',
  poolMode: 0o640,
  socketMode: '0660',
});

export function resolveRoundcubeFpmRuntime(options = {}) {
  const normalizedOptions = typeof options === 'string' ? { phpVersion: options } : (options ?? {});
  const resolvedPhpVersion = String(
    normalizedOptions.phpVersion ?? normalizedOptions.osPlatform?.defaultPhpVersion ?? roundcubeFpmTemplatePolicy.phpVersion,
  );
  const family = normalizedOptions.osPlatform?.family ?? 'debian';
  const remi = Boolean(normalizedOptions.osPlatform?.remi || normalizedOptions.osPlatform?.multiVersion);
  const poolPath = family === 'rhel'
    ? (remi
      ? `/etc/opt/remi/php${resolvedPhpVersion.replaceAll('.', '')}/php-fpm.d/${roundcubeFpmTemplatePolicy.poolName}.conf`
      : `/etc/php-fpm.d/${roundcubeFpmTemplatePolicy.poolName}.conf`)
    : `/etc/php/${resolvedPhpVersion}/fpm/pool.d/${roundcubeFpmTemplatePolicy.poolName}.conf`;
  const socketPath = family === 'rhel'
    ? `/run/php-fpm/${roundcubeFpmTemplatePolicy.poolName}.sock`
    : roundcubeFpmTemplatePolicy.socketPath;
  const serviceUnit = family === 'rhel'
    ? (remi ? `php${resolvedPhpVersion.replaceAll('.', '')}-php-fpm.service` : 'php-fpm.service')
    : `php${resolvedPhpVersion}-fpm.service`;
  const webUser = normalizedOptions.osPlatform?.webUser
    ?? (family === 'rhel' ? 'nginx' : roundcubeFpmTemplatePolicy.socketOwner);
  return Object.freeze({
    phpVersion: resolvedPhpVersion,
    family,
    poolPath,
    socketPath,
    serviceUnit,
    socketOwner: webUser,
    socketGroup: webUser,
  });
}

export function renderRoundcubeFpmPool({
  runtimeUser = roundcubeFpmTemplatePolicy.runtimeUser,
  runtimeGroup = roundcubeFpmTemplatePolicy.runtimeGroup,
  socketOwner,
  socketGroup,
  socketPath,
  temporaryDirectory = '/var/lib/yunpanel/roundcube/tmp',
  phpVersion,
  osPlatform,
} = {}) {
  const runtime = resolveRoundcubeFpmRuntime({ phpVersion, osPlatform });
  const user = exactIdentity(runtimeUser, roundcubeFpmTemplatePolicy.runtimeUser, 'runtimeUser');
  const group = exactIdentity(runtimeGroup, roundcubeFpmTemplatePolicy.runtimeGroup, 'runtimeGroup');
  const owner = exactIdentity(
    socketOwner ?? runtime.socketOwner,
    runtime.socketOwner,
    'socketOwner',
  );
  const socketGroupName = exactIdentity(
    socketGroup ?? runtime.socketGroup,
    runtime.socketGroup,
    'socketGroup',
  );
  const socket = safePath(socketPath ?? runtime.socketPath, 'socketPath');
  if (socket !== runtime.socketPath) {
    throw new RoundcubeFpmTemplateError('invalid_roundcube_fpm_path', 'socketPath must use the managed Roundcube socket');
  }
  const temp = safePath(temporaryDirectory, 'temporaryDirectory');
  return `[${roundcubeFpmTemplatePolicy.poolName}]\nuser = ${user}\ngroup = ${group}\nlisten = ${socket}\nlisten.owner = ${owner}\nlisten.group = ${socketGroupName}\nlisten.mode = ${roundcubeFpmTemplatePolicy.socketMode}\npm = ondemand\npm.max_children = 10\npm.process_idle_timeout = 10s\npm.max_requests = 500\nclear_env = yes\ncatch_workers_output = no\nsecurity.limit_extensions = .php\nphp_admin_value[sys_temp_dir] = ${temp}\nphp_admin_value[upload_tmp_dir] = ${temp}\n`;
}

export function previewRoundcubeFpmPool(input = {}) {
  const runtime = resolveRoundcubeFpmRuntime({
    phpVersion: input.phpVersion,
    osPlatform: input.osPlatform,
  });
  const content = renderRoundcubeFpmPool(input);
  return Object.freeze({
    version: 1,
    sha256: sha256(content),
    artifact: Object.freeze({
      path: runtime.poolPath,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: roundcubeFpmTemplatePolicy.poolMode,
    }),
    socketPath: runtime.socketPath,
    serviceUnit: runtime.serviceUnit,
    runtimeUser: roundcubeFpmTemplatePolicy.runtimeUser,
    runtimeGroup: roundcubeFpmTemplatePolicy.runtimeGroup,
  });
}
