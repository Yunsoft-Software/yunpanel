import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPassengerSiteConfig, renderPhpSiteConfig, renderProxySiteConfig, renderPythonSiteConfig, renderStaticSiteConfig,
} from '../src/nginx.js';

const rules = [
  { source: '/eski', target: 'https://yeni.example.com/sayfa', status: 301, match: 'exact' },
  { source: '/ara', target: 'https://example.com/ara?dil=tr', status: 302, match: 'exact' },
  { source: '/blog.v1/', target: 'https://blog.example.com/', status: 301, match: 'prefix' },
  { source: '/kampanya/', target: '/yeni-kampanya/', status: 302, match: 'prefix' },
];
const tls = { fullchainPath: '/etc/letsencrypt/live/owned.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/owned.example.com/privkey.pem' };
const targets = {
  static: [renderStaticSiteConfig, { root: '/var/www/yunpanel/apps/owned/current' }],
  php: [renderPhpSiteConfig, { root: '/var/www/yunpanel/apps/owned/current', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' }],
  proxy: [renderProxySiteConfig, { upstreamHost: '127.0.0.1', upstreamPort: 3000 }],
  passenger: [renderPassengerSiteConfig, { target: {
    appRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
    documentRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
    startupFile: 'server.js', nodeBinary: '/usr/bin/node', user: 'yunapp-0123456789ab', group: 'yunapp-0123456789ab',
  } }],
  python: [renderPythonSiteConfig, { socketPath: '/run/yunpanel/python-0123456789ab.sock' }],
};

for (const [kind, [render, target]] of Object.entries(targets)) {
  test(`${kind}: no redirect rules renders the same bytes as before`, () => {
    const config = { primaryDomain: 'owned.example.com', ...target };
    assert.equal(render({ ...config, nginxSettings: { redirectRules: [] } }), render(config));
  });

  test(`${kind}: exact and prefix rules render in every serving block and keep the query string`, () => {
    const config = render({ primaryDomain: 'owned.example.com', aliases: ['www.owned.example.com'], ...target, tls,
      httpsRedirect: true, canonicalRedirect: true, nginxSettings: { redirectRules: rules } });
    // Only the canonical TLS block serves content; HTTP and alias blocks redirect before rules apply.
    assert.equal([...config.matchAll(/location = \/eski \{\n    return 301 https:\/\/yeni\.example\.com\/sayfa\$is_args\$args;\n  \}/g)].length, 1);
    assert.match(config, /location = \/ara \{\n    return 302 https:\/\/example\.com\/ara\?dil=tr;\n  \}/);
    assert.match(config, /location \^~ \/blog\.v1\/ \{\n    rewrite \^\/blog\\\.v1\/\(\.\*\)\$ https:\/\/blog\.example\.com\/\$1 permanent;\n  \}/);
    assert.match(config, /location \^~ \/kampanya\/ \{\n    rewrite \^\/kampanya\/\(\.\*\)\$ \/yeni-kampanya\/\$1 redirect;\n  \}/);
    const tlsBlock = config.split('server {').find(block => block.includes('listen 443') && block.includes('server_name owned.example.com;'));
    const catchAll = tlsBlock.indexOf('location / {');
    assert.ok(catchAll === -1 || tlsBlock.indexOf('location = /eski') < catchAll, 'rules come before the catch-all location');
  });

  test(`${kind}: rules without TLS apply to the plain HTTP block`, () => {
    const config = render({ primaryDomain: 'owned.example.com', ...target, nginxSettings: { redirectRules: rules.slice(0, 1) } });
    assert.equal([...config.matchAll(/location = \/eski \{/g)].length, 1);
  });

  test(`${kind}: invalid rules never reach the rendered config`, () => {
    assert.throws(() => render({ primaryDomain: 'owned.example.com', ...target,
      nginxSettings: { redirectRules: [{ source: '/x;', target: '/y', status: 301, match: 'exact' }] } }), { code: 'invalid_nginx_redirect_rule' });
  });
}
