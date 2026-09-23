import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSiteToolEntry } from '../src/workspace/site-tool-entry-model.js';
const site = { id: 'website-a', serverId: 'local', name: 'Site A', runtimeType: 'php' };
const domain = { id: 'domain-a', serverId: 'local', websiteId: site.id, primaryDomain: 'a.example' };
const ready = (items) => ({ status: 'ready', items });
const entry = (change = {}) => resolveSiteToolEntry({ tool: 'mail', websites: ready([site]), domains: ready([domain]), canManage: true, ...change });
for (const tool of ['mail', 'databases']) test(`${tool} resolves the existing domain-scoped route`, () => {
  assert.equal(entry({ tool }).target.href, `/websites/domain-a/${tool}`);
  assert.equal(entry({ tool, requestedSiteId: site.id }).state, 'ready');
});
test('Domain ID, unknown, blank and non-string explicit Website selection never falls back', () => {
  for (const requestedSiteId of [domain.id, 'wrong', '', 0, {}]) {
    assert.equal(entry({ requestedSiteId }).state, 'not_found');
    assert.equal(entry({ requestedSiteId }).target, null);
  }
});
test('unknown tool and read-only context produce no destination', () => {
  assert.equal(entry({ tool: 'terminal' }).state, 'unsupported');
  assert.deepEqual(entry({ canManage: false }), { state: 'forbidden', targets: [], target: null });
});
for (const status of ['idle', 'loading', 'stale', 'error', 'forbidden', 'unauthorized']) test(`${status} inventory cannot redirect into a site tool`, () => {
  assert.equal(entry({ websites: { status, items: [site] } }).state, 'unavailable');
  assert.equal(entry({ domains: { status, items: [domain] } }).target, null);
});
test('malformed ready inventory and null records do not crash or fabricate a target', () => {
  for (const value of [undefined, null, {}]) {
    assert.equal(entry({ domains: ready(value) }).state, 'unavailable');
    assert.equal(entry({ websites: ready(value) }).state, 'unavailable');
  }
  assert.equal(entry({ websites: ready([null, site]), domains: ready([null, domain]) }).state, 'ready');
});
test('empty inventory and explicit missing Website remain different states', () => {
  assert.equal(entry({ websites: ready([]) }).state, 'empty');
  assert.equal(entry({ websites: ready([]), requestedSiteId: site.id }).state, 'not_found');
});
test('duplicate Website/Domain identities do not select ambiguous ownership', () => {
  assert.equal(entry({ websites: ready([site, { ...site }]), requestedSiteId: site.id }).state, 'not_found');
  assert.equal(entry({ domains: ready([domain, { ...domain }]) }).state, 'unbound');
});
test('same hostname, wrong Website and wrong/missing server cannot bind', () => {
  for (const change of [{ websiteId: 'other' }, { serverId: 'remote' }, { serverId: undefined }]) {
    assert.equal(entry({ domains: ready([{ ...domain, ...change }]) }).state, 'unbound');
  }
  assert.equal(entry({ websites: ready([{ ...site, serverId: undefined }]), domains: ready([{ ...domain, serverId: undefined }]) }).state, 'unbound');
});
test('multiple domains of one Website are a real choice, especially for mail', () => {
  const child = { ...domain, id: 'child', parentDomainId: domain.id, primaryDomain: 'sub.a.example' };
  const result = entry({ domains: ready([domain, child]), requestedSiteId: site.id });
  assert.equal(result.state, 'choose'); assert.equal(result.target, null);
  assert.deepEqual(result.targets.map((target) => target.domainId).sort(), ['child', domain.id]);
});
test('multiple Websites never redirect to an arbitrary first site', () => {
  const other = { ...site, id: 'website-b' };
  const result = entry({ websites: ready([site, other]), domains: ready([domain, { ...domain, id: 'domain-b', websiteId: other.id }]) });
  assert.equal(result.state, 'choose'); assert.equal(result.targets.length, 2);
  assert.equal(result.target, null);
});
test('explicit selected Website excludes unrelated sites from the chooser', () => {
  const other = { ...site, id: 'website-b' };
  const result = entry({ websites: ready([other, site]), requestedSiteId: site.id });
  assert.equal(result.state, 'ready'); assert.equal(result.targets.length, 1);
});
test('unbound site stays visible instead of producing a broken link', () => {
  const result = entry({ domains: ready([]) });
  assert.equal(result.state, 'unbound'); assert.equal(result.targets.length, 1);
  assert.equal(result.target.websiteId, site.id); assert.equal(result.target.href, null);
});
test('file runtime restrictions are not incorrectly applied to mail or databases', () => {
  assert.equal(entry({ websites: ready([{ ...site, runtimeType: 'docker' }]) }).state, 'ready');
});
test('encoded IDs, malformed labels and frozen API data are handled without mutation', () => {
  const result = entry({ websites: ready(Object.freeze([Object.freeze({ ...site, name: {} })])), domains: ready(Object.freeze([Object.freeze({ ...domain, id: 'd /?#', primaryDomain: null })])) });
  assert.equal(result.target.href, '/websites/d%20%2F%3F%23/mail');
  assert.equal(result.target.label, site.id);
});
