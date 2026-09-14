import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  OPERATIONS,
} from '../src/index-node-passenger.js';

const node = {
  applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
  releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
  runtime: {
    nodeMajor: 24,
    port: 3100,
    start: { mode: 'node', entryFile: 'server.js' },
  },
};
const domain = {
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  tls: null,
  canonicalRedirect: true,
  httpsRedirect: true,
};

const payload = { node, domain };

test('Passenger migration is an explicit mutation with a narrow public payload', () => {
  assert.equal(isKnownOperation(OPERATIONS.APP_NODE_PASSENGER_MIGRATE), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.APP_NODE_PASSENGER_MIGRATE), false);
  const envelope = createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload,
  });
  assert.deepEqual(envelope.payload, payload);
});

test('Passenger migration rejects host-level target and operation ownership injection', () => {
  for (const candidate of [
    { ...payload, operationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9' },
    { node, domain: { ...domain, target: { nodeBinary: '/tmp/node' } } },
    { node, domain: { ...domain, environmentInclude: '/tmp/env.conf' } },
    { node: { ...node, nodeBinary: '/tmp/node' }, domain },
  ]) {
    assert.throws(() => createOperationEnvelope({
      id: 'passenger-migrate-job-1',
      operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
      payload: candidate,
    }));
  }
});

test('Passenger migration rejects npm start mode and unsafe TLS paths', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: {
      node: {
        ...node,
        runtime: { ...node.runtime, start: { mode: 'npm', script: 'start' } },
      },
      domain,
    },
  }));

  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: {
      node,
      domain: {
        ...domain,
        tls: {
          fullchainPath: '/etc/letsencrypt/live/example.com/../other/fullchain.pem',
          privateKeyPath: '/etc/letsencrypt/live/example.com/privkey.pem',
        },
      },
    },
  }));
});

test('Passenger migration rejects noncanonical domains and arbitrary Nginx settings', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: { node, domain: { ...domain, primaryDomain: 'Example.COM' } },
  }));

  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: { node, domain: { ...domain, nginxSettings: { rawDirective: 'include /tmp/x;' } } },
  }));
});
