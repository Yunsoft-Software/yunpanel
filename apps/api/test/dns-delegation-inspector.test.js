import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDnsDelegationInspector,
  DnsDelegationInspectorError,
} from '../src/dns-delegation-inspector.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

function identity({
  ns1 = { hostname: 'ns1.example.com', ipv4: '203.0.113.10', ipv6: null, local: true },
  ns2 = { hostname: 'ns2.example.com', ipv4: '203.0.113.11', ipv6: null, local: false },
} = {}) {
  return {
    serverId,
    revision: 7,
    settings: { ns1, ns2 },
  };
}

function resolverFixture({
  ns = ['ns1.example.com', 'ns2.example.com'],
  ipv4 = {
    'ns1.example.com': ['203.0.113.10'],
    'ns2.example.com': ['203.0.113.11'],
  },
  ipv6 = {},
  failures = {},
} = {}) {
  async function resolve(kind, name, answers) {
    const failure = failures[`${kind}:${name}`];
    if (failure) {
      const error = new Error(failure);
      error.code = failure;
      throw error;
    }
    return answers[name] ?? [];
  }
  return {
    resolveNs: async (name) => {
      const failure = failures[`ns:${name}`];
      if (failure) {
        const error = new Error(failure);
        error.code = failure;
        throw error;
      }
      return ns;
    },
    resolve4: (name) => resolve('a', name, ipv4),
    resolve6: (name) => resolve('aaaa', name, ipv6),
  };
}

function inspector({ record = identity(), resolver = resolverFixture() } = {}) {
  return createDnsDelegationInspector({
    dnsIdentityRegistry: { getForServer: async () => record },
    resolver,
    now: () => Date.parse('2026-09-15T20:00:00.000Z'),
  });
}

test('DNS delegation inspector reports ready when parent delegation and nameserver addresses match', async () => {
  const result = await inspector().inspect({ serverId, domain: 'example.com' });

  assert.equal(result.status, 'ready');
  assert.equal(result.ready, true);
  assert.deepEqual(result.delegation.expected, ['ns1.example.com', 'ns2.example.com']);
  assert.deepEqual(result.delegation.observed, ['ns1.example.com', 'ns2.example.com']);
  assert.equal(result.nameservers.every((entry) => entry.ready), true);
  assert.equal(result.registrarInstructions.nameservers.every((entry) => entry.glueRequiredForThisDomain), true);
  assert.equal(result.checkedAt, '2026-09-15T20:00:00.000Z');
});

test('DNS delegation inspector distinguishes missing delegation from nameserver address readiness', async () => {
  const result = await inspector({
    resolver: resolverFixture({ ns: ['ns1.example.com'] }),
  }).inspect({ serverId, domain: 'example.com' });

  assert.equal(result.status, 'pending_delegation');
  assert.equal(result.ready, false);
  assert.deepEqual(result.delegation.missing, ['ns2.example.com']);
});

test('DNS delegation inspector reports pending glue for unresolved in-bailiwick nameservers', async () => {
  const result = await inspector({
    resolver: resolverFixture({
      failures: { 'a:ns1.example.com': 'ENOTFOUND' },
    }),
  }).inspect({ serverId, domain: 'example.com' });

  assert.equal(result.status, 'pending_glue');
  assert.equal(result.nameservers[0].inBailiwick, true);
  assert.equal(result.nameservers[0].ready, false);
  assert.equal(result.nameservers[0].ipv4ErrorCode, 'ENOTFOUND');
});

test('DNS delegation inspector keeps transient resolver failures unverifiable instead of reporting ready', async () => {
  const result = await inspector({
    resolver: resolverFixture({ failures: { 'ns:example.com': 'ETIMEOUT' } }),
  }).inspect({ serverId, domain: 'example.com' });

  assert.equal(result.status, 'unverifiable');
  assert.equal(result.ready, false);
  assert.equal(result.delegation.errorCode, 'ETIMEOUT');
});

test('DNS delegation inspector reports external nameserver address drift separately', async () => {
  const record = identity({
    ns1: { hostname: 'ns1.provider.net', ipv4: '198.51.100.10', ipv6: null, local: true },
    ns2: { hostname: 'ns2.provider.net', ipv4: '198.51.100.11', ipv6: null, local: false },
  });
  const result = await inspector({
    record,
    resolver: resolverFixture({
      ns: ['ns1.provider.net', 'ns2.provider.net'],
      ipv4: {
        'ns1.provider.net': ['198.51.100.10'],
        'ns2.provider.net': ['198.51.100.99'],
      },
    }),
  }).inspect({ serverId, domain: 'example.com' });

  assert.equal(result.status, 'pending_nameserver_address');
  assert.equal(result.nameservers[1].inBailiwick, false);
  assert.equal(result.nameservers[1].ready, false);
});

test('DNS delegation inspector fails closed until server DNS identity exists', async () => {
  await assert.rejects(
    inspector({ record: null }).inspect({ serverId, domain: 'example.com' }),
    (error) => error instanceof DnsDelegationInspectorError
      && error.code === 'dns_delegation_identity_required'
      && error.status === 409,
  );
});
