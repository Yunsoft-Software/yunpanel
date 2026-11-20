import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNginxSettings } from '@yunpanel/shared';
import { createOperationEnvelope, OPERATIONS } from '../src/index-node-passenger.js';

const PROJECT_ID = '0bb78242-03a6-429f-9d17-7725c521437c';

const proxyRoutes = Object.freeze([
  Object.freeze({
    path: '/api',
    projectId: PROJECT_ID,
    serviceName: 'api',
    targetPort: 3000,
    protocol: 'tcp',
    upstreamHost: '127.0.0.1',
    upstreamPort: 13000,
    websocket: true,
    stripPrefix: false,
  }),
]);

const validStages = [
  ['static', { root: '/var/lib/yunpanel/apps/site/current', spaFallback: true }],
  ['proxy', { host: '127.0.0.1', port: 3000, websocket: true }],
  ['passenger', {
    appRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
    documentRoot: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
    startupFile: 'server.js',
    nodeBinary: '/usr/bin/node',
    user: 'yunapp-0123456789ab',
    group: 'yunapp-0123456789ab',
    appEnv: 'production',
    environmentInclude: null,
  }],
  ['php', {
    root: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
    socketPath: '/run/php/yunpanel-yunapp-0123456789ab.sock',
  }],
  ['python', {
    socketPath: '/run/yunpanel/python-11111111-1111-4111-8111-111111111111.sock',
  }],
];

for (const [targetType, target] of validStages) {
  test(`domain.stage accepts canonical proxyRoutes for ${targetType} targets`, () => {
    const nginxSettings = normalizeNginxSettings(targetType, { proxyRoutes });
    const payload = {
      primaryDomain: `${targetType}.example.com`,
      aliases: [],
      targetType,
      target,
      nginxSettings,
      canonicalRedirect: false,
      httpsRedirect: false,
      domainRevision: 2,
    };
    const envelope = createOperationEnvelope({
      id: `stage-proxy-routes-${targetType}`,
      operation: OPERATIONS.DOMAIN_STAGE,
      payload,
    });
    assert.deepEqual(envelope.payload.nginxSettings.proxyRoutes, proxyRoutes);
  });

  test(`domain.stage rejects non-canonical or unsafe proxyRoutes for ${targetType} targets`, () => {
    const base = normalizeNginxSettings(targetType, {});
    for (const badRoutes of [
      [{ ...proxyRoutes[0], path: '/api;return 200;' }],
      [{ ...proxyRoutes[0], upstreamHost: '10.0.0.5' }],
      [{ ...proxyRoutes[0], upstreamPort: 80 }],
      [{ ...proxyRoutes[0], projectId: PROJECT_ID.toUpperCase() }],
    ]) {
      assert.throws(() => createOperationEnvelope({
        id: `stage-proxy-routes-bad-${targetType}`,
        operation: OPERATIONS.DOMAIN_STAGE,
        payload: {
          primaryDomain: `${targetType}.example.com`,
          aliases: [],
          targetType,
          target,
          nginxSettings: { ...base, proxyRoutes: badRoutes },
          canonicalRedirect: false,
          httpsRedirect: false,
          domainRevision: 2,
        },
      }));
    }
  });
}

test('domain.stage rejects proxyRoutes on redirect targets', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'stage-proxy-routes-redirect',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'old.example.com',
      aliases: [],
      targetType: 'redirect',
      target: { url: 'https://new.example.com', status: 301, preservePath: true },
      nginxSettings: { clientMaxBodySizeMb: null, headers: [], proxyRoutes },
      canonicalRedirect: false,
      httpsRedirect: false,
      domainRevision: 1,
    },
  }));
});
