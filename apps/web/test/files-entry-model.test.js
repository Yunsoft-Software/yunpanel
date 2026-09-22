import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { filesTargets, resolveFilesEntry } from '../src/workspace/files-entry-model.js';
import { workspaceResources } from '../src/workspace/workspace-resources.js';
import { navigationGroups, commandEntries } from '../src/workspace/ui/ux-model.js';

const site = { id: 'website-a', serverId: 'local', name: 'A', runtimeType: 'php' };
const domain = { id: 'domain-a', websiteId: site.id, serverId: 'local', primaryDomain: 'a.example' };
const ready = (items) => ({ status: 'ready', items });
const state = (changes = {}) => resolveFilesEntry({ websites: ready([site]), domains: ready([domain]), canManage: true, ...changes });

test('single site opens existing Domain-ID route, never a Website-ID route', () => {
  assert.equal(state().state, 'ready');
  assert.equal(state().target.href, '/websites/domain-a/files');
});
for (const runtimeType of ['static', 'node', 'php', 'python']) {
  test(`${runtimeType} reuses the existing file manager`, () => {
    assert.equal(state({ websites: ready([{ ...site, runtimeType }]) }).state, 'ready');
  });
}
test('explicit Website-ID query resolves only the owned relationship', () => {
  assert.equal(state({ requestedSiteId: site.id }).target.domainId, domain.id);
});
test('Domain-ID query must not be treated as Website-ID', () => {
  assert.equal(state({ requestedSiteId: domain.id }).state, 'not_found');
});
test('unknown site never falls back to the first accessible site', () => {
  assert.equal(state({ requestedSiteId: 'other-tenant' }).target, null);
  assert.equal(state({ requestedSiteId: 'other-tenant' }).state, 'not_found');
});
test('empty explicit selector is invalid, not an implicit selection', () => {
  assert.equal(state({ requestedSiteId: '' }).state, 'not_found');
});
test('read-only account cannot open management Files entry', () => {
  assert.deepEqual(state({ canManage: false }), { state: 'forbidden', targets: [], target: null });
});
for (const status of ['idle', 'loading', 'stale', 'error', 'unauthorized', 'forbidden']) {
  test(`${status} inventories cannot create a new handoff`, () => {
    assert.equal(state({ websites: { status, items: [site] } }).state, 'unavailable');
    assert.equal(state({ domains: { status, items: [domain] } }).target, null);
  });
}
test('empty list is not a missing selected site', () => {
  assert.equal(state({ websites: ready([]), domains: ready([]) }).state, 'empty');
  assert.equal(state({ websites: ready([]), requestedSiteId: site.id }).state, 'not_found');
});
test('unsupported runtime stays visible with a reason and no usable file link', () => {
  const result = state({ websites: ready([{ ...site, runtimeType: 'docker' }]) });
  assert.equal(result.state, 'unsupported');
  assert.equal(result.targets.length, 1);
  assert.equal(result.target.href, null);
});
test('missing domain relationship is explicit', () => {
  assert.equal(state({ domains: ready([]) }).state, 'unbound');
});
test('same hostname on another Website never grants access', () => {
  assert.equal(state({ domains: ready([{ ...domain, websiteId: 'other' }]) }).state, 'unbound');
});
test('wrong or missing server identity never resolves a handoff', () => {
  assert.equal(state({ domains: ready([{ ...domain, serverId: 'remote' }]) }).state, 'unbound');
  assert.equal(state({ websites: ready([{ ...site, serverId: undefined }]), domains: ready([{ ...domain, serverId: undefined }]) }).state, 'unbound');
});
test('duplicate Website identities are rejected', () => {
  assert.equal(state({ websites: ready([site, { ...site }]), requestedSiteId: site.id }).state, 'not_found');
});
test('ambiguous Domain identities are rejected', () => {
  assert.equal(state({ domains: ready([domain, { ...domain }]) }).state, 'unbound');
});
test('explicit parent reference selects the main domain instead of the child', () => {
  const child = { ...domain, id: 'child', parentDomainId: domain.id, primaryDomain: 'sub.a.example' };
  assert.equal(state({ domains: ready([child, domain]) }).target.domainId, domain.id);
});
test('standalone subdomain retains its own explicit Website', () => {
  assert.equal(state({ domains: ready([{ ...domain, parentDomainId: 'parent' }]) }).target.domainId, domain.id);
});
test('multiple sites require a choice; no arbitrary first-site redirect', () => {
  const second = { ...site, id: 'website-b' };
  const result = state({ websites: ready([site, second]), domains: ready([domain, { ...domain, id: 'domain-b', websiteId: second.id }]) });
  assert.equal(result.state, 'choose');
  assert.equal(result.target, null);
  assert.equal(result.targets.length, 2);
});
test('malformed values do not throw or mutate API arrays', () => {
  assert.deepEqual(filesTargets(null, []), []);
  assert.deepEqual(filesTargets([], null), []);
  const input = Object.freeze([null, Object.freeze(site)]);
  assert.equal(filesTargets(input, Object.freeze([domain]))[0].websiteId, site.id);
});
test('file entry requests only the needed scope inventories', () => {
  assert.deepEqual(workspaceResources('/files/'), { domains: true, websites: true, applications: false, certificates: false, servers: false, jobs: false });
  assert.equal(workspaceResources('/files', { observingJob: true }).jobs, true);
});
test('Owner and site-manager menus have a visible Files entry', () => {
  for (const isOwner of [true, false]) {
    assert.equal(navigationGroups(true, isOwner).flatMap((group) => group.items).filter(([path]) => path === '/files').length, 1);
    assert.equal(navigationGroups(false, isOwner).flatMap((group) => group.items).some(([path]) => path === '/files'), false);
  }
});
test('command search can find Files without a website match', () => {
  assert.ok(commandEntries({ query: 'Dosyalar', canManage: true }).some((entry) => entry.to === '/files'));
});
test('source wiring preserves the old site route and guards the new entry', async () => {
  const source = await readFile(new URL('../src/workspace/WorkspaceApp.jsx', import.meta.url), 'utf8');
  assert.match(source, /path: 'files', element: manage\(<FilesPage \/>\)/);
  assert.match(source, /path: 'websites\/:websiteId\/:tab\?'/);
  const page = await readFile(new URL('../src/workspace/FilesPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /<Navigate to=\{entry.target.href\} replace \/>/);
  assert.doesNotMatch(page, /panelRequest|fetch\(|localStorage|\/root/);
});
