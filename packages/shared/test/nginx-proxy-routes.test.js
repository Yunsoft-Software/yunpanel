import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxSettingsValidationError,
  nginxSettingsPolicy,
  normalizeNginxSettings,
} from '../src/index.js';

const PROJECT_ID = '0bb78242-03a6-429f-9d17-7725c521437c';

const route = (overrides = {}) => ({
  path: '/api',
  projectId: PROJECT_ID,
  serviceName: 'api',
  targetPort: 3000,
  protocol: 'tcp',
  upstreamHost: '127.0.0.1',
  upstreamPort: 13000,
  websocket: true,
  stripPrefix: false,
  ...overrides,
});

test('proxyRoutes is optional on static, proxy, passenger, php, python and leaves legacy envelopes byte-for-byte unchanged', () => {
  assert.equal(nginxSettingsPolicy.maxProxyRoutes, 20);
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python']) {
    const legacy = normalizeNginxSettings(target, {});
    assert.equal(Object.hasOwn(legacy, 'proxyRoutes'), false);

    const withRoute = normalizeNginxSettings(target, { proxyRoutes: [route()] });
    assert.deepEqual(withRoute.proxyRoutes, [route()]);
    assert.ok(Object.isFrozen(withRoute.proxyRoutes));
    assert.ok(Object.isFrozen(withRoute.proxyRoutes[0]));

    const cleared = normalizeNginxSettings(target, { proxyRoutes: null }, withRoute);
    assert.equal(cleared.proxyRoutes, null);

    const empty = normalizeNginxSettings(target, { proxyRoutes: [] }, withRoute);
    assert.deepEqual(empty.proxyRoutes, []);
  }

  // Preserved across partial merges on base
  const base = normalizeNginxSettings('php', { proxyRoutes: [route()] });
  const updated = normalizeNginxSettings('php', { clientMaxBodySizeMb: 32 }, base);
  assert.deepEqual(updated.proxyRoutes, [route()]);
});

test('redirect target rejects proxyRoutes', () => {
  assert.throws(
    () => normalizeNginxSettings('redirect', { proxyRoutes: [route()] }),
    (error) => error instanceof NginxSettingsValidationError && error.code === 'invalid_nginx_settings',
  );
  assert.throws(
    () => normalizeNginxSettings('redirect', { proxyRoutes: null }),
    (error) => error instanceof NginxSettingsValidationError && error.code === 'invalid_nginx_settings',
  );
});

test('proxyRoutes accepts valid nested segments, IPv4 loopback variants, IPv6 loopback, and normalizes uppercase UUID', () => {
  const settings = normalizeNginxSettings('static', {
    proxyRoutes: [
      route({ path: '/api/v1.2_beta-0', projectId: PROJECT_ID.toUpperCase(), upstreamHost: '127.0.0.1', upstreamPort: 1024 }),
      route({ path: '/graphql', upstreamHost: '127.1.2.3', upstreamPort: 65535, websocket: false, stripPrefix: true }),
      route({ path: '/ws', upstreamHost: '::1', upstreamPort: 18080, targetPort: 1 }),
      route({ path: '/api2', upstreamHost: '127.255.255.254', upstreamPort: 18081, targetPort: 65535 }),
    ],
  });
  assert.equal(settings.proxyRoutes.length, 4);
  assert.equal(settings.proxyRoutes[0].projectId, PROJECT_ID);
  assert.equal(settings.proxyRoutes[2].upstreamHost, '::1');
});

test('proxyRoutes rejects injection, root path, trailing slash, dot segments, reserved paths, non-loopback hosts, privileged ports, bad UUID/service, and extra/missing keys', () => {
  const invalidEntries = [
    route({ path: '/' }),
    route({ path: '' }),
    route({ path: 'api' }),
    route({ path: '/api/' }),
    route({ path: '//api' }),
    route({ path: '/api//v1' }),
    route({ path: '/.well-known' }),
    route({ path: '/.well-known/acme-challenge' }),
    route({ path: '/.git' }),
    route({ path: '/api/.env' }),
    route({ path: '/api/.' }),
    route({ path: '/api/..' }),
    route({ path: '/autodiscover' }),
    route({ path: '/AutoDiscover/autodiscover.xml' }),
    route({ path: '/mail/config-v1.1.xml' }),
    route({ path: '/MAIL/config-v1.1.xml/x' }),
    route({ path: '/api;return 200;' }),
    route({ path: '/api { }' }),
    route({ path: '/api\nproxy_pass http://127.0.0.1:9999;' }),
    route({ path: '/api$request_uri' }),
    route({ path: '/api?foo=bar' }),
    route({ path: '/api#frag' }),
    route({ path: '/api "quoted"' }),
    route({ path: "/api'single" }),
    route({ path: '/api with space' }),
    route({ path: `/${'a'.repeat(128)}` }),
    route({ projectId: 'not-a-uuid' }),
    route({ projectId: '' }),
    route({ serviceName: 'UPPER' }),
    route({ serviceName: '-bad' }),
    route({ serviceName: 'bad space' }),
    route({ serviceName: 'a'.repeat(64) }),
    route({ targetPort: 0 }),
    route({ targetPort: 65536 }),
    route({ targetPort: 3000.5 }),
    route({ targetPort: '3000' }),
    route({ protocol: 'udp' }),
    route({ protocol: 'http' }),
    route({ upstreamHost: '0.0.0.0' }),
    route({ upstreamHost: 'localhost' }),
    route({ upstreamHost: '10.0.0.1' }),
    route({ upstreamHost: '192.168.1.10' }),
    route({ upstreamHost: '127.0.0.256' }),
    route({ upstreamHost: '::' }),
    route({ upstreamHost: '[::1]' }),
    route({ upstreamHost: '127.0.0.1;evil' }),
    route({ upstreamPort: 80 }),
    route({ upstreamPort: 1023 }),
    route({ upstreamPort: 65536 }),
    route({ upstreamPort: 13000.2 }),
    route({ upstreamPort: '13000' }),
    route({ websocket: 'true' }),
    route({ stripPrefix: 1 }),
    route({ extra: true }),
    { path: '/api', projectId: PROJECT_ID },
  ];

  for (const entry of invalidEntries) {
    assert.throws(
      () => normalizeNginxSettings('static', { proxyRoutes: [entry] }),
      (error) => error instanceof NginxSettingsValidationError && error.code === 'invalid_nginx_proxy_route',
      `Expected entry to fail: ${JSON.stringify(entry)}`,
    );
  }

  assert.throws(
    () => normalizeNginxSettings('static', { proxyRoutes: 'not-an-array' }),
    { code: 'invalid_nginx_proxy_routes' },
  );
  assert.throws(
    () => normalizeNginxSettings('static', {
      proxyRoutes: Array.from({ length: 21 }, (_, index) => route({ path: `/p${index}` })),
    }),
    { code: 'invalid_nginx_proxy_routes' },
  );
});

test('proxyRoutes rejects duplicate paths and overlapping/nested prefixes', () => {
  assert.throws(
    () => normalizeNginxSettings('static', {
      proxyRoutes: [
        route({ path: '/api', upstreamPort: 13000 }),
        route({ path: '/api', upstreamPort: 13001 }),
      ],
    }),
    { code: 'duplicate_nginx_proxy_route' },
  );

  assert.throws(
    () => normalizeNginxSettings('static', {
      proxyRoutes: [
        route({ path: '/api', upstreamPort: 13000 }),
        route({ path: '/api/v1', upstreamPort: 13001 }),
      ],
    }),
    { code: 'overlapping_nginx_proxy_routes' },
  );

  assert.throws(
    () => normalizeNginxSettings('static', {
      proxyRoutes: [
        route({ path: '/api/v1/users', upstreamPort: 13001 }),
        route({ path: '/api/v1', upstreamPort: 13000 }),
      ],
    }),
    { code: 'overlapping_nginx_proxy_routes' },
  );

  // Sibling prefix sharing characters without '/' boundary is NOT overlapping
  const siblings = normalizeNginxSettings('static', {
    proxyRoutes: [
      route({ path: '/api', upstreamPort: 13000 }),
      route({ path: '/api2', upstreamPort: 13001 }),
    ],
  });
  assert.equal(siblings.proxyRoutes.length, 2);
});

test('proxyRoutes detects cross-field conflicts with redirectRules and errorPages', () => {
  // Exact redirect at same path
  assert.throws(
    () => normalizeNginxSettings('static', {
      redirectRules: [{ source: '/api', target: '/v2', status: 301, match: 'exact' }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_redirect_conflict' },
  );

  // Exact redirect inside proxy route subtree
  assert.throws(
    () => normalizeNginxSettings('static', {
      redirectRules: [{ source: '/api/legacy', target: '/v2', status: 302, match: 'exact' }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_redirect_conflict' },
  );

  // Prefix redirect equal to route prefix
  assert.throws(
    () => normalizeNginxSettings('static', {
      redirectRules: [{ source: '/api/', target: '/v2/', status: 301, match: 'prefix' }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_redirect_conflict' },
  );

  // Prefix redirect containing proxy route
  assert.throws(
    () => normalizeNginxSettings('static', {
      redirectRules: [{ source: '/api/', target: '/v2/', status: 301, match: 'prefix' }],
      proxyRoutes: [route({ path: '/api/v1' })],
    }),
    { code: 'nginx_proxy_route_redirect_conflict' },
  );

  // Prefix redirect inside proxy route
  assert.throws(
    () => normalizeNginxSettings('static', {
      redirectRules: [{ source: '/api/v1/', target: '/v2/', status: 301, match: 'prefix' }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_redirect_conflict' },
  );

  // Error page inside proxy route
  assert.throws(
    () => normalizeNginxSettings('static', {
      errorPages: { 404: '/api/404.html' },
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_error_page_conflict' },
  );

  // Non-overlapping redirect and error page are allowed
  const ok = normalizeNginxSettings('static', {
    redirectRules: [
      { source: '/old', target: '/new', status: 301, match: 'exact' },
      { source: '/blog/', target: '/news/', status: 302, match: 'prefix' },
    ],
    errorPages: { 404: '/errors/404.html' },
    proxyRoutes: [route({ path: '/api' })],
  });
  assert.equal(ok.proxyRoutes.length, 1);
});

test('proxyRoutes rejects overlapping protectedPaths (exact, parent, child) while allowing disjoint paths', () => {
  const key = '0123456789abcdef';

  // Exact overlap: protected /api/ + proxy /api
  assert.throws(
    () => normalizeNginxSettings('static', {
      protectedPaths: [{ path: '/api/', key }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_protected_path_conflict' },
  );

  // Protected parent contains proxy route: protected /admin/ + proxy /admin/api
  assert.throws(
    () => normalizeNginxSettings('static', {
      protectedPaths: [{ path: '/admin/', key }],
      proxyRoutes: [route({ path: '/admin/api' })],
    }),
    { code: 'nginx_proxy_route_protected_path_conflict' },
  );

  // Proxy route contains protected child: protected /api/secret/ + proxy /api
  assert.throws(
    () => normalizeNginxSettings('static', {
      protectedPaths: [{ path: '/api/secret/', key }],
      proxyRoutes: [route({ path: '/api' })],
    }),
    { code: 'nginx_proxy_route_protected_path_conflict' },
  );

  // Disjoint paths coexist cleanly (/admin/ protected + /api and /api2 proxied)
  const disjoint = normalizeNginxSettings('static', {
    protectedPaths: [{ path: '/admin/', key }, { path: '/api2/', key: 'fedcba9876543210' }],
    proxyRoutes: [route({ path: '/api' })],
  });
  assert.equal(disjoint.protectedPaths.length, 2);
  assert.equal(disjoint.proxyRoutes.length, 1);
});
