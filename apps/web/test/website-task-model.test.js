import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteTaskResolver, siteListFilterParams, clearSiteListFilters } from '../src/workspace/website-task-model.js';
const domain = { id: 'domain-a', websiteId: 'website-a', serverId: 'local', primaryDomain: 'example.test' };
const website = { id: 'website-a', applicationId: 'app-a', serverId: 'local', runtimeType: 'node' };
const application = { id: 'app-a', serverId: 'local', type: 'node', name: 'Site A runtime' };
const ready = (items) => ({ status: 'ready', items });
const resolve = (changes = {}, id = domain.id) => createWebsiteTaskResolver({ domains: ready([domain]), websites: ready([website]), applications: ready([application]), canManage: true, isOwner: true, ...changes })(id);
const href = (result, key) => [...result.tools, ...result.secondaryTools].find((tool) => tool.key === key)?.href;

test('six daily tools are visible and use Domain IDs, not Website or hostnames', () => {
  const result = resolve();
  assert.deepEqual(result.tools.map((tool) => tool.key), ['files', 'databases', 'ssl', 'dns', 'mail', 'logs']);
  for (const tool of [...result.tools, ...result.secondaryTools]) {
    assert.equal(tool.href, `/websites/domain-a/${tool.key}`); assert.equal(tool.reason, null);
  }
  assert.equal(result.createSubdomainHref, '/websites/new?parent=domain-a');
  assert.equal(result.runtimeLabel, 'Node.js');
});
test('unknown and Website IDs cannot redirect to a guessed domain', () => {
  for (const id of ['website-a', 'example.test', '', 'missing', null, {}]) {
    const result = resolve({}, id);
    assert.equal(result.domainReady, false);
    assert.ok(result.tools.every((tool) => tool.href === null && tool.reason));
    assert.equal(result.createSubdomainHref, null);
  }
});
test('read-only and missing access do not gain navigation or create privileges', () => {
  const result = resolve({ canManage: false });
  assert.ok([...result.tools, ...result.secondaryTools].every((tool) => tool.href === null));
  assert.equal(result.createSubdomainHref, null);
  assert.equal(result.applicationName, null);
  assert.equal(createWebsiteTaskResolver()('one').domainReady, false);
});
test('site-manager keeps scoped tasks but does not gain new-site permissions', () => {
  const result = resolve({ isOwner: false });
  assert.equal(href(result, 'mail'), '/websites/domain-a/mail');
  assert.equal(result.createSubdomainHref, null);
});
for (const status of ['idle', 'loading', 'stale', 'error', 'forbidden', 'unauthorized']) {
  test(`${status} domain data cannot provide active task targets`, () => {
    const result = resolve({ domains: { status, items: [domain] } });
    assert.ok(result.tools.every((tool) => tool.href === null));
    assert.equal(result.createSubdomainHref, null);
  });
  test(`${status} Website data keeps Files visible without guessing DB/mail/runtime`, () => {
    const result = resolve({ websites: { status, items: [website] } });
    assert.equal(href(result, 'files'), '/websites/domain-a/files');
    assert.equal(href(result, 'dns'), '/websites/domain-a/dns');
    for (const key of ['databases', 'mail', 'node', 'deploy']) assert.equal(href(result, key), null);
    assert.equal(result.applicationName, null);
  });
}
test('stale application data does not prevent unrelated working site tasks', () => {
  const result = resolve({ applications: { status: 'stale', items: [application] } });
  assert.equal(href(result, 'mail'), '/websites/domain-a/mail');
  assert.equal(href(result, 'node'), null); assert.equal(result.applicationName, null);
});
test('same name or port never replaces explicit application ownership', () => {
  const result = resolve({
    domains: ready([{ ...domain, targetType: 'proxy', target: { upstreamPort: 3000 } }]),
    applications: ready([{ ...application, id: 'other', runtime: { port: 3000 } }]),
  });
  assert.equal(result.applicationName, null); assert.equal(href(result, 'deploy'), null);
});
test('domain without a Website still has Files, DNS and SSL entry explanations', () => {
  const result = resolve({ domains: ready([{ ...domain, websiteId: null }]) });
  assert.equal(result.tools.length, 6);
  for (const key of ['files', 'dns', 'ssl', 'logs']) assert.equal(href(result, key), `/websites/domain-a/${key}`);
  for (const key of ['mail', 'databases']) assert.equal(href(result, key), null);
  assert.ok(result.bindingProblem);
});
test('cross-server Website does not leak runtime name or build task targets', () => {
  const result = resolve({ websites: ready([{ ...website, serverId: 'remote' }]) });
  assert.equal(href(result, 'mail'), null); assert.equal(href(result, 'deploy'), null);
  assert.equal(result.applicationName, null); assert.notEqual(result.runtimeLabel, 'Node.js');
});
test('cross-server application is rejected even when its ID matches', () => {
  const result = resolve({ applications: ready([{ ...application, serverId: 'remote' }]) });
  assert.equal(href(result, 'node'), null); assert.equal(result.applicationName, null);
  assert.equal(href(result, 'databases'), '/websites/domain-a/databases');
});
test('missing server identities are not considered matching servers', () => {
  const result = resolve({ domains: ready([{ ...domain, serverId: undefined }]), websites: ready([{ ...website, serverId: undefined }]) });
  assert.equal(result.domainReady, false);
  assert.ok(result.tools.every((tool) => tool.href === null));
});
for (const field of ['domains', 'websites', 'applications']) test(`duplicate ${field} are not first-record-wins`, () => {
  const item = { domains: domain, websites: website, applications: application }[field];
  const result = resolve({ [field]: ready([item, { ...item }]) });
  assert.equal(href(result, 'node'), null);
  if (field !== 'applications') assert.equal(href(result, 'mail'), null);
});
test('malformed inventories do not crash or create guessed runtime targets', () => {
  for (const items of [null, undefined, {}]) {
    assert.equal(href(resolve({ websites: ready(items) }), 'mail'), null);
    assert.equal(href(resolve({ applications: ready(items) }), 'deploy'), null);
    assert.equal(resolve({ domains: ready(items) }).domainReady, false);
  }
  assert.equal(resolve({ websites: ready([null, {}, website]) }).runtimeLabel, 'Node.js');
});
test('Files remains reachable for unsupported runtimes; no invented application links', () => {
  const result = resolve({ websites: ready([{ ...website, runtimeType: 'docker', applicationId: null }]) });
  assert.equal(href(result, 'files'), '/websites/domain-a/files');
  assert.equal(result.secondaryTools.some((tool) => tool.key === 'node'), false);
  assert.equal(result.runtimeLabel, 'Docker');
});
test('only returned current scoped inventories are used after access changes', () => {
  assert.equal(href(resolve(), 'files'), '/websites/domain-a/files');
  const revoked = resolve({ domains: ready([]), websites: ready([]), applications: ready([]) });
  assert.ok(revoked.tools.every((tool) => tool.href === null));
  assert.equal(revoked.applicationName, null);
});
test('IDs are encoded in both task and parent form links', () => {
  const id = 'domain /?#';
  const result = resolve({ domains: ready([{ ...domain, id }]) }, id);
  assert.equal(href(result, 'files'), '/websites/domain%20%2F%3F%23/files');
  assert.equal(result.createSubdomainHref, '/websites/new?parent=domain%20%2F%3F%23');
});
test('frozen inputs and returned-card changes do not mutate other cards', () => {
  const frozen = ready(Object.freeze([Object.freeze({ ...domain })]));
  const get = createWebsiteTaskResolver({ domains: frozen, websites: ready([website]), applications: ready([application]), canManage: true });
  get(domain.id).tools[0].label = 'changed';
  assert.equal(get(domain.id).tools[0].label, 'Dosya Yöneticisi');
});
test('changing filters resets page but preserves unrelated URL state', () => {
  const params = new URLSearchParams('q=old&page=3&type=proxy&returnTo=local');
  const next = siteListFilterParams(params, 'q', 'new & alias');
  assert.equal(next.get('page'), null); assert.equal(next.get('q'), 'new & alias');
  assert.equal(next.get('returnTo'), 'local'); assert.equal(params.get('page'), '3');
  assert.equal(siteListFilterParams(params, 'page', '2').get('q'), 'old');
});
test('clear and all filters preserve other parameters without accepting unknown keys', () => {
  const params = new URLSearchParams('q=x&type=proxy&status=active&sort=desc&page=4&keep=one&keep=two');
  assert.equal(clearSiteListFilters(params).toString(), 'keep=one&keep=two');
  assert.equal(siteListFilterParams(params, 'type', 'all').has('type'), false);
  assert.equal(siteListFilterParams(params, 'keep', 'overwrite').toString(), params.toString());
});
