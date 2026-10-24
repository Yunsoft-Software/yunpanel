import { readFile } from 'node:fs/promises';

const DEFAULT_OS_RELEASE_PATH = '/etc/os-release';
const DEFAULT_PHP_VERSION = '8.3';

const UBUNTU_LTS_RELEASES = Object.freeze({
  '20.04': Object.freeze({ codename: 'focal', defaultPhpVersion: '7.4' }),
  '22.04': Object.freeze({ codename: 'jammy', defaultPhpVersion: '8.1' }),
  '24.04': Object.freeze({ codename: 'noble', defaultPhpVersion: '8.3' }),
});

const DEBIAN_RELEASES = Object.freeze({
  11: Object.freeze({ codename: 'bullseye', defaultPhpVersion: '7.4' }),
  12: Object.freeze({ codename: 'bookworm', defaultPhpVersion: '8.2' }),
});

const RHEL_IDS = new Set(['almalinux', 'rocky', 'rhel', 'centos']);

const RHEL_RELEASES = Object.freeze({
  8: Object.freeze({ defaultPhpVersion: '7.4' }),
  9: Object.freeze({ defaultPhpVersion: '8.1' }),
});

const SUPPORTED_PHP_REPO_PATTERN = /^(?:\s*\d+\s+|\s*deb(?:-src)?\s+(?:\[[^\]]+\]\s+)?|\s*(?:baseurl|mirrorlist)=|\s*)(?:https?:\/\/)?(?:ppa\.launchpad(?:content)?\.net\/ondrej\/php\/ubuntu|packages\.sury\.org\/php|rpms\.remirepo\.net)(?:\/|\s|$)/i;

export class OsPlatformError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OsPlatformError';
    this.code = code;
  }
}

export function parseOsReleaseText(text) {
  const values = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!/[\r\n\0]/.test(value)) {
      values.set(match[1], value);
    }
  }
  const rawId = values.get('ID') ?? null;
  const rawVersionId = values.get('VERSION_ID') ?? null;
  const rawCodename = values.get('VERSION_CODENAME') ?? values.get('UBUNTU_CODENAME') ?? null;
  return Object.freeze({
    id: rawId ? rawId.toLowerCase() : null,
    versionId: rawVersionId,
    codename: rawCodename ? rawCodename.toLowerCase() : null,
  });
}

function extractMajorVersion(versionId) {
  if (typeof versionId !== 'string' || versionId.trim().length === 0) return null;
  const major = versionId.trim().split('.')[0];
  return /^\d+$/.test(major) ? major : null;
}

function matchesMajorVersion(versionId, majorVersion) {
  return versionId === majorVersion || (typeof versionId === 'string' && versionId.startsWith(`${majorVersion}.`));
}

export function normalizeLinuxPlatform(input) {
  const parsed = typeof input === 'string'
    ? parseOsReleaseText(input)
    : {
      id: typeof input?.id === 'string' ? input.id.toLowerCase() : null,
      versionId: typeof input?.versionId === 'string' ? input.versionId : null,
      codename: typeof input?.codename === 'string' ? input.codename.toLowerCase() : null,
    };

  const { id, versionId, codename } = parsed;
  const majorVersion = extractMajorVersion(versionId);

  if (id === 'ubuntu') {
    const release = versionId ? UBUNTU_LTS_RELEASES[versionId] : null;
    const supported = Boolean(release && codename === release.codename);
    return Object.freeze({
      id,
      versionId,
      majorVersion,
      codename,
      family: 'debian',
      supported,
      passengerSupported: supported,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: release?.defaultPhpVersion ?? DEFAULT_PHP_VERSION,
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    });
  }

  if (id === 'debian') {
    const release = majorVersion ? DEBIAN_RELEASES[majorVersion] : null;
    const supported = Boolean(
      release
      && matchesMajorVersion(versionId, majorVersion)
      && codename === release.codename,
    );
    return Object.freeze({
      id,
      versionId,
      majorVersion,
      codename,
      family: 'debian',
      supported,
      passengerSupported: supported,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: release?.defaultPhpVersion ?? DEFAULT_PHP_VERSION,
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    });
  }

  if (id && RHEL_IDS.has(id)) {
    const release = majorVersion ? RHEL_RELEASES[majorVersion] : null;
    const supported = Boolean(release && matchesMajorVersion(versionId, majorVersion));
    return Object.freeze({
      id,
      versionId,
      majorVersion,
      codename,
      family: 'rhel',
      supported,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: release?.defaultPhpVersion ?? '8.1',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    });
  }

  return Object.freeze({
    id,
    versionId,
    majorVersion,
    codename,
    family: 'unknown',
    supported: false,
    passengerSupported: false,
    packageManager: null,
    webUser: 'www-data',
    defaultPhpVersion: DEFAULT_PHP_VERSION,
    nginxSitesAvailableDir: '/etc/nginx/sites-available',
    nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
  });
}

export async function detectLinuxPlatform({
  readFileFn = readFile,
  osReleasePath = DEFAULT_OS_RELEASE_PATH,
} = {}) {
  if (typeof readFileFn !== 'function') {
    throw new OsPlatformError('os_platform_dependencies_invalid', 'OS platform readFileFn dependency is invalid');
  }
  let text;
  try {
    text = await readFileFn(osReleasePath, 'utf8');
  } catch {
    throw new OsPlatformError('os_platform_unavailable', 'Operating system identity could not be inspected');
  }
  return normalizeLinuxPlatform(parseOsReleaseText(text));
}

export function isSupportedPassengerPlatform(input) {
  return normalizeLinuxPlatform(input).passengerSupported;
}

export function resolvePhpFpmServiceUnit(
  phpVersion = DEFAULT_PHP_VERSION,
  { family = 'debian', remi = false, multiVersion = false } = {},
) {
  const version = String(phpVersion ?? DEFAULT_PHP_VERSION);
  if (family === 'rhel') {
    if (remi || multiVersion) {
      return `php${version.replaceAll('.', '')}-php-fpm.service`;
    }
    return 'php-fpm.service';
  }
  return `php${version}-fpm.service`;
}

export function resolvePhpFpmPoolDirectory(
  phpVersion = DEFAULT_PHP_VERSION,
  { family = 'debian', remi = false, multiVersion = false } = {},
) {
  const version = String(phpVersion ?? DEFAULT_PHP_VERSION);
  if (family === 'rhel') {
    if (remi || multiVersion) {
      return `/etc/opt/remi/php${version.replaceAll('.', '')}/php-fpm.d`;
    }
    return '/etc/php-fpm.d';
  }
  return `/etc/php/${version}/fpm/pool.d`;
}

export function resolvePhpFpmSocketDirectory({ family = 'debian' } = {}) {
  return family === 'rhel' ? '/run/php-fpm' : '/run/php';
}

export function resolvePhpFpmBinaryPath(
  phpVersion = DEFAULT_PHP_VERSION,
  { family = 'debian', remi = false, multiVersion = false } = {},
) {
  const version = String(phpVersion ?? DEFAULT_PHP_VERSION);
  if (family === 'rhel') {
    if (remi || multiVersion) {
      return `/opt/remi/php${version.replaceAll('.', '')}/root/usr/sbin/php-fpm`;
    }
    return '/usr/sbin/php-fpm';
  }
  return `/usr/sbin/php-fpm${version}`;
}

export function resolvePhpFpmPackageName(
  phpVersion = DEFAULT_PHP_VERSION,
  { family = 'debian', remi = false, multiVersion = false } = {},
) {
  const version = String(phpVersion ?? DEFAULT_PHP_VERSION);
  if (family === 'rhel') {
    if (remi || multiVersion) {
      return `php${version.replaceAll('.', '')}-php-fpm`;
    }
    return 'php-fpm';
  }
  return `php${version}-fpm`;
}

export function isSupportedPhpRepositoryLine(line) {
  if (typeof line !== 'string' || /[\r\n\0]/.test(line)) return false;
  return SUPPORTED_PHP_REPO_PATTERN.test(line);
}

const RHEL_PACKAGE_OVERRIDES = Object.freeze({
  'docker.io': 'docker-ce',
  'docker-compose-v2': 'docker-compose-plugin',
  cron: 'cronie',
  'redis-server': 'redis',
  'apache2-utils': 'httpd-tools',
  sqlite3: 'sqlite',
  'dovecot-imapd': 'dovecot',
  'dovecot-lmtpd': 'dovecot-pigeonhole',
  'dovecot-sieve': 'dovecot-pigeonhole',
  'dovecot-sqlite': 'dovecot',
  'php-mysql': 'php-mysqlnd',
});

const RHEL_UNIT_OVERRIDES = Object.freeze({
  'cron.service': 'crond.service',
  'redis-server.service': 'redis.service',
});

export function resolveDistroPackageName(packageName, { family = 'debian' } = {}) {
  const pkg = String(packageName ?? '').trim();
  if (family === 'rhel') {
    return RHEL_PACKAGE_OVERRIDES[pkg] ?? pkg;
  }
  return pkg;
}

export function resolveDistroUnitName(unitName, { family = 'debian' } = {}) {
  const unit = String(unitName ?? '').trim();
  if (family === 'rhel') {
    return RHEL_UNIT_OVERRIDES[unit] ?? unit;
  }
  return unit;
}

export function resolvePackageManagerCommands({ family = 'debian' } = {}) {
  if (family === 'rhel') {
    return Object.freeze({
      family: 'rhel',
      queryBinary: '/usr/bin/rpm',
      installBinary: '/usr/bin/dnf',
      groupAddBinary: '/usr/sbin/usermod',
      buildQueryArgs: (packageName) => ['-q', '--qf', 'install ok installed\\t%{VERSION}-%{RELEASE}\\n', packageName],
      buildUpdateArgs: () => ['makecache', '--timer'],
      buildInstallArgs: (packages) => ['install', '-y', ...packages],
      buildGroupAddArgs: (user, group) => ['-aG', group, user],
    });
  }
  return Object.freeze({
    family: 'debian',
    queryBinary: '/usr/bin/dpkg-query',
    installBinary: '/usr/bin/apt-get',
    groupAddBinary: '/usr/sbin/adduser',
    buildQueryArgs: (packageName) => ['-W', '-f=${Status}\t${Version}', packageName],
    buildUpdateArgs: () => ['update'],
    buildInstallArgs: (packages) => ['install', '--yes', '--no-install-recommends', ...packages],
    buildGroupAddArgs: (user, group) => [user, group],
  });
}

export const osPlatformInternals = Object.freeze({
  DEFAULT_OS_RELEASE_PATH,
  DEFAULT_PHP_VERSION,
  UBUNTU_LTS_RELEASES,
  DEBIAN_RELEASES,
  RHEL_RELEASES,
  RHEL_IDS: Object.freeze([...RHEL_IDS]),
  RHEL_PACKAGE_OVERRIDES,
  RHEL_UNIT_OVERRIDES,
  extractMajorVersion,
  matchesMajorVersion,
});
