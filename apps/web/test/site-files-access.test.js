import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveSiteFilesAccess } from '../src/workspace/site-files-access.js';

const site = Object.freeze({ id: 'website-a', serverId: 'local', runtimeType: 'php' });
const domain = Object.freeze({ id: 'domain-a', serverId: 'local', websiteId: site.id });
const ready = (items) => ({ status: 'ready', items });
const input = (changes = {}) => ({ domainId: domain.id, domains: ready([domain]), websites: ready([site]), canManage: true, ...changes });
const access = (changes) => resolveSiteFilesAccess(input(changes));

test('only explicit Domain-to-Website binding mounts the file manager', () => {
  assert.deepEqual(access(), { state: 'ready', website: site });
  assert.equal(access({ domainId: site.id }).state, 'not_found');
});
for (const runtimeType of ['static', 'node', 'php', 'python']) {
  test(`${runtimeType} keeps the existing file manager`, () => {
    assert.equal(access({ websites: ready([{ ...site, runtimeType }]) }).state, 'ready');
  });
}
test('no permission is inferred from the visible navigation', () => {
  assert.deepEqual(access({ canManage: false }), { state: 'forbidden', website: null });
  assert.deepEqual(resolveSiteFilesAccess(), { state: 'forbidden', website: null });
});
for (const status of ['idle', 'loading', 'refreshing', 'stale', 'error', 'forbidden', 'unauthorized']) {
  test(`${status} never mounts stale FilesPanel data`, () => {
    assert.equal(access({ domains: { status, items: [domain] } }).state, 'unavailable');
    assert.equal(access({ websites: { status, items: [site] } }).website, null);
  });
}
test('missing site binding preserves a repairable state', () => {
  assert.equal(access({ domains: ready([{ ...domain, websiteId: null }]) }).state, 'unbound');
});
test('missing or duplicate domain is never guessed', () => {
  assert.equal(access({ domains: ready([]) }).state, 'not_found');
  assert.equal(access({ domains: ready([domain, { ...domain }]) }).state, 'not_found');
  assert.equal(access({ domainId: '' }).state, 'not_found');
});
test('missing or ambiguous website never selects another site', () => {
  assert.equal(access({ websites: ready([{ ...site, id: 'other' }]) }).state, 'not_found');
  assert.equal(access({ websites: ready([site, { ...site }]) }).state, 'not_found');
});
test('server mismatch or absent server fails closed', () => {
  assert.equal(access({ websites: ready([{ ...site, serverId: 'other' }]) }).state, 'inconsistent');
  assert.equal(access({ domains: ready([{ ...domain, serverId: undefined }]), websites: ready([{ ...site, serverId: undefined }]) }).state, 'inconsistent');
});
test('unsupported runtime is an explicit state, not a missing feature', () => {
  for (const runtimeType of ['docker', undefined, 'new-runtime']) {
    assert.deepEqual(access({ websites: ready([{ ...site, runtimeType }]) }), { state: 'unsupported', website: null });
  }
});
test('malformed ready responses fail closed without throwing', () => {
  assert.equal(access({ domains: ready(null) }).state, 'unavailable');
  assert.equal(access({ websites: ready({}) }).state, 'unavailable');
  assert.equal(access({ domains: ready([null, domain]), websites: ready([null, site]) }).state, 'ready');
});
test('a subdomain uses its own relationship, not a guessed parent', () => {
  const child = { ...domain, id: 'child', parentDomainId: 'other-domain' };
  assert.equal(access({ domainId: child.id, domains: ready([child]) }).website.id, site.id);
});
test('resolution does not mutate frozen source records', () => {
  assert.equal(access({ domains: ready(Object.freeze([domain])), websites: ready(Object.freeze([site])) }).state, 'ready');
});
test('source wiring keeps Files visible and scopes the child by Website ID', async () => {
  const detail = await readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8');
  assert.match(detail, /if \(key === 'files'\) return canManage;/);
  assert.match(detail, /<SiteFilesPanel domainId=\{domain.id\}/);
  assert.doesNotMatch(detail, /const managedFilesWebsite/);
  const component = await readFile(new URL('../src/workspace/SiteFilesPanel.jsx', import.meta.url), 'utf8');
  assert.match(component, /access.state === 'ready'/);
  assert.match(component, /key=\{access.website.id\}/);
  assert.match(component, /websiteId=\{access.website.id\}/);
  assert.match(component, /access.state === 'unbound' && legacyRepair/);
  assert.doesNotMatch(component, /fetch\(|panelRequest|localStorage|\/root/);
});
