import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHostingForm, editHostingForm, hostingFormDirty, hostingFormStale, refreshHostingForm, reloadHostingForm, hostingReviewMatches, hostingWriteBlock } from '../src/workspace/domain-hosting-form.js';
import { hostingSettingsChanges } from '../src/workspace/domain-hosting-model.js';
import { workspaceResources } from '../src/workspace/workspace-resources.js';

const record = (overrides = {}) => ({ id: 'domain-a', websiteId: 'website-a', serverId: 'local-a', parentDomainId: null,
  primaryDomain: 'example.com', aliases: ['www.example.com'], desiredRevision: 3, appliedRevision: 3,
  targetType: 'static', target: { root: '/srv/website-a/public' }, nginxSettings: { clientMaxBodySizeMb: null, spaFallback: false, staticAssetCacheSeconds: 604800, headers: [] },
  httpsMode: 'managed', httpsRedirect: false, canonicalRedirect: false, certificateId: 'cert-a', state: 'active', ...overrides });
const edited = () => editHostingForm(createHostingForm(record()), 'httpsRedirect', true);
const review = (form) => ({ base: structuredClone(form.base), changes: hostingSettingsChanges(form.base, form.values) });
const ready = (overrides = {}) => ({ form: edited(), domain: record(), canManage: true, domainsStatus: 'ready', jobsStatus: 'ready', resourceBusy: false, reloadRequired: false, ...overrides });
const code = (expected) => (error) => error?.code === expected;

test('reload preserves newly added optional file settings without reverting a concurrent operator field', () => {
  const clean = createHostingForm(record());
  const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings,
    indexFiles: 'home.html index.html ', errorPages: { 404: '/errors/404.html' } });
  const incoming = record({ desiredRevision: 4, nginxSettings: { ...record().nginxSettings, clientMaxBodySizeMb: 20 } });
  const next = reloadHostingForm(form, incoming, form.base);
  assert.equal(next.values.nginxSettings.indexFiles, 'home.html index.html ');
  assert.deepEqual(next.values.nginxSettings.errorPages, { 404: '/errors/404.html' });
  assert.equal(next.values.nginxSettings.clientMaxBodySizeMb, 20);
  assert.deepEqual(hostingSettingsChanges(next.base, next.values).nginxSettings.indexFiles, ['home.html', 'index.html']);
});

test('file draft keeps typed separators until review and submits only canonical arrays', () => {
  const form = createHostingForm(record());
  const values = { ...form.values, nginxSettings: { ...form.values.nginxSettings, indexFiles: 'home.html ' } };
  assert.equal(values.nginxSettings.indexFiles, 'home.html ');
  values.nginxSettings.indexFiles += 'index.html';
  assert.deepEqual(hostingSettingsChanges(form.base, values).nginxSettings.indexFiles, ['home.html', 'index.html']);
  values.nginxSettings.indexFiles = '';
  assert.equal(hostingSettingsChanges(form.base, values).nginxSettings.indexFiles, null);
});

test('form copies a record without mutating it and starts clean', () => {
  const domain = record(); const form = createHostingForm(domain);
  assert.equal(hostingFormDirty(form), false);
  assert.deepEqual(form.values, { httpsRedirect: false, canonicalRedirect: false, nginxSettings: record().nginxSettings });
  domain.aliases.push('other.example'); assert.equal(form.base.aliases.length, 1);
  const next = editHostingForm(form, 'httpsRedirect', true);
  assert.equal(hostingFormDirty(next), true); assert.equal(form.values.httpsRedirect, false);
});
test('restoring the original checkbox value makes the form clean', () => {
  assert.equal(hostingFormDirty(editHostingForm(edited(), 'httpsRedirect', false)), false);
  assert.equal(hostingFormDirty(null), false);
});
test('unsupported fields and non-boolean input cannot enter the draft', () => {
  for (const [field, value] of [['target', {}], ['certificateId', 'other'], ['httpsRedirect', 'true'], ['__proto__', true]]) {
    assert.throws(() => editHostingForm(edited(), field, value), code('hosting_draft_invalid'));
  }
});
test('suspended records remain readable but cannot be saved', () => {
  const domain = record({ state: 'suspended' }); const form = createHostingForm(domain);
  assert.equal(form.values.httpsRedirect, false);
  assert.match(hostingWriteBlock(ready({ form, domain })), /Askıdaki/);
});
test('same-version publication refresh preserves values and dirty state', () => {
  const form = edited(); const next = refreshHostingForm(form, record({ state: 'staged', appliedRevision: 2 }));
  assert.equal(next.base.state, 'staged'); assert.equal(next.base.appliedRevision, 2);
  assert.equal(next.values, form.values); assert.equal(hostingFormDirty(next), true);
  assert.equal(hostingFormStale(next, record({ state: 'active' })), false);
});
test('background routing changes do not overwrite a draft or its baseline', () => {
  const form = edited(); const incoming = record({ desiredRevision: 4, canonicalRedirect: true });
  assert.equal(refreshHostingForm(form, incoming), form);
  assert.equal(hostingFormStale(form, incoming), true);
  assert.equal(refreshHostingForm(form, { ...incoming, aliases: null }), form);
  assert.equal(hostingFormStale(form, { ...incoming, aliases: null }), true);
});
test('delayed collection response cannot roll back the verified save', () => {
  const form = createHostingForm(record({ desiredRevision: 4, httpsRedirect: true }));
  assert.equal(refreshHostingForm(form, record()), form);
  assert.equal(hostingFormStale(form, record()), false);
  assert.equal(hostingFormDirty(form), false);
});
test('same-revision certificate drift still requires a reload', () => {
  assert.equal(hostingFormStale(edited(), record({ certificateId: 'other' })), true);
});
test('explicit reload preserves changed fields and adopts untouched remote fields', () => {
  const form = edited(); const incoming = record({ desiredRevision: 4, canonicalRedirect: true, aliases: ['alias.example.com'] });
  const next = reloadHostingForm(form, incoming, record());
  assert.deepEqual(next.values, { httpsRedirect: true, canonicalRedirect: true, nginxSettings: record().nginxSettings });
  assert.deepEqual(hostingSettingsChanges(next.base, next.values), { httpsRedirect: true });
  assert.deepEqual(next.base.aliases, incoming.aliases);
  assert.equal(form.base.desiredRevision, 3); assert.equal(incoming.httpsRedirect, false);
});
test('reload resolves an uncertain save without automatically sending it again', () => {
  const next = reloadHostingForm(edited(), record({ desiredRevision: 4, httpsRedirect: true }), record());
  assert.equal(hostingFormDirty(next), false);
  assert.equal(next.base.appliedRevision, 3);
});
test('clean reload adopts both incoming preferences', () => {
  const next = reloadHostingForm(createHostingForm(record()), record({ desiredRevision: 4, httpsRedirect: true, canonicalRedirect: true }), record());
  assert.equal(hostingFormDirty(next), false);
  assert.deepEqual(next.values, { httpsRedirect: true, canonicalRedirect: true, nginxSettings: record().nginxSettings });
});
test('reset uses the reviewed baseline, not an unreviewed background record', () => {
  const form = edited(); const reset = createHostingForm(form.base);
  assert.equal(hostingFormDirty(reset), false);
  assert.equal(hostingFormStale(reset, record({ desiredRevision: 4 })), true);
});
test('settings drafts use value equality and do not share nested headers with the source record', () => {
  const domain = record(), form = createHostingForm(domain);
  const next = editHostingForm(form, 'nginxSettings', { ...form.values.nginxSettings,
    headers: [{ name: 'X-Draft', value: 'kept', always: true }] });
  assert.equal(hostingFormDirty(next), true);
  assert.deepEqual(form.values.nginxSettings.headers, []);
  assert.deepEqual(domain.nginxSettings.headers, []);
  assert.equal(hostingFormDirty(editHostingForm(next, 'nginxSettings', structuredClone(domain.nginxSettings))), false);
});
test('reload preserves only edited web server settings and adopts another operator\'s unchanged fields', () => {
  const clean = createHostingForm(record());
  const form = editHostingForm(clean, 'nginxSettings', { ...clean.values.nginxSettings, clientMaxBodySizeMb: 25 });
  const headers = [{ name: 'X-Remote', value: 'kept', always: true }];
  const incoming = record({ desiredRevision: 4, nginxSettings: { ...record().nginxSettings,
    clientMaxBodySizeMb: 30, staticAssetCacheSeconds: 120, headers } });
  const next = reloadHostingForm(form, incoming, record());
  assert.equal(next.values.nginxSettings.clientMaxBodySizeMb, 25);
  assert.equal(next.values.nginxSettings.staticAssetCacheSeconds, 120);
  assert.deepEqual(next.values.nginxSettings.headers, headers);
  assert.equal(hostingFormDirty(next), true);
  assert.equal(hostingReviewMatches(next, review(next)), true);
});
for (const field of ['id', 'websiteId', 'serverId', 'parentDomainId']) {
  test(`reload and stale guard reject changed ${field}`, () => {
    const incoming = record({ [field]: 'other', desiredRevision: 4 });
    assert.throws(() => reloadHostingForm(edited(), incoming, record()), code('hosting_target_changed'));
    assert.equal(hostingFormStale(edited(), incoming), true);
  });
}
test('reload also checks the current UI target, even with no valid baseline', () => {
  assert.throws(() => reloadHostingForm(null, record({ websiteId: 'other' }), record()), code('hosting_target_changed'));
  assert.equal(reloadHostingForm(null, record(), record()).base.id, 'domain-a');
});
test('explicit reload rejects old or internally inconsistent routing versions', () => {
  assert.throws(() => reloadHostingForm(edited(), record({ desiredRevision: 2 }), record()), code('hosting_reload_stale'));
  assert.throws(() => reloadHostingForm(edited(), record({ httpsRedirect: true }), record()), code('hosting_reload_stale'));
});
test('reload cannot lag behind a newer collection version', () => {
  assert.throws(() => reloadHostingForm(edited(), record(), record({ desiredRevision: 4 })), code('hosting_reload_stale'));
});
test('valid review stops matching as soon as the checkbox or base changes', () => {
  const form = edited(); const plan = review(form);
  assert.equal(hostingReviewMatches(form, plan), true);
  assert.equal(hostingReviewMatches(editHostingForm(form, 'canonicalRedirect', true), plan), false);
  assert.equal(hostingReviewMatches(createHostingForm(form.base), plan), false);
  assert.equal(hostingReviewMatches({ ...form, base: record({ desiredRevision: 4 }) }, plan), false);
  assert.equal(hostingReviewMatches(form, { ...plan, changes: { ...plan.changes, certificateId: null } }), false);
  assert.equal(hostingReviewMatches(form, null), false);
});
for (const [name, overrides] of Object.entries({
  readOnly: { canManage: false }, noRecord: { form: null }, staleDomains: { domainsStatus: 'stale' },
  missingJobs: { jobsStatus: 'idle' }, forbiddenJobs: { jobsStatus: 'forbidden' }, runningJob: { resourceBusy: true },
  uncertainSave: { reloadRequired: true }, newRevision: { domain: record({ desiredRevision: 4 }) },
  newSuspension: { domain: record({ state: 'suspended' }) },
})) {
  test(`live write guard blocks ${name}`, () => assert.equal(typeof hostingWriteBlock(ready(overrides)), 'string'));
}
test('valid draft is writable only with current resources', () => assert.equal(hostingWriteBlock(ready()), null));
test('settings deep links demand jobs; read-only hosting hub and Files demand is unchanged', () => {
  for (const path of ['/websites/domain-a/settings', '/websites/domain-a/settings/']) {
    const demand = workspaceResources(path); assert.equal(demand.jobs, true); assert.equal(demand.domains, true);
  }
  assert.equal(workspaceResources('/websites/domain-a/hosting').jobs, true);
  for (const path of ['/websites/domain-a/files', '/files']) assert.equal(workspaceResources(path).jobs, false);
  assert.equal(workspaceResources('/settings').jobs, false);
});

// These are source-wiring checks, not React rendering or browser acceptance.
const source = readFileSync(new URL('../src/workspace/DomainHostingPanel.jsx', import.meta.url), 'utf8');
const site = readFileSync(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8');
test('form has a single canonical hosting route without replacing Files/SSL/alias tools', () => {
  assert.match(site, /import DomainHostingPanel from '\.\/DomainHostingPanel\.jsx'/);
  assert.match(site, /tab === 'hosting' && <DomainHostingPanel domain=\{domain\} \/>/);
  for (const component of ['SiteFilesPanel', 'SslOperations', 'DomainOperations', 'SiteAccessPanel']) assert.match(site, new RegExp(`<${component}\\b`));
});
test('session/site identity, component lifetime and abort signal are wired', () => {
  for (const expected of ['session?.user?.id', 'session?.user?.role', 'domain.websiteId', 'domain.serverId', 'key={identity}', 'sessionVersion() === generation', '!sessionTransitionPending()', 'value.controller.abort()', 'signal: runtime.current?.controller.signal']) assert.ok(source.includes(expected), expected);
});
test('hosting form preserves draft and guards a single save-and-apply submission', () => {
  for (const expected of ['useUnsavedChanges(dirty)', 'reloadHostingForm(formRef.current, value, live.current.domain)', 'hostingWriteBlock', 'pending.current', 'failure.needsReload', 'client.save(preview, { apply: true })', 'client.apply(formRef.current.base)']) assert.ok(source.includes(expected), expected);
  assert.doesNotMatch(source, /<HostingReview|<Modal|Yayın yönetimine git|localStorage|sessionStorage|dangerouslySetInnerHTML/);
});
