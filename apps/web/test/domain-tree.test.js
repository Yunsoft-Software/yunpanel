import assert from 'node:assert/strict';
import test from 'node:test';
import { domainTreeRows } from '../src/domain-tree.js';
import { domainCreatePayload } from '../src/domain-form.js';

const domains = [
  { id: 'b', primaryDomain: 'b.example.com.tr', parentDomainId: 'r', serverId: 's2' },
  { id: 'r', primaryDomain: 'example.com.tr', serverId: 's2', aliases: ['www.example.com.tr'] },
  { id: 'a', primaryDomain: 'a.example.com.tr', parentDomainId: 'r', serverId: 's2' },
  { id: 'n', primaryDomain: 'v2.a.example.com.tr', parentDomainId: 'a', serverId: 's2' },
  { id: 'legacy', primaryDomain: 'legacy.example.com.tr', serverId: 's2' },
];
const ids = (rows) => rows.map((row) => row.domain.id);
const servers = [{ id: 's1' }, { id: 's2' }];
const form = { mode: 'domain', serverId: 's1', primaryDomain: 'new.example.com', prefix: '', parentDomainId: '', aliases: '', targetType: 'proxy', targetValue: '4301', httpsMode: 'off' };

test('tree uses explicit IDs, sorts siblings and does not infer legacy parentage', () => {
  const rows = domainTreeRows(domains);
  assert.deepEqual(ids(rows), ['r', 'a', 'n', 'b', 'legacy']);
  assert.deepEqual(rows.map((row) => row.depth), [0, 1, 2, 1, 0]);
  assert.equal(rows[0].childCount, 2);
});

test('collapsed branches stay hidden, rather than reappearing as orphan roots', () => {
  assert.deepEqual(ids(domainTreeRows(domains, { collapsed: new Set(['r']) })), ['r', 'legacy']);
});

test('search includes matching child ancestry and overrides collapse temporarily', () => {
  const collapsed = new Set(['r', 'a']);
  assert.deepEqual(ids(domainTreeRows(domains, { query: 'V2.A', collapsed })), ['r', 'a', 'n']);
  assert.deepEqual([...collapsed], ['r', 'a']);
  assert.deepEqual(ids(domainTreeRows(domains, { query: 'www.' })), ['r']);
  assert.deepEqual(domainTreeRows(domains, { query: 'missing' }), []);
});

test('orphans and cycles remain visible and terminate', () => {
  const broken = [
    { id: 'a', primaryDomain: 'a.test.com', parentDomainId: 'b' },
    { id: 'b', primaryDomain: 'b.test.com', parentDomainId: 'a' },
    { id: 'c', primaryDomain: 'c.test.com', parentDomainId: 'missing' },
  ];
  const rows = domainTreeRows(broken);
  assert.equal(new Set(ids(rows)).size, 3);
  assert.ok(rows.every((row) => row.warning));
});

test('tree preparation leaves API records unchanged', () => {
  const before = JSON.stringify(domains);
  domainTreeRows(domains);
  assert.equal(JSON.stringify(domains), before);
});

test('subdomain form binds the parent server, not the first server', () => {
  const payload = domainCreatePayload({ ...form, mode: 'subdomain', parentDomainId: 'r', prefix: 'API' }, domains, servers);
  assert.equal(payload.serverId, 's2');
  assert.equal(payload.parentDomainId, 'r');
  assert.equal(payload.primaryDomain, 'api.example.com.tr');
});

test('missing parent or missing parent server never falls back to another server', () => {
  assert.throws(() => domainCreatePayload({ ...form, mode: 'subdomain', parentDomainId: 'missing', prefix: 'api' }, domains, servers), /parent domain/);
  assert.throws(() => domainCreatePayload({ ...form, mode: 'subdomain', parentDomainId: 'r', prefix: 'api' }, domains, [servers[0]]), /available server/);
});

test('root domain has no parent and multi-server selection is explicit', () => {
  const payload = domainCreatePayload({ ...form, parentDomainId: 'r' }, domains, servers);
  assert.equal(payload.parentDomainId, null);
  assert.equal(payload.serverId, 's1');
  assert.throws(() => domainCreatePayload({ ...form, serverId: '' }, domains, servers), /available server/);
  assert.equal(domainCreatePayload({ ...form, serverId: '' }, domains, [servers[1]]).serverId, 's2');
});

test('prefix validation rejects unsafe or empty labels and allows nested prefixes', () => {
  for (const prefix of ['', '.api', 'api.', 'a..b', '-api', 'api-', 'a/b', 'x'.repeat(64)]) {
    assert.throws(() => domainCreatePayload({ ...form, mode: 'subdomain', parentDomainId: 'r', prefix }, domains, servers), /valid subdomain prefix/);
  }
  assert.equal(domainCreatePayload({ ...form, mode: 'subdomain', parentDomainId: 'r', prefix: 'v2.api' }, domains, servers).primaryDomain, 'v2.api.example.com.tr');
});

test('invalid upstream ports are caught before submission', () => {
  for (const targetValue of ['', 'NaN', '1023', '65536', '4301.5']) {
    assert.throws(() => domainCreatePayload({ ...form, targetValue }, domains, servers), /Upstream port/);
  }
});
