import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import {
  createHostingForm,
  editHostingForm,
  hostingFormDirty,
  reloadHostingForm,
} from '../src/workspace/domain-hosting-form.js';
import {
  hostingSettingsChanges,
  validateHostingSettingsPreview,
} from '../src/workspace/domain-hosting-model.js';
import { aliasErrorMessage } from '../src/workspace/domain-alias-model.js';
import { resolveServerDockerProxyRule } from '../src/workspace/docker-compose-client.js';

register('./jsx-loader.js', import.meta.url);

const {
  NginxSubPathProxyBuilder,
  buildNginxSubPathLocationBlock,
  eligibleDockerProxySlots,
  normalizeSubPathRoute,
} = await import('../src/workspace/DomainHostingPanel.jsx');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'b'.repeat(64);

function sampleRoute(overrides = {}) {
  return {
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
  };
}

function sampleDomain(overrides = {}) {
  return {
    id: 'domain-1',
    serverId: 'server-1',
    websiteId: 'website-1',
    parentDomainId: null,
    primaryDomain: 'example.com',
    aliases: [],
    desiredRevision: 2,
    appliedRevision: 2,
    targetType: 'static',
    target: { root: '/srv/website-1/public', spaFallback: true },
    httpsMode: 'managed',
    httpsRedirect: false,
    canonicalRedirect: false,
    certificateId: 'cert-1',
    state: 'active',
    nginxSettings: {
      clientMaxBodySizeMb: null,
      spaFallback: true,
      staticAssetCacheSeconds: 604800,
      headers: [],
    },
    ...overrides,
  };
}

test('normalizeSubPathRoute accepts safe non-root paths and rejects reserved or unsafe paths', () => {
  assert.equal(normalizeSubPathRoute('/api'), '/api');
  assert.equal(normalizeSubPathRoute('api/v1/'), '/api/v1');
  for (const invalid of ['', '/', '/.well-known', '/.well-known/acme-challenge', '/autodiscover/autodiscover.xml', '/mail/config-v1.1.xml', '/api/../etc', '/api;x', '/api$uri', '/.git']) {
    assert.throws(() => normalizeSubPathRoute(invalid));
  }
});

test('eligibleDockerProxySlots keeps only unambiguous loopback/wildcard TCP ports >= 1024', () => {
  const slots = eligibleDockerProxySlots({
    id: PROJECT_ID,
    projectName: 'shop_api',
    services: [
      {
        name: 'api',
        publishedPorts: [
          { hostIp: '127.0.0.1', publishedPort: 13000, targetPort: 3000, protocol: 'tcp' },
          { hostIp: '::', publishedPort: 13001, targetPort: 3001, protocol: 'tcp' },
          { hostIp: '127.0.0.1', publishedPort: 80, targetPort: 80, protocol: 'tcp' },
          { hostIp: '192.168.1.10', publishedPort: 13002, targetPort: 3002, protocol: 'tcp' },
          { hostIp: '127.0.0.1', publishedPort: 13003, targetPort: 3003, protocol: 'udp' },
          { hostIp: '127.0.0.1', publishedPort: 13004, targetPort: 3004, protocol: 'tcp' },
          { hostIp: '0.0.0.0', publishedPort: 13005, targetPort: 3004, protocol: 'tcp' },
        ],
      },
    ],
  });

  assert.deepEqual(slots, [
    { key: 'api:3000', serviceName: 'api', targetPort: 3000, protocol: 'tcp', upstreamHost: '127.0.0.1', upstreamPort: 13000 },
    { key: 'api:3001', serviceName: 'api', targetPort: 3001, protocol: 'tcp', upstreamHost: '::1', upstreamPort: 13001 },
  ]);
});

test('buildNginxSubPathLocationBlock renders exact and prefix blocks and rejects non-loopback or privileged ports', () => {
  const block = buildNginxSubPathLocationBlock({
    path: '/api',
    innerPort: '3000',
    outerPort: '[::1]:13000',
    websocket: true,
    stripPrefix: true,
  });
  assert.match(block, /location = \/api \{/);
  assert.match(block, /location \^~ \/api\/ \{/);
  assert.match(block, /proxy_pass http:\/\/\[::1\]:13000\/;/);
  assert.throws(() => buildNginxSubPathLocationBlock({ path: '/api', innerPort: '3000', outerPort: '192.168.1.5:13000' }));
  assert.throws(() => buildNginxSubPathLocationBlock({ path: '/api', innerPort: '3000', outerPort: '127.0.0.1:80' }));
});

test('hosting form supports adding, reloading, previewing, and removing proxyRoutes persistently', () => {
  const base = sampleDomain();
  const initial = createHostingForm(base);
  const route = sampleRoute();
  const withRoute = editHostingForm(initial, 'nginxSettings', { ...initial.values.nginxSettings, proxyRoutes: [route] });
  assert.equal(hostingFormDirty(withRoute), true);

  const changes = hostingSettingsChanges(withRoute.base, withRoute.values);
  assert.deepEqual(changes.nginxSettings.proxyRoutes, [route]);

  const preview = {
    version: 1,
    domainId: base.id,
    currentRevision: base.desiredRevision,
    nextRevision: base.desiredRevision + 1,
    previewDigest: DIGEST,
    confirmation: `update-domain:${base.id}:${DIGEST}`,
    next: {
      primaryDomain: base.primaryDomain,
      aliases: base.aliases,
      httpsMode: base.httpsMode,
      httpsRedirect: base.httpsRedirect,
      canonicalRedirect: base.canonicalRedirect,
      nginxSettings: changes.nginxSettings,
    },
    impact: {
      hostnameChanged: false,
      policyChanged: false,
      settingsChanged: true,
      requiresStageAndActivation: true,
      certificate: { id: base.certificateId, detached: false },
    },
  };
  const validated = validateHostingSettingsPreview(withRoute.base, withRoute.values, preview);
  assert.deepEqual(validated.changes.nginxSettings.proxyRoutes, [route]);

  // Reloading after a concurrent change preserves unsaved proxyRoutes draft
  const concurrent = sampleDomain({
    desiredRevision: 3,
    nginxSettings: { ...base.nginxSettings, clientMaxBodySizeMb: 32 },
  });
  const reloaded = reloadHostingForm(withRoute, concurrent, withRoute.base);
  assert.equal(reloaded.values.nginxSettings.clientMaxBodySizeMb, 32);
  assert.deepEqual(reloaded.values.nginxSettings.proxyRoutes, [route]);

  // Removing a saved proxyRoute marks the form dirty with empty proxyRoutes array
  const savedWithRoute = sampleDomain({
    nginxSettings: { ...base.nginxSettings, proxyRoutes: [route] },
  });
  const savedForm = createHostingForm(savedWithRoute);
  const removedForm = editHostingForm(savedForm, 'nginxSettings', { ...savedForm.values.nginxSettings, proxyRoutes: [] });
  assert.equal(hostingFormDirty(removedForm), true);
  assert.deepEqual(hostingSettingsChanges(removedForm.base, removedForm.values).nginxSettings.proxyRoutes, []);
});

test('overlapping protectedPaths and proxyRoutes is rejected in hosting model before preview', () => {
  const base = sampleDomain({
    nginxSettings: {
      ...sampleDomain().nginxSettings,
      protectedPaths: [{ path: '/api/', key: '0123456789abcdef' }],
    },
  });
  const form = createHostingForm(base);
  const conflicting = editHostingForm(form, 'nginxSettings', {
    ...form.values.nginxSettings,
    proxyRoutes: [sampleRoute({ path: '/api' })],
  });
  assert.throws(
    () => hostingSettingsChanges(conflicting.base, conflicting.values),
    (error) => error?.code === 'nginx_proxy_route_protected_path_conflict',
  );
  assert.match(aliasErrorMessage({ code: 'proxy_routes_owner_only' }), /sunucu sahibi/);
});

test('NginxSubPathProxyBuilder renders clean persistent Owner controls and read-only non-Owner view without jargon', () => {
  const domain = sampleDomain({
    nginxSettings: { ...sampleDomain().nginxSettings, proxyRoutes: [sampleRoute()] },
  });
  const projects = [{
    id: PROJECT_ID,
    serverId: 'server-1',
    projectName: 'shop_api',
    services: [{
      name: 'api',
      publishedPorts: [{ hostIp: '127.0.0.1', publishedPort: 13000, targetPort: 3000, protocol: 'tcp' }],
    }],
  }];

  const ownerHtml = renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(NginxSubPathProxyBuilder, {
      domain,
      routes: [sampleRoute()],
      isOwner: true,
      onChange: () => {},
      projects,
    }),
  ));
  assert.ok(ownerHtml.includes('Alt yol proxy kuralları'));
  assert.ok(ownerHtml.includes('Docker projesi'));
  assert.ok(ownerHtml.includes('Servis ve port'));
  assert.ok(ownerHtml.includes('Alt yol kuralı ekle'));
  assert.ok(ownerHtml.includes('Kaldır'));
  assert.ok(ownerHtml.includes('href="/docker"'));
  assert.ok(ownerHtml.includes('shop_api'));
  assert.ok(ownerHtml.includes('127.0.0.1:13000'));
  assert.equal(ownerHtml.includes('(Location)'), false);
  assert.equal(ownerHtml.includes('(Upgrade)'), false);
  assert.equal(ownerHtml.includes('Inner / Konteyner'), false);
  assert.equal(ownerHtml.includes('Outer / Yerel Host'), false);

  const nonOwnerHtml = renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(NginxSubPathProxyBuilder, {
      domain,
      routes: [sampleRoute()],
      isOwner: false,
      onChange: () => {},
    }),
  ));
  assert.ok(nonOwnerHtml.includes('/api'));
  assert.ok(nonOwnerHtml.includes('sunucu sahibi'));
  assert.equal(nonOwnerHtml.includes('Alt yol kuralı ekle'), false);
  assert.equal(nonOwnerHtml.includes('href="/docker"'), false);
  assert.equal(typeof resolveServerDockerProxyRule, 'function');
});
