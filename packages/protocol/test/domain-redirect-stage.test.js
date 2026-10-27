import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationEnvelope, OPERATIONS } from '../src/index-node-passenger.js';

const payload = Object.freeze({
  primaryDomain: 'eski.example.com',
  aliases: Object.freeze(['www.eski.example.com']),
  targetType: 'redirect',
  target: Object.freeze({ url: 'https://yeni.example.com', status: 301, preservePath: true }),
  nginxSettings: Object.freeze({ clientMaxBodySizeMb: null, headers: Object.freeze([]) }),
  canonicalRedirect: false,
  httpsRedirect: false,
});
const stage = (value, id = 'redirect-stage') => createOperationEnvelope({ id, operation: OPERATIONS.DOMAIN_STAGE, payload: value });

test('domain.stage accepts a canonical forwarding-only Domain', () => {
  assert.deepEqual(stage(payload).payload, payload);
});

test('domain.stage rejects unsafe or non-canonical redirect targets and serving settings', () => {
  for (const target of [{ url: 'https://x.com/;deny all', status: 301, preservePath: true }, { url: 'https://x.com/', status: 301, preservePath: true },
    { url: 'https://x.com', status: 307, preservePath: true }, { url: 'https://x.com', status: 301, preservePath: true, root: '/var/www' }]) {
    assert.throws(() => stage({ ...payload, target }), undefined, JSON.stringify(target));
  }
  assert.throws(() => stage({ ...payload, nginxSettings: { ...payload.nginxSettings, gzip: true } }));
});
