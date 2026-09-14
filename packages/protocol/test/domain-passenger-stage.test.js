import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationEnvelope, OPERATIONS } from '../src/index-node-passenger.js';

const payload = Object.freeze({
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
  targetType: 'passenger',
  target: Object.freeze({
    root: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current',
    startupFile: 'server.js',
    nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  }),
  nginxSettings: Object.freeze({
    clientMaxBodySizeMb: 64,
    headers: Object.freeze([{ name: 'X-App', value: 'yunpanel', always: true }]),
  }),
  canonicalRedirect: false,
  httpsRedirect: true,
});

test('domain.stage accepts the canonical Passenger routing contract', () => {
  const envelope = createOperationEnvelope({
    id: 'passenger-domain-stage-1',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload,
  });
  assert.deepEqual(envelope.payload, payload);
});

test('domain.stage accepts the same nested startup path as the Node runtime contract', () => {
  const nested = {
    ...payload,
    target: { ...payload.target, startupFile: 'src/server.js' },
  };
  const envelope = createOperationEnvelope({
    id: 'passenger-domain-stage-nested',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: nested,
  });
  assert.equal(envelope.payload.target.startupFile, 'src/server.js');
});

test('domain.stage rejects proxy-only settings after Passenger cutover', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'passenger-domain-stage-2',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      ...payload,
      nginxSettings: {
        ...payload.nginxSettings,
        websocket: true,
        proxyTimeoutSeconds: 60,
      },
    },
  }));
});

test('domain.stage rejects unsafe Passenger runtime paths', () => {
  for (const target of [
    { ...payload.target, root: '/var/lib/yunpanel/apps/../escape/current' },
    { ...payload.target, nodeBinary: '/opt/yunpanel/../tmp/node' },
    { ...payload.target, startupFile: '../server.js' },
    { ...payload.target, startupFile: '/server.js' },
    { ...payload.target, startupFile: 'src//server.js' },
  ]) {
    assert.throws(() => createOperationEnvelope({
      id: 'passenger-domain-stage-3',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: { ...payload, target },
    }));
  }
});
