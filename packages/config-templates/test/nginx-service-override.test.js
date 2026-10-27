import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProxySiteConfig } from '../src/index.js';

const tls = { fullchainPath: '/etc/letsencrypt/live/t.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/t.example.com/privkey.pem' };
const render = (serviceOverride, extra = {}) => renderProxySiteConfig({ primaryDomain: 't.example.com', upstreamPort: 32010, tls, httpsRedirect: false,
  nginxSettings: { serviceOverride, redirectRules: [{ source: '/eski', target: '/yeni', status: 301, match: 'exact' }], ...extra } });

test('maintenance answers 503 everywhere instead of reaching the application; ACME stays open', () => {
  const config = render({ mode: 'unavailable' });
  assert.equal(config.includes('proxy_pass'), false);
  assert.equal(config.includes('location = /eski'), false, 'path rules do not bypass maintenance');
  assert.equal([...config.matchAll(/location \/ \{\n {4}return 503;\n {2}\}/g)].length, 2);
  assert.match(config, /acme-challenge/);
});

test('a forwarding override replaces the application with one redirect', () => {
  const config = render({ mode: 'redirect', url: 'https://control.example.com/billing', status: 302, preservePath: false });
  assert.equal(config.includes('proxy_pass'), false);
  assert.equal([...config.matchAll(/return 302 https:\/\/control\.example\.com\/billing;/g)].length, 2);
});

test('without an override the application is served as before', () => {
  assert.equal(render(null), renderProxySiteConfig({ primaryDomain: 't.example.com', upstreamPort: 32010, tls, httpsRedirect: false,
    nginxSettings: { redirectRules: [{ source: '/eski', target: '/yeni', status: 301, match: 'exact' }] } }));
});
