import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPowerDnsSocketHealthInspector,
  PowerDnsSocketHealthError,
  powerDnsSocketHealthInternals,
} from '../src/powerdns-socket-health-inspector.js';

function response({ id, rcode = 0, ra = false, aa = false } = {}) {
  const packet = Buffer.alloc(12);
  packet.writeUInt16BE(id, 0);
  let flags = 0x8000 | (rcode & 0x000f);
  if (ra) flags |= 0x0080;
  if (aa) flags |= 0x0400;
  packet.writeUInt16BE(flags, 2);
  return packet;
}

test('PowerDNS socket readiness requires UDP, TCP and refused recursion', async () => {
  let udpCalls = 0;
  const inspector = createPowerDnsSocketHealthInspector({
    async udpProbe(query) {
      udpCalls += 1;
      return udpCalls === 1
        ? { rcode: 3, recursionAvailable: false, authoritative: true }
        : { rcode: 5, recursionAvailable: false, authoritative: false };
    },
    async tcpProbe() {
      return { rcode: 3, recursionAvailable: false, authoritative: true };
    },
  });

  const result = await inspector.inspect();
  assert.equal(result.satisfied, true);
  assert.equal(result.udp53, true);
  assert.equal(result.tcp53, true);
  assert.equal(result.recursive, false);
  assert.deepEqual(result.recursion, { rcode: 5, available: false });
});

test('PowerDNS socket readiness rejects open-recursion behavior', async () => {
  let udpCalls = 0;
  const inspector = createPowerDnsSocketHealthInspector({
    async udpProbe() {
      udpCalls += 1;
      return udpCalls === 1
        ? { rcode: 3, recursionAvailable: false, authoritative: true }
        : { rcode: 0, recursionAvailable: true, authoritative: false };
    },
    async tcpProbe() {
      return { rcode: 3, recursionAvailable: false, authoritative: true };
    },
  });

  const result = await inspector.inspect();
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'powerdns_recursion_policy_invalid');
  assert.deepEqual(result.recursion, { rcode: 0, available: true });
});

test('PowerDNS socket readiness returns actionable probe failures', async () => {
  const inspector = createPowerDnsSocketHealthInspector({
    async udpProbe() {
      throw new PowerDnsSocketHealthError('powerdns_udp_unavailable', 'unavailable');
    },
    async tcpProbe() {
      return { rcode: 3, recursionAvailable: false, authoritative: true };
    },
  });

  const result = await inspector.inspect();
  assert.deepEqual(result, { satisfied: false, reason: 'powerdns_udp_unavailable' });
});

test('PowerDNS DNS response parser validates transaction id and exposes AA/RA/RCODE flags', () => {
  const query = powerDnsSocketHealthInternals.encodeQuestion('probe.example.test');
  const parsed = powerDnsSocketHealthInternals.responseFlags(response({
    id: query.id,
    rcode: 5,
    aa: true,
    ra: false,
  }), query.id);
  assert.deepEqual(parsed, { rcode: 5, recursionAvailable: false, authoritative: true });

  assert.throws(
    () => powerDnsSocketHealthInternals.responseFlags(response({ id: (query.id + 1) % 65536 }), query.id),
    (error) => error instanceof PowerDnsSocketHealthError && error.code === 'powerdns_dns_probe_response_invalid',
  );
});
