import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elFinderNginxTemplatePolicy,
  previewElFinderNginxConfig,
  renderElFinderNginxConfig,
} from '../src/elfinder-nginx.js';

test('elFinder Nginx gateway listens only on the private YunPanel Unix socket', () => {
  const content = renderElFinderNginxConfig();
  assert.match(content, /listen unix:\/run\/yunpanel\/elfinder-http\.sock;/);
  assert.doesNotMatch(content, /listen\s+(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|\d{2,5})/);
  assert.match(content, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.match(content, /Cache-Control "no-store"/);
});

test('elFinder connector FastCGI target is derived only from validated trusted Website headers', () => {
  const content = renderElFinderNginxConfig();
  assert.match(content, /location = \/connector\.php/);
  assert.match(content, /x_yunpanel_elfinder_unix_user !~ "\^yunapp-\[a-f0-9\]\{12\}\$"/);
  assert.match(content, /x_yunpanel_elfinder_website_id !~/);
  assert.match(content, /x_yunpanel_elfinder_application_id !~/);
  assert.match(content, /set \$yunpanel_elfinder_upstream "unix:\/run\/php\/yunpanel-elfinder-\$http_x_yunpanel_elfinder_unix_user\.sock"/);
  assert.match(content, /YUNPANEL_ELFINDER_ROOT "\/var\/lib\/yunpanel\/data\/\$http_x_yunpanel_elfinder_application_id"/);
  assert.match(content, /YUNPANEL_ELFINDER_WEBSITE_ID \$http_x_yunpanel_elfinder_website_id/);
  assert.match(content, /YUNPANEL_ELFINDER_APPLICATION_ID \$http_x_yunpanel_elfinder_application_id/);
  assert.match(content, /YUNPANEL_ELFINDER_UNIX_USER \$http_x_yunpanel_elfinder_unix_user/);
  assert.doesNotMatch(content, /\$arg_(?:root|path|user|website|application)/i);
});

test('elFinder gateway exposes only packaged browser assets and the hardened connector', () => {
  const content = renderElFinderNginxConfig();
  assert.match(content, /location \^~ \/assets\/jquery\//);
  assert.match(content, /alias \/usr\/share\/javascript\/jquery\//);
  assert.match(content, /location \^~ \/assets\/jquery-ui\//);
  assert.match(content, /alias \/usr\/share\/javascript\/jquery-ui\//);
  assert.match(content, /location \^~ \/vendor\//);
  assert.match(content, /alias \/usr\/share\/yunpanel\/elfinder\/vendor\/elfinder\//);
  assert.match(content, /vendor\/php\//);
  assert.match(content, /vendor\/files\//);
  assert.match(content, /location = \/index\.html/);
  assert.match(content, /location = \/yunpanel-client\.js/);
});

test('elFinder Nginx preview pins package and runtime socket metadata', () => {
  const preview = previewElFinderNginxConfig();
  assert.equal(preview.artifact.path, '/etc/nginx/sites-enabled/yunpanel-elfinder.conf');
  assert.equal(preview.gatewaySocketPath, '/run/yunpanel/elfinder-http.sock');
  assert.equal(preview.gatewaySocketMode, 0o660);
  assert.equal(preview.gatewaySocketOwner, 'root');
  assert.equal(preview.gatewaySocketGroup, 'yunpanel');
  assert.equal(preview.documentRoot, '/usr/share/yunpanel/elfinder');
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.artifact.sha256, preview.sha256);
  assert.equal(preview.artifact.bytes, Buffer.byteLength(renderElFinderNginxConfig()));
});

test('elFinder Nginx template rejects path overrides', () => {
  for (const input of [
    { documentRoot: '/tmp/elfinder' },
    { connectorPath: '/tmp/connector.php' },
    { gatewaySocketPath: '/tmp/elfinder.sock' },
    { jqueryRoot: '/tmp/jquery' },
  ]) assert.throws(() => renderElFinderNginxConfig(input), /managed elFinder path/);
  assert.equal(elFinderNginxTemplatePolicy.serviceUnit, 'nginx.service');
});
