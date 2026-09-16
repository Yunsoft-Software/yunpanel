import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublicDnsReachabilityInspector,
  PublicDnsReachabilityInspectorError,
} from '../src/public-dns-reachability-inspector.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const identity = Object.freeze({ settings: Object.freeze({ publicIpv4: '203.0.113.10', publicIpv6: '2001:db8::10' }) });

test('public DNS reachability stays unverified when no external vantage probe is configured', async () => {
  const inspector = createPublicDnsReachabilityInspector();
  const state = await inspector.inspect({ serverId, identity });
  assert.equal(state.status, 'unverified');
  assert.equal(state.ready, false);
  assert.equal(state.udp53, null);
  assert.equal(state.tcp53, null);
  assert.equal(state.reason, 'external_vantage_probe_unconfigured');
  assert.equal(state.checkedAt, null);
  assert.deepEqual(state.targets, { ipv4: '203.0.113.10', ipv6: '2001:db8::10' });
});

test('public DNS reachability accepts only explicit external-vantage UDP and TCP evidence', async () => {
  const inspector = createPublicDnsReachabilityInspector({
    probe: async (input) => {
      assert.deepEqual(input, {
        serverId,
        ipv4: '203.0.113.10',
        ipv6: '2001:db8::10',
        port: 53,
        protocols: ['udp', 'tcp'],
      });
      return { externalVantage: true, vantage: 'probe-eu-1', udp53: true, tcp53: false };
    },
    now: () => Date.parse('2026-09-16T01:30:00.000Z'),
  });
  const state = await inspector.inspect({ serverId, identity });
  assert.equal(state.status, 'unreachable');
  assert.equal(state.ready, false);
  assert.equal(state.udp53, true);
  assert.equal(state.tcp53, false);
  assert.equal(state.vantage, 'probe-eu-1');
  assert.equal(state.checkedAt, '2026-09-16T01:30:00.000Z');
});

test('local or malformed probe evidence cannot be promoted to public-ready', async () => {
  const inspector = createPublicDnsReachabilityInspector({
    probe: async () => ({ externalVantage: false, vantage: 'localhost', udp53: true, tcp53: true }),
  });
  await assert.rejects(
    inspector.inspect({ serverId, identity }),
    (error) => error instanceof PublicDnsReachabilityInspectorError
      && error.code === 'public_dns_probe_result_invalid',
  );
});

test('external probe failures are visible as unverifiable instead of false absence or readiness', async () => {
  const inspector = createPublicDnsReachabilityInspector({
    probe: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); },
    now: () => Date.parse('2026-09-16T01:31:00.000Z'),
  });
  const state = await inspector.inspect({ serverId, identity });
  assert.equal(state.status, 'unverifiable');
  assert.equal(state.ready, false);
  assert.equal(state.reason, 'ETIMEOUT');
  assert.equal(state.checkedAt, '2026-09-16T01:31:00.000Z');
});
