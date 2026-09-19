import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewRoundcubeNginxConfig,
  renderRoundcubeNginxConfig,
  RoundcubeNginxTemplateError,
  roundcubeNginxTemplatePolicy,
} from '../src/index.js';

const input = Object.freeze({
  webHostname: 'mail.example.com',
  fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
  privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
});

test('Roundcube Nginx template exposes HTTPS through the managed PHP-FPM socket', () => {
  const content = renderRoundcubeNginxConfig(input);
  const preview = previewRoundcubeNginxConfig(input);

  assert.match(content, /server_name mail\.example\.com;/);
  assert.match(content, /return 301 https:\/\/mail\.example\.com\$request_uri;/);
  assert.match(content, /ssl_certificate \/etc\/letsencrypt\/live\/mail\.example\.com\/fullchain\.pem;/);
  assert.match(content, /ssl_certificate_key \/etc\/letsencrypt\/live\/mail\.example\.com\/privkey\.pem;/);
  assert.match(content, /root \/var\/lib\/roundcube\/public_html;/);
  assert.match(content, /fastcgi_pass unix:\/run\/php\/yunpanel-roundcube\.sock;/);
  assert.match(content, /try_files \$uri \$uri\/ \/index\.php\?\$query_string;/);
  assert.equal(preview.artifact.path, roundcubeNginxTemplatePolicy.configPath);
  assert.equal(preview.artifact.sha256, preview.sha256);
  assert.equal(preview.artifact.sensitive, false);
  assert.equal(preview.endpoint, 'https://mail.example.com/');
  assert.equal(preview.healthPath, '/');
  assert.equal(preview.fpmSocketPath, '/run/php/yunpanel-roundcube.sock');
  assert.doesNotMatch(JSON.stringify(preview), /privkey|fullchain/i);
});

test('Roundcube Nginx template rejects unmanaged paths and invalid hostnames', () => {
  assert.throws(
    () => renderRoundcubeNginxConfig({ ...input, publicRoot: '/srv/roundcube' }),
    (error) => error instanceof RoundcubeNginxTemplateError && error.code === 'invalid_roundcube_nginx_managed_path',
  );
  assert.throws(
    () => renderRoundcubeNginxConfig({ ...input, privateKeyPath: '/etc/letsencrypt/../shadow' }),
    (error) => error instanceof RoundcubeNginxTemplateError && error.code === 'invalid_roundcube_nginx_path',
  );
  assert.throws(
    () => renderRoundcubeNginxConfig({ ...input, webHostname: 'mail.example.com;return 200' }),
    (error) => error instanceof RoundcubeNginxTemplateError && error.code === 'invalid_roundcube_nginx_hostname',
  );
});


test('Roundcube Nginx template serves many certificate-bound webmail hostnames from one shared FPM socket', () => {
  const mapped = {
    ...input,
    mappings: [
      {
        hostname: 'webmail.second.example',
        fullchainPath: '/etc/letsencrypt/live/webmail.second.example/fullchain.pem',
        privateKeyPath: '/etc/letsencrypt/live/webmail.second.example/privkey.pem',
      },
      {
        hostname: 'webmail.example.com',
        fullchainPath: '/etc/letsencrypt/live/webmail.example.com/fullchain.pem',
        privateKeyPath: '/etc/letsencrypt/live/webmail.example.com/privkey.pem',
      },
    ],
  };
  const content = renderRoundcubeNginxConfig(mapped);
  const preview = previewRoundcubeNginxConfig(mapped);

  assert.equal((content.match(/fastcgi_pass unix:\/run\/php\/yunpanel-roundcube\.sock;/g) ?? []).length, 3);
  assert.match(content, /server_name webmail\.example\.com;/);
  assert.match(content, /server_name webmail\.second\.example;/);
  assert.match(content, /ssl_certificate \/etc\/letsencrypt\/live\/webmail\.example\.com\/fullchain\.pem;/);
  assert.equal((content.match(/listen 80;/g) ?? []).length, 1);
  assert.equal((content.match(/server_name webmail\.example\.com;/g) ?? []).length, 1);
  assert.equal((content.match(/server_name webmail\.second\.example;/g) ?? []).length, 1);
  assert.deepEqual(preview.mappings, [
    { hostname: 'webmail.example.com', endpoint: 'https://webmail.example.com/' },
    { hostname: 'webmail.second.example', endpoint: 'https://webmail.second.example/' },
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /privkey|fullchain/i);

  assert.throws(
    () => renderRoundcubeNginxConfig({
      ...input,
      mappings: [{
        hostname: input.webHostname,
        fullchainPath: '/etc/a.pem',
        privateKeyPath: '/etc/b.pem',
      }],
    }),
    (error) => error instanceof RoundcubeNginxTemplateError
      && error.code === 'invalid_roundcube_nginx_mappings',
  );
});
