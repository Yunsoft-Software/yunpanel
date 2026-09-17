import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PhpMyAdminFpmTemplateError,
  phpMyAdminFpmTemplatePolicy,
  previewPhpMyAdminFpmPool,
  renderPhpMyAdminFpmPool,
} from '../src/index.js';

test('phpMyAdmin FPM pool uses one dedicated identity, socket and private session storage', () => {
  const content = renderPhpMyAdminFpmPool();
  assert.match(content, /^\[yunpanel-phpmyadmin\]$/m);
  assert.match(content, /^user = yunpanel-phpmyadmin$/m);
  assert.match(content, /^group = yunpanel-phpmyadmin$/m);
  assert.match(content, /^listen = \/run\/php\/yunpanel-phpmyadmin\.sock$/m);
  assert.match(content, /^listen\.owner = www-data$/m);
  assert.match(content, /^listen\.group = www-data$/m);
  assert.match(content, /^listen\.mode = 0660$/m);
  assert.match(content, /^clear_env = yes$/m);
  assert.match(content, /^security\.limit_extensions = \.php$/m);
  assert.match(content, /^php_admin_flag\[display_errors\] = off$/m);
  assert.match(content, /^php_admin_flag\[session\.cookie_secure\] = on$/m);
  assert.match(content, /^php_admin_flag\[session\.cookie_httponly\] = on$/m);
  assert.match(content, /^php_admin_value\[session\.cookie_samesite\] = Strict$/m);
  assert.match(content, /^php_admin_value\[session\.cookie_path\] = \/tools\/phpmyadmin\/$/m);
  assert.match(content, /^php_admin_value\[session\.save_path\] = \/var\/lib\/yunpanel\/phpmyadmin\/sessions$/m);
  assert.match(content, /^php_admin_value\[upload_tmp_dir\] = \/var\/lib\/yunpanel\/phpmyadmin\/tmp$/m);
});

test('phpMyAdmin FPM preview is deterministic and publishes no credential material', () => {
  const first = previewPhpMyAdminFpmPool();
  assert.deepEqual(first, previewPhpMyAdminFpmPool());
  assert.equal(first.artifact.path, '/etc/php/8.3/fpm/pool.d/yunpanel-phpmyadmin.conf');
  assert.equal(first.artifact.mode, 0o640);
  assert.equal(first.artifact.sensitive, false);
  assert.equal(first.socketPath, phpMyAdminFpmTemplatePolicy.socketPath);
  assert.equal(first.serviceUnit, 'php8.3-fpm.service');
  assert.equal(first.runtimeUser, 'yunpanel-phpmyadmin');
  assert.equal(first.sessionDirectory, '/var/lib/yunpanel/phpmyadmin/sessions');
});

test('phpMyAdmin FPM pool rejects alternate identities and filesystem paths', () => {
  for (const input of [
    { runtimeUser: 'root' },
    { runtimeGroup: 'www-data' },
    { socketOwner: 'root' },
    { socketPath: '/run/php/another.sock' },
    { temporaryDirectory: '/tmp' },
    { sessionDirectory: '/var/lib/yunpanel/phpmyadmin/../sessions' },
  ]) {
    assert.throws(() => renderPhpMyAdminFpmPool(input), PhpMyAdminFpmTemplateError);
  }
});
