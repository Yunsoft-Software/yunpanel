import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPhpSiteConfig, renderProxySiteConfig, renderStaticSiteConfig } from '../src/nginx.js';

const ADMIN = { path: '/admin/', key: '0123456789abcdef' };
const REPORTS = { path: '/raporlar.v1/', key: 'fedcba9876543210' };

const php = { root: '/var/www/yunpanel/apps/owned/current', socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' };
const tls = { fullchainPath: '/etc/letsencrypt/live/owned.example.com/fullchain.pem', privateKeyPath: '/etc/letsencrypt/live/owned.example.com/privkey.pem' };

test('no protected paths renders the same bytes as before', () => {
  assert.equal(renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php, nginxSettings: { protectedPaths: [] } }),
    renderPhpSiteConfig({ primaryDomain: 'owned.example.com', ...php }));
});

test('each protected path maps to its own htpasswd file and auth applies in every serving block', () => {
  const config = renderPhpSiteConfig({ primaryDomain: 'owned.example.com', aliases: ['www.owned.example.com'], ...php, tls,
    httpsRedirect: true, canonicalRedirect: true, nginxSettings: { protectedPaths: [ADMIN, REPORTS] } });
  const realm = config.match(/map \$uri (\$yp_auth_realm_[a-f0-9]{12}) \{/)[1];
  const file = config.match(/map \$uri (\$yp_auth_file_[a-f0-9]{12}) \{/)[1];
  assert.match(config, new RegExp(`default off;\\n  "~\\^/admin/" "Restricted";\\n  "~\\^/raporlar\\\\\\.v1/" "Restricted";`));
  assert.match(config, new RegExp(`"~\\^/admin/" /etc/nginx/yunpanel-auth/owned\\.example\\.com/${ADMIN.key}\\.htpasswd;`));
  // The maps live outside every server block (http context) and are emitted once.
  assert.ok(config.indexOf('map $uri') < config.indexOf('server {'));
  assert.equal([...config.matchAll(/map \$uri \$yp_auth_realm_/g)].length, 1);
  // Only the canonical TLS block serves content; the others redirect first.
  assert.equal([...config.matchAll(new RegExp(`auth_basic \\${realm};\\n  auth_basic_user_file \\${file};`, 'g'))].length, 1);
});

test('two sites never share map variable names', () => {
  const a = renderStaticSiteConfig({ primaryDomain: 'a.example.com', root: '/var/www/a', nginxSettings: { protectedPaths: [ADMIN] } });
  const b = renderStaticSiteConfig({ primaryDomain: 'b.example.com', root: '/var/www/b', nginxSettings: { protectedPaths: [ADMIN] } });
  assert.notEqual(a.match(/\$yp_auth_realm_[a-f0-9]{12}/)[0], b.match(/\$yp_auth_realm_[a-f0-9]{12}/)[0]);
});

test('proxied applications are protected too', () => {
  const config = renderProxySiteConfig({ primaryDomain: 'app.example.com', upstreamPort: 3000, nginxSettings: { protectedPaths: [{ path: '/yonetim/', key: 'aaaaaaaaaaaaaaaa' }] } });
  assert.match(config, /auth_basic \$yp_auth_realm_[a-f0-9]{12};/);
});
