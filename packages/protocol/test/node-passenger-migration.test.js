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
const authority = {
  websiteId: '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75',
  websiteRevision: 3,
  domainId: 'f05764d6-d5e8-4d2a-9bdd-493111b24478',
  domainDesiredRevision: 4,
  domainAppliedRevision: 4,
};

const payload = { node, domain, authority };

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
    { node, domain: { ...domain, target: { nodeBinary: '/tmp/node' } }, authority },
    { node, domain: { ...domain, environmentInclude: '/tmp/env.conf' }, authority },
    { node: { ...node, nodeBinary: '/tmp/node' }, domain, authority },
  ]) {
    assert.throws(() => createOperationEnvelope({
      id: 'passenger-migrate-job-1',
      operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
      payload: candidate,
    }));
  }
});

test('Passenger migration rejects missing or drifting authority snapshots', () => {
  for (const candidate of [
    { node, domain },
    { node, domain, authority: { ...authority, websiteId: 'not-a-uuid' } },
    { node, domain, authority: { ...authority, websiteRevision: 0 } },
    { node, domain, authority: { ...authority, domainAppliedRevision: 3 } },
    { node, domain, authority: { ...authority, extra: true } },
  ]) {
    assert.throws(() => createOperationEnvelope({
      id: 'passenger-migrate-job-authority',
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
      authority,
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
      authority,
    },
  }));
});

test('Passenger migration rejects noncanonical domains and arbitrary Nginx settings', () => {
  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: { node, domain: { ...domain, primaryDomain: 'Example.COM' }, authority },
  }));

  assert.throws(() => createOperationEnvelope({
    id: 'passenger-migrate-job-1',
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    payload: { node, domain: { ...domain, nginxSettings: { rawDirective: 'include /tmp/x;' } }, authority },
  }));
});
