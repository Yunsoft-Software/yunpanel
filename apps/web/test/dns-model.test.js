import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dnsRecordDeletePayload,
  dnsRecordDraft,
  dnsRecordEditable,
  dnsRecordPayload,
  dnsRrsetValues,
  dnssecPresentation,
  relativeDnsOwner,
  rootDnsDomain,
} from '../src/workspace/dns-model.js';

const root = { id: 'root', primaryDomain: 'example.com', parentDomainId: null };
const child = { id: 'child', primaryDomain: 'api.example.com', parentDomainId: 'root' };
const grandchild = { id: 'grandchild', primaryDomain: 'v2.api.example.com', parentDomainId: 'child' };

test('DNS workspace resolves the authoritative root Domain without inventing subdomain zones', () => {
  assert.equal(rootDnsDomain(grandchild, [root, child, grandchild]), root);
  assert.equal(rootDnsDomain(child, [root, child]), root);
  assert.equal(rootDnsDomain(root, [root]), root);
  assert.equal(rootDnsDomain({ ...child, parentDomainId: 'missing' }, [root, child]), null);
  const cycleA = { id: 'a', parentDomainId: 'b' };
  const cycleB = { id: 'b', parentDomainId: 'a' };
  assert.equal(rootDnsDomain(cycleA, [cycleA, cycleB]), null);
});

test('DNS workspace keeps managed RRsets read-only and builds manual record payloads with current serial', () => {
  const managed = { owner: 'example.com', type: 'A', ttl: 300, source: 'template', records: [{ value: '203.0.113.10', disabled: false }] };
  const manual = { owner: 'custom.example.com', type: 'TXT', ttl: 600, source: 'manual', records: [{ value: 'hello', disabled: false }, { value: 'ignored', disabled: true }] };
  assert.equal(dnsRecordEditable(managed), false);
  assert.equal(dnsRecordEditable(manual), true);
  assert.deepEqual(dnsRrsetValues(manual), ['hello']);
  assert.deepEqual(dnsRecordDraft(manual, 'example.com'), { owner: 'custom', type: 'TXT', ttl: '600', values: 'hello' });
  assert.deepEqual(dnsRecordPayload({ owner: 'custom', type: 'txt', ttl: '600', values: 'hello\nworld' }, 2026091601), {
    owner: 'custom', type: 'TXT', ttl: 600, values: ['hello', 'world'], expectedSerial: 2026091601,
  });
  assert.deepEqual(dnsRecordDeletePayload(manual, 'example.com', 2026091602), {
    owner: 'custom', type: 'TXT', expectedSerial: 2026091602,
  });
  assert.equal(relativeDnsOwner('example.com.', 'example.com'), '@');
});

test('DNS record form rejects invalid TTL, empty values and multi-value CNAME before API mutation', () => {
  assert.throws(() => dnsRecordPayload({ owner: '@', type: 'A', ttl: '30', values: '203.0.113.10' }, 1), /TTL/);
  assert.throws(() => dnsRecordPayload({ owner: '@', type: 'A', ttl: '300', values: '' }, 1), /En az bir/);
  assert.throws(() => dnsRecordPayload({ owner: 'www', type: 'CNAME', ttl: '300', values: 'a.example.com\nb.example.com' }, 1), /tam olarak bir/);
});

test('DNSSEC presentation never labels pending or mismatched delegation as secure', () => {
  assert.deepEqual(dnssecPresentation('secure_ready'), { state: 'active', label: 'Güvenli delegasyon' });
  assert.equal(dnssecPresentation('pending_parent_ds').state, 'pending');
  assert.equal(dnssecPresentation('parent_ds_mismatch').state, 'error');
  assert.equal(dnssecPresentation('signing_material_incomplete').state, 'error');
  assert.equal(dnssecPresentation('insecure').state, 'off');
});
