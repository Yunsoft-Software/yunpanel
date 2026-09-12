import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewRoundcubeFpmPool,
  renderRoundcubeFpmPool,
  RoundcubeFpmTemplateError,
  roundcubeFpmTemplatePolicy,
} from '../src/index.js';

test('Roundcube FPM pool is isolated behind a dedicated runtime user and socket', () => {
  const content = renderRoundcubeFpmPool();
  assert.match(content, /^\[yunpanel-roundcube\]$/m);
  assert.match(content, /^user = yunpanel-roundcube$/m);
  assert.match(content, /^group = yunpanel-roundcube$/m);
  assert.match(content, /^listen = \/run\/php\/yunpanel-roundcube\.sock$/m);
  assert.match(content, /^listen\.owner = www-data$/m);
  assert.match(content, /^listen\.group = www-data$/m);
  assert.match(content, /^listen\.mode = 0660$/m);
  assert.match(content, /^pm = ondemand$/m);
  assert.match(content, /^clear_env = yes$/m);
  assert.match(content, /^security\.limit_extensions = \.php$/m);
  assert.match(content, /^php_admin_value\[sys_temp_dir\] = \/var\/lib\/yunpanel\/roundcube\/tmp$/m);
});

test('Roundcube FPM preview is deterministic and points only at the managed Ubuntu 24.04 pool', () => {
  const first = previewRoundcubeFpmPool();
  const second = previewRoundcubeFpmPool();
  assert.deepEqual(first, second);
  assert.equal(first.artifact.path, '/etc/php/8.3/fpm/pool.d/yunpanel-roundcube.conf');
  assert.equal(first.artifact.sensitive, false);
  assert.equal(first.artifact.mode, 0o640);
  assert.equal(first.socketPath, roundcubeFpmTemplatePolicy.socketPath);
  assert.equal(first.serviceUnit, 'php8.3-fpm.service');
});

test('Roundcube FPM pool rejects arbitrary identities and paths', () => {
  for (const input of [
    { runtimeUser: 'root' },
    { runtimeGroup: '../group' },
    { socketOwner: 'WWW DATA' },
    { socketPath: '/run/php/../root.sock' },
    { temporaryDirectory: 'relative/tmp' },
  ]) {
    assert.throws(() => renderRoundcubeFpmPool(input), RoundcubeFpmTemplateError);
  }
});