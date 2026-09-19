import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PhpFpmTemplateError,
  phpFpmBinaryPath,
  phpFpmPackageName,
  phpFpmPoolDirectory,
  phpFpmPoolName,
  phpFpmPoolPath,
  phpFpmServiceUnit,
  phpFpmSocketPath,
  phpFpmTemplatePolicy,
  previewWebsitePhpFpmPool,
  renderWebsitePhpFpmPool,
} from '../src/php-fpm.js';

const unixUser = 'yunapp-0123456789ab';
const applicationRoot = '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current';
const documentRoot = `${applicationRoot}/public`;
const homeDirectory = '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const temporaryDirectory = `${homeDirectory}/tmp`;
const logDirectory = `${homeDirectory}/logs`;

function input(overrides = {}) {
  return {
    unixUser,
    unixGroup: unixUser,
    applicationRoot,
    documentRoot,
    homeDirectory,
    temporaryDirectory,
    logDirectory,
    ...overrides,
  };
}

test('Website PHP-FPM template binds a dedicated Website identity and private Unix socket', () => {
  const rendered = renderWebsitePhpFpmPool(input());

  assert.match(rendered, new RegExp(`\\[yunpanel-${unixUser}\\]`));
  assert.match(rendered, new RegExp(`user = ${unixUser}`));
  assert.match(rendered, new RegExp(`group = ${unixUser}`));
  assert.match(rendered, new RegExp(`listen = /run/php/yunpanel-${unixUser}\\.sock`));
  assert.match(rendered, /listen\.owner = www-data/);
  assert.match(rendered, /listen\.group = www-data/);
  assert.match(rendered, /listen\.mode = 0660/);
  assert.match(rendered, /clear_env = yes/);
  assert.match(rendered, /security\.limit_extensions = \.php/);
  assert.match(rendered, new RegExp(`php_admin_value\\[open_basedir\\] = ${applicationRoot}:${homeDirectory}`));
  assert.match(rendered, new RegExp(`php_admin_value\\[sys_temp_dir\\] = ${temporaryDirectory}`));
  assert.match(rendered, new RegExp(`php_admin_value\\[error_log\\] = ${logDirectory}/php-error\\.log`));
  assert.doesNotMatch(rendered, /user = root/);
  assert.doesNotMatch(rendered, /listen = 0\.0\.0\.0/);
});

test('Website PHP-FPM identifiers are deterministic per Website Unix identity', () => {
  assert.equal(phpFpmPoolName(unixUser), `yunpanel-${unixUser}`);
  assert.equal(phpFpmPoolPath(unixUser), `/etc/php/8.3/fpm/pool.d/yunpanel-${unixUser}.conf`);
  assert.equal(phpFpmSocketPath(unixUser), `/run/php/yunpanel-${unixUser}.sock`);

  const first = previewWebsitePhpFpmPool(input());
  const second = previewWebsitePhpFpmPool(input());
  assert.deepEqual(first, second);
  assert.equal(first.runtimeUser, unixUser);
  assert.equal(first.runtimeGroup, unixUser);
  assert.equal(first.serviceUnit, 'php8.3-fpm.service');
  assert.equal(first.artifact.mode, 0o600);
  assert.equal(first.artifact.sensitive, false);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});

test('Website PHP-FPM template rejects identities outside YunPanel managed users', () => {
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ unixUser: 'www-data', unixGroup: 'www-data' })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_identity_invalid',
  );
});

test('Website PHP-FPM template rejects user and group mismatch', () => {
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ unixGroup: 'yunapp-abcdefabcdef' })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_identity_mismatch',
  );
});

test('Website PHP-FPM template keeps document root inside the managed application root', () => {
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ documentRoot: '/var/www/another-site' })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_document_root_invalid',
  );
});

test('Website PHP-FPM template keeps temp and logs inside Website home', () => {
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ temporaryDirectory: '/tmp/shared' })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_workspace_invalid',
  );
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ logDirectory: '/var/log/php' })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_workspace_invalid',
  );
});

test('Website PHP-FPM template supports multiple PHP versions with distro 8.3 default', () => {
  for (const version of ['8.1', '8.2', '8.3', '8.4']) {
    const rendered = renderWebsitePhpFpmPool(input({ phpVersion: version }));
    assert.match(rendered, new RegExp(`; managed by YunPanel PHP ${version}`));

    const preview = previewWebsitePhpFpmPool(input({ phpVersion: version }));
    assert.equal(preview.phpVersion, version);
    assert.equal(preview.serviceUnit, `php${version}-fpm.service`);
    assert.equal(preview.artifact.path, `/etc/php/${version}/fpm/pool.d/yunpanel-${unixUser}.conf`);
  }

  for (const invalid of ['7.4', '8.0', '8.5', '9.0', 'not-a-version']) {
    assert.throws(
      () => renderWebsitePhpFpmPool(input({ phpVersion: invalid })),
      (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_version_unsupported',
    );
  }
});

test('Website PHP-FPM template bounds process and PHP resource limits', () => {
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ maxChildren: 128 })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_limit_invalid',
  );
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ memoryLimitMb: 4096 })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_limit_invalid',
  );
  assert.throws(
    () => renderWebsitePhpFpmPool(input({ maxExecutionSeconds: 0 })),
    (error) => error instanceof PhpFpmTemplateError && error.code === 'php_fpm_limit_invalid',
  );
});
