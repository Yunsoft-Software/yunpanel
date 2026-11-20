import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderPassengerSiteConfig,
  renderPhpSiteConfig,
  renderProxySiteConfig,
  renderPythonSiteConfig,
  renderRedirectSiteConfig,
  renderStaticSiteConfig,
} from '../src/nginx.js';

const PROJECT_ID = '0bb78242-03a6-429f-9d17-7725c521437c';
const tls = {
  fullchainPath: '/etc/letsencrypt/live/owned.example.com/fullchain.pem',
  privateKeyPath: '/etc/letsencrypt/live/owned.example.com/privkey.pem',
};

const apiRoute = {
  path: '/api',
  projectId: PROJECT_ID,
  serviceName: 'api',
  targetPort: 3000,
  protocol: 'tcp',
  upstreamHost: '127.0.0.1',
  upstreamPort: 13000,
  websocket: true,
  stripPrefix: false,
};

const graphqlRoute = {
  path: '/graphql',
  projectId: PROJECT_ID,
  serviceName: 'gql',
  targetPort: 4000,
  protocol: 'tcp',
  upstreamHost: '::1',
  upstreamPort: 14000,
  websocket: false,
  stripPrefix: true,
};

const targets = {
  static: [renderStaticSiteConfig, { root: '/var/www/yunpanel/apps/owned/current' }],
  php: [renderPhpSiteConfig, {
    root: '/var/www/yunpanel/apps/owned/current',
    socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock',
  }],
  proxy: [renderProxySiteConfig, { upstreamHost: '127.0.0.1', upstreamPort: 3000 }],
  passenger: [renderPassengerSiteConfig, {
    target: {
      appRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
      documentRoot: '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current',
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
      user: 'yunapp-0123456789ab',
      group: 'yunapp-0123456789ab',
    },
  }],
  python: [renderPythonSiteConfig, { socketPath: '/run/yunpanel/python-0123456789ab.sock' }],
};

for (const [kind, [render, target]] of Object.entries(targets)) {
  test(`${kind}: empty or null proxyRoutes renders identical bytes to legacy config`, () => {
    const base = { primaryDomain: 'owned.example.com', ...target };
    const legacy = render(base);
    assert.equal(render({ ...base, nginxSettings: { proxyRoutes: [] } }), legacy);
    assert.equal(render({ ...base, nginxSettings: { proxyRoutes: null } }), legacy);
  });

  test(`${kind}: renders exact and prefix locations for sub-path routes with IPv4, IPv6, stripPrefix, websocket, headers and correct ordering`, () => {
    const config = render({
      primaryDomain: 'owned.example.com',
      aliases: ['www.owned.example.com'],
      ...target,
      tls,
      httpsRedirect: true,
      canonicalRedirect: true,
      mailDiscoverySocketPath: '/run/yunpanel-mail-discovery/discovery.sock',
      nginxSettings: {
        headers: [{ name: 'X-Site', value: 'yunpanel', always: true }],
        redirectRules: [{ source: '/old', target: '/new', status: 301, match: 'exact' }],
        proxyRoutes: [apiRoute, graphqlRoute],
        ...(['proxy', 'python'].includes(kind) ? { proxyTimeoutSeconds: 45 } : {}),
      },
    });

    // Only canonical TLS block serves content when httpsRedirect & canonicalRedirect are active
    assert.equal([...config.matchAll(/location = \/api \{/g)].length, 1);
    assert.equal([...config.matchAll(/location \^~ \/api\/ \{/g)].length, 1);
    assert.equal([...config.matchAll(/location = \/graphql \{/g)].length, 1);
    assert.equal([...config.matchAll(/location \^~ \/graphql\/ \{/g)].length, 1);

    // Non-stripPrefix keeps URI, stripPrefix adds trailing slash, IPv6 uses brackets
    assert.match(config, /location = \/api \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000;\n[\s\S]*?proxy_set_header Upgrade \$http_upgrade;\n    proxy_set_header Connection "upgrade";[\s\S]*?add_header X-Site "yunpanel" always;/);
    assert.match(config, /location \^~ \/api\/ \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:13000;\n/);
    assert.match(config, /location = \/graphql \{[\s\S]*?proxy_pass http:\/\/\[::1\]:14000\/;\n/);
    assert.match(config, /location \^~ \/graphql\/ \{[\s\S]*?proxy_pass http:\/\/\[::1\]:14000\/;\n/);

    // websocket: false omits Upgrade/Connection inside /graphql
    const gqlExactBlock = /location = \/graphql \{[\s\S]*?\n  \}/.exec(config)?.[0] ?? '';
    assert.ok(gqlExactBlock.length > 0);
    assert.equal(gqlExactBlock.includes('Upgrade $http_upgrade'), false);

    // Passenger disables passenger inside sub-path proxy locations only
    if (kind === 'passenger') {
      assert.match(gqlExactBlock, /passenger_enabled off;/);
    } else {
      assert.equal(gqlExactBlock.includes('passenger_enabled off;'), false);
    }

    // Timeout propagates on proxy/python
    if (['proxy', 'python'].includes(kind)) {
      assert.match(gqlExactBlock, /proxy_read_timeout 45s;/);
    }

    // Ordering inside canonical TLS server block: mail discovery -> redirect -> proxyRoutes -> primary body
    const tlsBlock = config.split('server {').find(
      (block) => block.includes('listen 443') && block.includes('server_name owned.example.com;'),
    );
    const mailPos = tlsBlock.indexOf('location = /autodiscover/autodiscover.xml');
    const redirectPos = tlsBlock.indexOf('location = /old');
    const proxyPos = tlsBlock.indexOf('location = /api');
    const rootPos = tlsBlock.indexOf('location / {');
    assert.ok(mailPos >= 0 && mailPos < redirectPos);
    assert.ok(redirectPos < proxyPos);
    if (rootPos >= 0) assert.ok(proxyPos < rootPos);

    // ACME location remains untouched in HTTP block
    assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//);
  });

  test(`${kind}: serviceOverride suppresses proxyRouteLocations`, () => {
    const config = render({
      primaryDomain: 'owned.example.com',
      ...target,
      nginxSettings: {
        serviceOverride: { mode: 'unavailable' },
        proxyRoutes: [apiRoute],
      },
    });
    assert.equal(config.includes('location = /api'), false);
    assert.equal(config.includes('location ^~ /api/'), false);
    assert.match(config, /return 503;/);
  });
}

test('redirect site rejects proxyRoutes during template rendering', () => {
  assert.throws(
    () => renderRedirectSiteConfig({
      primaryDomain: 'old.example.com',
      target: { url: 'https://new.example.com', status: 301, preservePath: true },
      nginxSettings: { proxyRoutes: [apiRoute] },
    }),
    { code: 'invalid_nginx_settings' },
  );
});
