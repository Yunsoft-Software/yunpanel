import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PhpMyAdminNginxTemplateError,
  phpMyAdminNginxTemplatePolicy,
  previewPhpMyAdminNginxConfig,
  renderPhpMyAdminNginxConfig,
} from '../src/index.js';

test('phpMyAdmin Nginx template is reachable only through the managed Unix gateway socket', () => {
  const content = renderPhpMyAdminNginxConfig();
  const preview = previewPhpMyAdminNginxConfig();
  assert.match(content, /^  listen unix:\/run\/yunpanel\/phpmyadmin-http\.sock;$/m);
  assert.doesNotMatch(content, /listen (?:80|443|127\.)/);
  assert.match(content, /^  root \/usr\/share\/phpmyadmin;$/m);
  assert.match(content, /fastcgi_pass unix:\/run\/php\/yunpanel-phpmyadmin\.sock;/);
  assert.match(content, /location ~ \^\/\(\?:setup\|test\|libraries\|templates\)\(\?:\/\|\$\)/);
  assert.match(content, /^  location = \/__yunpanel\/signon \{$/m);
  assert.match(content, /^  location = \/__yunpanel\/logout \{$/m);
  assert.match(content, /fastcgi_param YUNPANEL_SIGNON_ACTION signon;/);
  assert.match(content, /fastcgi_param YUNPANEL_SIGNON_ACTION logout;/);
  assert.match(content, /fastcgi_param SCRIPT_FILENAME \/usr\/lib\/yunpanel\/phpmyadmin\/signon\.php;/);
  assert.match(content, /limit_except POST/);
  assert.match(content, /fastcgi_param HTTPS on;/);
  assert.match(content, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.equal(preview.artifact.path, phpMyAdminNginxTemplatePolicy.configPath);
  assert.equal(preview.artifact.sha256, preview.sha256);
  assert.equal(preview.artifact.sensitive, false);
  assert.equal(preview.gatewaySocketPath, '/run/yunpanel/phpmyadmin-http.sock');
  assert.equal(preview.gatewaySocketMode, 0o660);
  assert.equal(preview.gatewaySocketGroup, 'yunpanel');
  assert.equal(preview.signonBridgePath, '/usr/lib/yunpanel/phpmyadmin/signon.php');
  assert.equal(preview.internalSignonPath, '/__yunpanel/signon');
  assert.equal(preview.internalLogoutPath, '/__yunpanel/logout');
  assert.equal(preview.healthPath, '/');
});

test('phpMyAdmin Nginx preview is deterministic and contains no network endpoint', () => {
  const first = previewPhpMyAdminNginxConfig();
  assert.deepEqual(first, previewPhpMyAdminNginxConfig());
  assert.doesNotMatch(JSON.stringify(first), /https?:\/\//);
});

test('phpMyAdmin Nginx template rejects alternate roots and sockets', () => {
  for (const input of [
    { documentRoot: '/srv/phpmyadmin' },
    { fpmSocketPath: '/run/php/another.sock' },
    { gatewaySocketPath: '/run/yunpanel/../public.sock' },
    { gatewaySocketPath: '/tmp/phpmyadmin.sock' },
    { signonBridgePath: '/tmp/signon.php' },
    { internalSignonPath: '/signon' },
    { internalLogoutPath: '/logout' },
  ]) {
    assert.throws(() => renderPhpMyAdminNginxConfig(input), PhpMyAdminNginxTemplateError);
  }
});
