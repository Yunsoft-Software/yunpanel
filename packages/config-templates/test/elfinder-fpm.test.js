import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ElFinderFpmTemplateError,
  elFinderFpmPoolName,
  elFinderFpmPoolPath,
  elFinderFpmSocketPath,
  elFinderFpmTemplateInternals,
  elFinderFpmTemplatePolicy,
  previewElFinderFpmPool,
  renderElFinderFpmPool,
} from '../src/elfinder-fpm.js';

const websiteId = '12345678-1234-4234-8234-123456789012';
const applicationId = '22345678-1234-4234-8234-123456789012';
const unixUser = elFinderFpmTemplateInternals.applicationUser(applicationId);
const homeDirectory = `/var/lib/yunpanel/data/${applicationId}`;
const temporaryDirectory = `${homeDirectory}/tmp`;

function input(overrides = {}) {
  return {
    websiteId,
    applicationId,
    unixUser,
    unixGroup: unixUser,
    homeDirectory,
    temporaryDirectory,
    ...overrides,
  };
}

test('elFinder FPM pool runs the shared connector under the exact Website identity', () => {
  const rendered = renderElFinderFpmPool(input());

  assert.match(rendered, new RegExp(`\\[yunpanel-elfinder-${unixUser}\\]`));
  assert.match(rendered, new RegExp(`user = ${unixUser}`));
  assert.match(rendered, new RegExp(`group = ${unixUser}`));
  assert.match(rendered, new RegExp(`listen = /run/php/yunpanel-elfinder-${unixUser}\\.sock`));
  assert.match(rendered, /listen\.owner = www-data/);
  assert.match(rendered, /listen\.group = www-data/);
  assert.match(rendered, /listen\.mode = 0660/);
  assert.match(rendered, /clear_env = yes/);
  assert.match(rendered, /security\.limit_extensions = \.php/);
  assert.match(rendered, new RegExp(`chdir = ${homeDirectory}`));
  assert.match(rendered, new RegExp(`env\\[HOME\\] = ${homeDirectory}`));
  assert.match(rendered, new RegExp(`env\\[YUNPANEL_ELFINDER_ROOT\\] = ${homeDirectory}`));
  assert.match(rendered, new RegExp(`env\\[YUNPANEL_ELFINDER_WEBSITE_ID\\] = ${websiteId}`));
  assert.match(rendered, new RegExp(`env\\[YUNPANEL_ELFINDER_APPLICATION_ID\\] = ${applicationId}`));
  assert.match(
    rendered,
    new RegExp(`php_admin_value\\[open_basedir\\] = ${homeDirectory}:/usr/share/yunpanel/elfinder`),
  );
  assert.match(rendered, new RegExp(`php_admin_value\\[upload_tmp_dir\\] = ${temporaryDirectory}`));
  assert.match(rendered, /php_admin_value\[disable_functions\] = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec/);
  assert.doesNotMatch(rendered, /user = root/);
  assert.doesNotMatch(rendered, /user = yunpanel-elfinder/);
  assert.doesNotMatch(rendered, /listen = 0\.0\.0\.0/);
});

test('elFinder FPM identities and sockets are deterministic per Website user', () => {
  assert.equal(elFinderFpmPoolName(unixUser), `yunpanel-elfinder-${unixUser}`);
  assert.equal(
    elFinderFpmPoolPath(unixUser),
    `/etc/php/8.3/fpm/pool.d/yunpanel-elfinder-${unixUser}.conf`,
  );
  assert.equal(
    elFinderFpmSocketPath(unixUser),
    `/run/php/yunpanel-elfinder-${unixUser}.sock`,
  );

  const first = previewElFinderFpmPool(input());
  const second = previewElFinderFpmPool(input());
  assert.deepEqual(first, second);
  assert.equal(first.runtimeUser, unixUser);
  assert.equal(first.runtimeGroup, unixUser);
  assert.equal(first.root, homeDirectory);
  assert.equal(first.connectorPath, '/usr/share/yunpanel/elfinder/connector.php');
  assert.equal(first.serviceUnit, 'php8.3-fpm.service');
  assert.equal(first.artifact.mode, 0o600);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});

test('elFinder FPM pool rejects forged Website user and filesystem roots', () => {
  for (const [overrides, code] of [
    [{ unixUser: 'www-data', unixGroup: 'www-data' }, 'elfinder_fpm_site_user_invalid'],
    [{ unixUser: 'yunapp-ffffffffffff', unixGroup: 'yunapp-ffffffffffff' }, 'elfinder_fpm_site_user_invalid'],
    [{ homeDirectory: '/etc' }, 'elfinder_fpm_home_invalid'],
    [{ temporaryDirectory: '/tmp' }, 'elfinder_fpm_temp_invalid'],
    [{ sharedApplicationRoot: '/tmp/elfinder' }, 'elfinder_fpm_shared_root_invalid'],
  ]) {
    assert.throws(
      () => renderElFinderFpmPool(input(overrides)),
      (error) => error instanceof ElFinderFpmTemplateError && error.code === code,
    );
  }
});

test('elFinder FPM pool rejects invalid Website/Application identities before path materialization', () => {
  assert.throws(
    () => renderElFinderFpmPool(input({ websiteId: '../site' })),
    (error) => error instanceof ElFinderFpmTemplateError && error.code === 'elfinder_fpm_identity_invalid',
  );
  assert.throws(
    () => renderElFinderFpmPool(input({ applicationId: '../app' })),
    (error) => error instanceof ElFinderFpmTemplateError && error.code === 'elfinder_fpm_identity_invalid',
  );
});

test('elFinder FPM policy remains on Ubuntu 24.04 distro PHP and a fixed shared app root', () => {
  assert.equal(elFinderFpmTemplatePolicy.phpVersion, '8.3');
  assert.equal(elFinderFpmTemplatePolicy.sharedApplicationRoot, '/usr/share/yunpanel/elfinder');
  assert.equal(elFinderFpmTemplatePolicy.connectorPath, '/usr/share/yunpanel/elfinder/connector.php');
  assert.equal(elFinderFpmTemplatePolicy.socketOwner, 'www-data');
  assert.equal(elFinderFpmTemplatePolicy.socketGroup, 'www-data');
  assert.equal(elFinderFpmTemplatePolicy.socketMode, '0660');
});
