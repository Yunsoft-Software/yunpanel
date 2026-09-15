import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationEnvelope, OPERATIONS } from '../src/index-node-passenger.js';

const payload = Object.freeze({
  primaryDomain: 'php.example.com',
  aliases: Object.freeze(['www.php.example.com']),
  targetType: 'php',
  target: Object.freeze({
    root: '/var/lib/yunpanel/apps/11111111-1111-4111-8111-111111111111/current/public',
    socketPath: '/run/php/yunpanel-yunapp-0123456789ab.sock',
  }),
  nginxSettings: Object.freeze({
    clientMaxBodySizeMb: 64,
    headers: Object.freeze([{ name: 'X-App', value: 'yunpanel', always: true }]),
  }),
  canonicalRedirect: false,
  httpsRedirect: false,
});

test('domain.stage accepts the materialized PHP routing contract', () => {
  const envelope = createOperationEnvelope({
    id: 'php-domain-stage-1',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload,
  });
  assert.deepEqual(envelope.payload, payload);
});

test('domain.stage rejects arbitrary PHP sockets and extra target fields', () => {
  for (const target of [
    { ...payload.target, socketPath: '/tmp/php.sock' },
    { ...payload.target, socketPath: '/run/php/yunpanel-yunapp-0123456789ab.sock', applicationId: '11111111-1111-4111-8111-111111111111' },
    { ...payload.target, root: '/var/lib/yunpanel/apps/../escape/public' },
  ]) {
    assert.throws(() => createOperationEnvelope({
      id: 'php-domain-stage-2',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: { ...payload, target },
    }));
  }
});

test('domain.stage rejects proxy-only Nginx settings for PHP', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'php-domain-stage-3',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      ...payload,
      nginxSettings: { ...payload.nginxSettings, websocket: true },
    },
  }));
});
