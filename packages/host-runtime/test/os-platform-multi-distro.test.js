import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  elFinderFpmTemplateInternals,
  previewElFinderFpmPool,
  previewPhpMyAdminFpmPool,
  previewRoundcubeFpmPool,
} from '@yunpanel/config-templates';
import {
  createPassengerManager,
  detectLinuxPlatform,
  isSupportedPassengerPlatform,
  isSupportedPhpRepositoryLine,
  normalizeLinuxPlatform,
  OsPlatformError,
  parseOsReleaseText,
  PassengerManagerError,
  passengerManagerInternals,
  resolvePhpFpmBinaryPath,
  resolvePhpFpmPackageName,
  resolvePhpFpmPoolDirectory,
  resolvePhpFpmServiceUnit,
  resolvePhpFpmSocketDirectory,
} from '../src/index.js';
import { createServiceUmaskManager } from '../src/service-umask-manager.js';

async function withTempOsRelease(content, callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-os-release-'));
  const osReleasePath = path.join(tempDir, 'os-release');
  try {
    await writeFile(osReleasePath, content, { encoding: 'utf8', mode: 0o644 });
    return await callback(osReleasePath, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('detectLinuxPlatform detects Ubuntu LTS 20.04 Focal, 22.04 Jammy, and 24.04 Noble from real os-release files', async () => {
  const ubuntuCases = [
    {
      content: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\nVERSION_CODENAME=focal\n',
      expected: {
        id: 'ubuntu',
        versionId: '20.04',
        majorVersion: '20',
        codename: 'focal',
        family: 'debian',
        supported: true,
        passengerSupported: true,
        packageManager: 'apt',
        webUser: 'www-data',
        defaultPhpVersion: '7.4',
        nginxSitesAvailableDir: '/etc/nginx/sites-available',
        nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
      },
    },
    {
      content: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n',
      expected: {
        id: 'ubuntu',
        versionId: '22.04',
        majorVersion: '22',
        codename: 'jammy',
        family: 'debian',
        supported: true,
        passengerSupported: true,
        packageManager: 'apt',
        webUser: 'www-data',
        defaultPhpVersion: '8.1',
        nginxSitesAvailableDir: '/etc/nginx/sites-available',
        nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
      },
    },
    {
      content: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n',
      expected: {
        id: 'ubuntu',
        versionId: '24.04',
        majorVersion: '24',
        codename: 'noble',
        family: 'debian',
        supported: true,
        passengerSupported: true,
        packageManager: 'apt',
        webUser: 'www-data',
        defaultPhpVersion: '8.3',
        nginxSitesAvailableDir: '/etc/nginx/sites-available',
        nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
      },
    },
  ];

  for (const item of ubuntuCases) {
    await withTempOsRelease(item.content, async (osReleasePath) => {
      const profile = await detectLinuxPlatform({ readFileFn: readFile, osReleasePath });
      assert.deepEqual(profile, item.expected);
    });
  }
});

test('detectLinuxPlatform detects Debian 11 Bullseye and Debian 12 Bookworm from real os-release files', async () => {
  const debianCases = [
    {
      content: 'PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"\nID=debian\nVERSION_ID="11"\nVERSION_CODENAME=bullseye\n',
      expected: {
        id: 'debian',
        versionId: '11',
        majorVersion: '11',
        codename: 'bullseye',
        family: 'debian',
        supported: true,
        passengerSupported: true,
        packageManager: 'apt',
        webUser: 'www-data',
        defaultPhpVersion: '7.4',
        nginxSitesAvailableDir: '/etc/nginx/sites-available',
        nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
      },
    },
    {
      content: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n',
      expected: {
        id: 'debian',
        versionId: '12',
        majorVersion: '12',
        codename: 'bookworm',
        family: 'debian',
        supported: true,
        passengerSupported: true,
        packageManager: 'apt',
        webUser: 'www-data',
        defaultPhpVersion: '8.2',
        nginxSitesAvailableDir: '/etc/nginx/sites-available',
        nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
      },
    },
  ];

  for (const item of debianCases) {
    await withTempOsRelease(item.content, async (osReleasePath) => {
      const profile = await detectLinuxPlatform({ readFileFn: readFile, osReleasePath });
      assert.deepEqual(profile, item.expected);
    });
  }
});

test('detectLinuxPlatform detects AlmaLinux 8/9, Rocky Linux 8/9, RHEL 9, and CentOS 9 from real os-release files', async () => {
  const rhelCases = [
    {
      content: 'NAME="AlmaLinux"\nID="almalinux"\nVERSION_ID="9.4"\n',
      expected: {
        id: 'almalinux',
        versionId: '9.4',
        majorVersion: '9',
        codename: null,
        family: 'rhel',
        supported: true,
        passengerSupported: false,
        packageManager: 'dnf',
        webUser: 'nginx',
        defaultPhpVersion: '8.1',
        nginxSitesAvailableDir: '/etc/nginx/conf.d',
        nginxSitesEnabledDir: '/etc/nginx/conf.d',
      },
    },
    {
      content: 'NAME="Rocky Linux"\nID="rocky"\nVERSION_ID="9.4"\n',
      expected: {
        id: 'rocky',
        versionId: '9.4',
        majorVersion: '9',
        codename: null,
        family: 'rhel',
        supported: true,
        passengerSupported: false,
        packageManager: 'dnf',
        webUser: 'nginx',
        defaultPhpVersion: '8.1',
        nginxSitesAvailableDir: '/etc/nginx/conf.d',
        nginxSitesEnabledDir: '/etc/nginx/conf.d',
      },
    },
    {
      content: 'NAME="AlmaLinux"\nID="almalinux"\nVERSION_ID="8.10"\n',
      expected: {
        id: 'almalinux',
        versionId: '8.10',
        majorVersion: '8',
        codename: null,
        family: 'rhel',
        supported: true,
        passengerSupported: false,
        packageManager: 'dnf',
        webUser: 'nginx',
        defaultPhpVersion: '7.4',
        nginxSitesAvailableDir: '/etc/nginx/conf.d',
        nginxSitesEnabledDir: '/etc/nginx/conf.d',
      },
    },
    {
      content: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="9.3"\n',
      expected: {
        id: 'rhel',
        versionId: '9.3',
        majorVersion: '9',
        codename: null,
        family: 'rhel',
        supported: true,
        passengerSupported: false,
        packageManager: 'dnf',
        webUser: 'nginx',
        defaultPhpVersion: '8.1',
        nginxSitesAvailableDir: '/etc/nginx/conf.d',
        nginxSitesEnabledDir: '/etc/nginx/conf.d',
      },
    },
  ];

  for (const item of rhelCases) {
    await withTempOsRelease(item.content, async (osReleasePath) => {
      const profile = await detectLinuxPlatform({ readFileFn: readFile, osReleasePath });
      assert.deepEqual(profile, item.expected);
    });
  }
});

test('detectLinuxPlatform marks unsupported distros or mismatched codenames as unsupported', async () => {
  const unsupportedCases = [
    'ID=alpine\nVERSION_ID=3.20.0\n',
    'ID=arch\n',
    'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n',
    'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=focal\n',
    'ID=almalinux\nVERSION_ID="7.9"\n',
  ];

  for (const content of unsupportedCases) {
    await withTempOsRelease(content, async (osReleasePath) => {
      const profile = await detectLinuxPlatform({ readFileFn: readFile, osReleasePath });
      assert.equal(profile.supported, false);
      assert.equal(profile.passengerSupported, false);
    });
  }

  await assert.rejects(
    detectLinuxPlatform({ readFileFn: readFile, osReleasePath: '/nonexistent/yunpanel-os-release' }),
    (error) => error instanceof OsPlatformError && error.code === 'os_platform_unavailable',
  );
});

test('Passenger platform validation accepts Ubuntu 20.04/22.04/24.04 and Debian 11/12 and rejects unsupported distros', async () => {
  const validPassengerDistros = [
    { content: 'ID=ubuntu\nVERSION_ID="20.04"\nVERSION_CODENAME=focal\n', codename: 'focal' },
    { content: 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n', codename: 'jammy' },
    { content: 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n', codename: 'noble' },
    { content: 'ID=debian\nVERSION_ID="11"\nVERSION_CODENAME=bullseye\n', codename: 'bullseye' },
    { content: 'ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n', codename: 'bookworm' },
  ];

  for (const distro of validPassengerDistros) {
    await withTempOsRelease(distro.content, async (osReleasePath) => {
      const text = await readFile(osReleasePath, 'utf8');
      const parsed = parseOsReleaseText(text);
      assert.equal(isSupportedPassengerPlatform(parsed), true);
      assert.equal(passengerManagerInternals.supportedPlatform(parsed), true);
      assert.match(
        passengerManagerInternals.repositoryContent(distro.codename),
        new RegExp(` ${distro.codename} main\\n$`),
      );
    });
  }

  for (const invalidContent of [
    'ID="almalinux"\nVERSION_ID="9.4"\n',
    'ID="rocky"\nVERSION_ID="9.4"\n',
    'ID=alpine\nVERSION_ID="3.19"\n',
    'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=noble\n',
  ]) {
    await withTempOsRelease(invalidContent, async (osReleasePath) => {
      const manager = createPassengerManager({
        inspector: {
          inspect: async () => ({
            packageName: 'libnginx-mod-http-passenger',
            installed: false,
            installedVersion: null,
            passengerRoot: null,
            nginxPassengerRoots: [],
            moduleLoaded: false,
            installValid: false,
            healthy: false,
          }),
        },
        readFileFn: (target, encoding) => readFile(
          target === '/etc/os-release' ? osReleasePath : target,
          encoding,
        ),
      });

      await assert.rejects(
        manager.apply(),
        (error) => error instanceof PassengerManagerError && error.code === 'passenger_platform_unsupported',
      );
    });
  }
});

test('PHP-FPM service units, paths, repositories, and config templates resolve cleanly across Debian/Ubuntu and RHEL families', async () => {
  assert.equal(resolvePhpFpmServiceUnit(), 'php8.3-fpm.service');
  assert.equal(resolvePhpFpmServiceUnit('7.4', { family: 'debian' }), 'php7.4-fpm.service');
  assert.equal(resolvePhpFpmServiceUnit('8.1', { family: 'debian' }), 'php8.1-fpm.service');
  assert.equal(resolvePhpFpmServiceUnit('8.2', { family: 'debian' }), 'php8.2-fpm.service');
  assert.equal(resolvePhpFpmServiceUnit('8.1', { family: 'rhel' }), 'php-fpm.service');
  assert.equal(resolvePhpFpmServiceUnit('8.3', { family: 'rhel', remi: true }), 'php83-php-fpm.service');

  assert.equal(resolvePhpFpmPoolDirectory('8.2', { family: 'debian' }), '/etc/php/8.2/fpm/pool.d');
  assert.equal(resolvePhpFpmPoolDirectory('8.1', { family: 'rhel' }), '/etc/php-fpm.d');
  assert.equal(resolvePhpFpmSocketDirectory({ family: 'debian' }), '/run/php');
  assert.equal(resolvePhpFpmSocketDirectory({ family: 'rhel' }), '/run/php-fpm');
  assert.equal(resolvePhpFpmBinaryPath('8.2', { family: 'debian' }), '/usr/sbin/php-fpm8.2');
  assert.equal(resolvePhpFpmBinaryPath('8.1', { family: 'rhel' }), '/usr/sbin/php-fpm');
  assert.equal(resolvePhpFpmPackageName('8.2', { family: 'debian' }), 'php8.2-fpm');
  assert.equal(resolvePhpFpmPackageName('8.1', { family: 'rhel' }), 'php-fpm');

  assert.equal(
    isSupportedPhpRepositoryLine('     500 https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble/main amd64 Packages'),
    true,
  );
  assert.equal(
    isSupportedPhpRepositoryLine('     500 http://ppa.launchpad.net/ondrej/php/ubuntu jammy/main amd64 Packages'),
    true,
  );
  assert.equal(
    isSupportedPhpRepositoryLine('     500 https://packages.sury.org/php bookworm/main amd64 Packages'),
    true,
  );
  assert.equal(
    isSupportedPhpRepositoryLine('baseurl=https://rpms.remirepo.net/enterprise/9/remi/x86_64/'),
    true,
  );
  assert.equal(
    isSupportedPhpRepositoryLine('     700 https://packages.example.test/php noble/main amd64 Packages'),
    false,
  );
  assert.equal(
    isSupportedPhpRepositoryLine('https://evil.example.test/ppa.launchpadcontent.net/ondrej/php/ubuntu'),
    false,
  );

  const bookwormPlatform = normalizeLinuxPlatform('ID=debian\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n');
  const alma9Platform = normalizeLinuxPlatform('ID="almalinux"\nVERSION_ID="9.4"\n');

  const pmaDebian12 = previewPhpMyAdminFpmPool({ osPlatform: bookwormPlatform });
  assert.equal(pmaDebian12.serviceUnit, 'php8.2-fpm.service');
  assert.equal(pmaDebian12.artifact.path, '/etc/php/8.2/fpm/pool.d/yunpanel-phpmyadmin.conf');
  assert.equal(pmaDebian12.socketPath, '/run/php/yunpanel-phpmyadmin.sock');

  const pmaAlma9 = previewPhpMyAdminFpmPool({ osPlatform: alma9Platform });
  assert.equal(pmaAlma9.serviceUnit, 'php-fpm.service');
  assert.equal(pmaAlma9.artifact.path, '/etc/php-fpm.d/yunpanel-phpmyadmin.conf');
  assert.equal(pmaAlma9.socketPath, '/run/php-fpm/yunpanel-phpmyadmin.sock');

  const rcDebian12 = previewRoundcubeFpmPool({ osPlatform: bookwormPlatform });
  assert.equal(rcDebian12.serviceUnit, 'php8.2-fpm.service');
  assert.equal(rcDebian12.artifact.path, '/etc/php/8.2/fpm/pool.d/yunpanel-roundcube.conf');

  const rcAlma9 = previewRoundcubeFpmPool({ osPlatform: alma9Platform });
  assert.equal(rcAlma9.serviceUnit, 'php-fpm.service');
  assert.equal(rcAlma9.artifact.path, '/etc/php-fpm.d/yunpanel-roundcube.conf');
  assert.equal(rcAlma9.socketPath, '/run/php-fpm/yunpanel-roundcube.sock');

  const websiteId = '12345678-1234-4234-8234-123456789012';
  const applicationId = '22345678-1234-4234-8234-123456789012';
  const unixUser = elFinderFpmTemplateInternals.applicationUser(applicationId);
  const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
  const elfinderDebian12 = previewElFinderFpmPool({
    websiteId,
    applicationId,
    unixUser,
    unixGroup: unixUser,
    homeDirectory,
    temporaryDirectory: `${homeDirectory}/tmp`,
    osPlatform: bookwormPlatform,
  });
  assert.equal(elfinderDebian12.phpVersion, '8.2');
  assert.equal(elfinderDebian12.serviceUnit, 'php8.2-fpm.service');
  assert.equal(elfinderDebian12.artifact.path, `/etc/php/8.2/fpm/pool.d/yunpanel-elfinder-${unixUser}.conf`);

  const umaskTempDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-umask-'));
  try {
    const missingDropIn = path.join(umaskTempDir, 'nonexistent');
    const umaskManager = createServiceUmaskManager({
      osPlatform: bookwormPlatform,
      lstatFn: async () => {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      },
      readFileFn: async () => readFile(missingDropIn, 'utf8'),
    });
    const inspectedUmask = await umaskManager.inspect('php');
    assert.equal(inspectedUmask.satisfied, false);
    assert.equal(inspectedUmask.serviceUnit, 'php8.2-fpm.service');
    assert.equal(inspectedUmask.dropInPath, '/etc/systemd/system/php8.2-fpm.service.d/90-yunpanel-umask.conf');
  } finally {
    await rm(umaskTempDir, { recursive: true, force: true });
  }
});
