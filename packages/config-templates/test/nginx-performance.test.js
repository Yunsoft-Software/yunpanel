import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPassengerSiteConfig, renderPhpSiteConfig, renderProxySiteConfig, renderPythonSiteConfig, renderStaticSiteConfig,
} from '../src/nginx.js';

const tls = { fullchainPath: '/etc/letsencrypt/live/owned.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/owned.example.com/privkey.pem' };
const php = { root: '/var/www/yunpanel/apps/owned/current', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' };
const targets = {
  static: [renderStaticSiteConfig, { root: '/var/www/yunpanel/apps/owned/current' }],
  php: [renderPhpSiteConfig, php],
  proxy: [renderProxySiteConfig, { upstreamHost: '127.0.0.1', upstreamPort: 3000 }],
  passenger: [renderPassengerSiteConfig, { target: {
    appRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
    documentRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
    startupFile: 'server.js', nodeBinary: '/usr/bin/node', user: 'yunapp-0123456789ab', group: 'yunapp-0123456789ab',
  } }],
  python: [renderPythonSiteConfig, { socketPath: '/run/yunpanel/python-0123456789ab.sock' }],
};

for (const [kind, [render, target]] of Object.entries(targets)) {
  test(`${kind}: gzip off or absent renders the same bytes as before`, () => {
    const config = { primaryDomain: 'owned.example.com', ...target };
    assert.equal(render({ ...config, nginxSettings: { gzip: false } }), render(config));
  });

  test(`${kind}: gzip compresses text assets, proxied responses included, only where content is served`, () => {
    const config = render({ primaryDomain: 'owned.example.com', aliases: ['www.owned.example.com'], ...target, tls,
      httpsRedirect: true, canonicalRedirect: true, nginxSettings: { gzip: true } });
    assert.equal([...config.matchAll(/^  gzip on;$/gm)].length, 1, 'only the canonical TLS block serves content');
    assert.match(config, /  gzip_vary on;\n  gzip_proxied any;\n  gzip_comp_level 5;\n  gzip_min_length 1024;\n  gzip_types text\/plain text\/css /);
    assert.match(config, /gzip_types [^;]*application\/javascript[^;]*application\/json[^;]*image\/svg\+xml[^;]*font\/woff2?/);
    assert.doesNotMatch(config, /gzip_types[^;]*text\/html/, 'text/html is always compressed and must not be listed twice');
  });
}

test('php: browser cache for static files renders an asset location ahead of the PHP handler', () => {
  const config = renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php, nginxSettings: { staticAssetCacheSeconds: 604_800 } });
  assert.match(config, /location ~\* \\\.\(\?:css\|js\|mjs\|jpg\|jpeg\|png\|gif\|svg\|webp\|ico\|woff\|woff2\)\$ \{\n    expires 7d;\n    add_header Cache-Control "public, max-age=604800, immutable";\n    try_files \$uri =404;\n    access_log off;\n  \}/);
  assert.ok(config.indexOf('location ~* \\.(?:css') < config.indexOf('location ~ \\.php$'));
  const off = renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php, nginxSettings: { staticAssetCacheSeconds: 0 } });
  assert.match(off, /expires -1;\n    add_header Cache-Control "no-store" always;/);
  assert.equal(renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php, nginxSettings: { staticAssetCacheSeconds: null } }),
    renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php }));
});
