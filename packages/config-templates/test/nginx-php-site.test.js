import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxTemplateError,
  renderPhpSiteConfig,
} from '../src/nginx.js';

const root = '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current/public';
const socketPath = '/run/php/yunpanel-yunapp-0123456789ab.sock';

test('PHP Nginx site routes only PHP scripts to the dedicated Website socket', () => {
  const rendered = renderPhpSiteConfig({
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    root,
    socketPath,
  });

  assert.match(rendered, /server_name example\.com www\.example\.com;/);
  assert.match(rendered, new RegExp(`root ${root.replaceAll('.', '\\.')}\;`));
  assert.match(rendered, /index index\.php index\.html;/);
  assert.match(rendered, /try_files \$uri \$uri\/ \/index\.php\?\$query_string;/);
  assert.match(rendered, /location ~ \\.php\$/);
  assert.match(rendered, /try_files \$uri =404;/);
  assert.match(rendered, /fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;/);
  assert.match(rendered, new RegExp(`fastcgi_pass unix:${socketPath.replaceAll('.', '\\.')}\;`));
  assert.match(rendered, /location ~ \/\\\.\(\?!well-known\/\)/);
  assert.doesNotMatch(rendered, /proxy_pass/);
  assert.doesNotMatch(rendered, /passenger_enabled/);
  assert.doesNotMatch(rendered, /fastcgi_pass 127\.0\.0\.1/);
});

test('PHP Nginx site accepts bounded common settings and TLS redirects', () => {
  const rendered = renderPhpSiteConfig({
    primaryDomain: 'example.com',
    aliases: [],
    root,
    socketPath,
    tls: {
      fullchainPath: '/etc/letsencrypt/live/example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
    },
    httpsRedirect: true,
    nginxSettings: {
      clientMaxBodySizeMb: 64,
      headers: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN', always: true }],
    },
  });

  assert.match(rendered, /client_max_body_size 64m;/);
  assert.match(rendered, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(rendered, /ssl_certificate \/etc\/letsencrypt\/live\/example\.com\/fullchain\.pem;/);
  assert.match(rendered, /add_header X-Frame-Options "SAMEORIGIN" always;/);
  assert.match(rendered, new RegExp(`fastcgi_pass unix:${socketPath.replaceAll('.', '\\.')}\;`));
});

test('PHP Nginx site rejects arbitrary or TCP FastCGI upstreams', () => {
  for (const invalidSocket of [
    '/run/php/php8.3-fpm.sock',
    '/tmp/yunpanel-yunapp-0123456789ab.sock',
    '/run/php/yunpanel-yunapp-0123456789ab.socket',
  ]) {
    assert.throws(
      () => renderPhpSiteConfig({ primaryDomain: 'example.com', root, socketPath: invalidSocket }),
      (error) => error instanceof NginxTemplateError && error.code === 'invalid_php_socket',
    );
  }
});

test('PHP Nginx site rejects unsafe document roots', () => {
  assert.throws(
    () => renderPhpSiteConfig({
      primaryDomain: 'example.com',
      root: '/var/www/../etc',
      socketPath,
    }),
    (error) => error instanceof NginxTemplateError && error.code === 'invalid_path',
  );
});
