import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRedirectSiteConfig } from '../src/index.js';

const tls = { fullchainPath: '/etc/letsencrypt/live/eski.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/eski.example.com/privkey.pem' };

test('every name of the Domain forwards straight to the target and keeps the path', () => {
  const config = renderRedirectSiteConfig({ primaryDomain: 'eski.example.com', aliases: ['www.eski.example.com'], target: { url: 'https://yeni.example.com' } });
  assert.match(config, /server_name eski\.example\.com www\.eski\.example\.com;/);
  assert.match(config, /location \/ \{\n {4}return 301 https:\/\/yeni\.example\.com\$request_uri;\n {2}\}/);
  assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//, 'certificates can still be issued');
  const outsideAcme = config.replace(/location \^~ \/\.well-known\/acme-challenge\/ \{[^}]*\}/g, '');
  assert.equal(/root |try_files|proxy_pass|fastcgi_pass/.test(outsideAcme), false, 'nothing is served apart from ACME');
});

test('with TLS both HTTP and HTTPS forward in one hop; a temporary redirect without the path is supported', () => {
  const config = renderRedirectSiteConfig({ primaryDomain: 'eski.example.com', tls, httpsRedirect: true,
    target: { url: 'https://yeni.example.com/kampanya', status: 302, preservePath: false } });
  const forwards = [...config.matchAll(/return 302 https:\/\/yeni\.example\.com\/kampanya;/g)];
  assert.equal(forwards.length, 2);
  assert.equal(config.includes('return 301 https://$host'), false, 'no detour through HTTPS on the same host');
  assert.match(config, /listen 443 ssl;/);
});

test('an unsafe target never reaches the config', () => {
  assert.throws(() => renderRedirectSiteConfig({ primaryDomain: 'eski.example.com', target: { url: 'https://x.com/;deny all' } }));
});
