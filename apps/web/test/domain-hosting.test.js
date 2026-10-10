import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingSettingsFromDomain, hostingSettingsChanges, hostingSettingsDiff, hostingSettingsWarnings, validateHostingSettingsPreview, hostingExpectedDomain } from '../src/workspace/domain-hosting-model.js';
import { createDomainHostingClient } from '../src/workspace/domain-hosting-client.js';

const digest = 'a'.repeat(64);
function record(overrides = {}) {
  return { id: 'site-a', serverId: 'server-a', websiteId: 'website-a', parentDomainId: null,
    primaryDomain: 'example.com', aliases: ['www.example.com'], desiredRevision: 3,
    targetType: 'static', target: { root: '/srv/site-a', spaFallback: false },
    httpsMode: 'managed', httpsRedirect: false, canonicalRedirect: false,
    nginxSettings: { clientMaxBodySizeMb: null, spaFallback: false, staticAssetCacheSeconds: 604800, headers: [{ name: 'X-Test', value: 'unchanged', always: true }] },
    certificateId: 'certificate-a', state: 'active', appliedRevision: 3, ...overrides };
}
const draft = (changes = {}) => ({ ...hostingSettingsFromDomain(record()), httpsRedirect: true, ...changes });
function preview(base = record(), changes = { httpsRedirect: true }) {
  return { version: 1, domainId: base.id, currentRevision: base.desiredRevision,
    nextRevision: base.desiredRevision + 1, previewDigest: digest,
    confirmation: `update-domain:${base.id}:${digest}`,
    next: Object.fromEntries(['primaryDomain', 'aliases', 'httpsMode', 'httpsRedirect', 'canonicalRedirect', 'nginxSettings'].map((key) => [key, structuredClone(Object.hasOwn(changes, key) ? changes[key] : base[key])])),
    impact: { hostnameChanged: false, policyChanged: ['httpsRedirect', 'canonicalRedirect'].some(key => Object.hasOwn(changes, key)), settingsChanged: Object.hasOwn(changes, 'nginxSettings'),
      requiresStageAndActivation: true, certificate: { id: base.certificateId, detached: false } } };
}
function harness({ mutatePreview, afterPatch, patchError, read } = {}) {
  let domain = record(); let active = true; const calls = [];
  const request = async (path, options = {}) => {
    const method = options.method || 'GET'; calls.push({ path, ...options, method });
    if (method === 'GET') return read ? read(structuredClone(domain), calls) : structuredClone(domain);
    if (path.endsWith('/update-preview')) {
      const value = preview(domain, options.body.changes); mutatePreview?.(value); return value;
    }
    assert.equal(method, 'PATCH');
    assert.deepEqual(Object.keys(options.body).sort(), ['changes', 'confirmation', 'previewDigest']);
    assert.equal(options.body.previewDigest, digest);
    assert.equal(options.body.confirmation, `update-domain:${domain.id}:${digest}`);
    if (patchError) throw patchError;
    domain = hostingExpectedDomain(domain, options.body.changes, domain.desiredRevision + 1);
    const result = { domain: structuredClone(domain), previewDigest: digest, impact: { certificate: { detached: false } } };
    afterPatch?.(result); return result;
  };
  return { client: createDomainHostingClient({ request, isCurrent: () => active }), calls,
    get domain() { return domain; }, change: (patch) => { domain = { ...domain, ...patch }; }, stop: () => { active = false; } };
}
const code = (value) => (error) => error?.code === value;

test('draft includes the supported policy and normalized web server settings', () => {
  assert.deepEqual(hostingSettingsFromDomain(record()), { httpsRedirect: false, canonicalRedirect: false, nginxSettings: record().nginxSettings });
  assert.deepEqual(hostingSettingsChanges(record(), draft()), { httpsRedirect: true });
  const rows = hostingSettingsDiff(record(), draft());
  assert.equal(rows.length, 1); assert.equal(rows[0].key, 'httpsRedirect');
  assert.equal(rows[0].before, false); assert.equal(rows[0].after, true); assert.ok(Object.isFrozen(rows[0]));
});
for (const invalid of [null, [], {}, { httpsRedirect: 'false', canonicalRedirect: false }, { httpsRedirect: true }, { ...draft(), primaryDomain: 'other.example' }, { ...draft(), target: {} }]) {
  test(`reject invalid draft ${JSON.stringify(invalid)}`, () => assert.throws(() => hostingSettingsChanges(record(), invalid), code('hosting_draft_invalid')));
}
test('no-op and suspended records cannot produce changes', () => {
  assert.throws(() => hostingSettingsChanges(record(), hostingSettingsFromDomain(record())), code('hosting_no_changes'));
  assert.throws(() => hostingSettingsChanges(record({ state: 'suspended' }), draft()), code('domain_suspended_update_blocked'));
});
test('HTTPS redirect requires managed HTTPS but disabling it is supported', () => {
  assert.throws(() => hostingSettingsChanges(record({ httpsMode: 'off' }), draft()), code('invalid_redirect_policy'));
  assert.deepEqual(hostingSettingsChanges(record({ httpsRedirect: true }), draft({ httpsRedirect: false, canonicalRedirect: true })), { httpsRedirect: false, canonicalRedirect: true });
  assert.deepEqual(hostingSettingsChanges(record({ httpsMode: 'off' }), draft({ httpsRedirect: false, canonicalRedirect: true })), { canonicalRedirect: true });
});
test('reject inconsistent stored policy and overflowing revision', () => {
  for (const value of [record({ httpsMode: 'off', httpsRedirect: true }), record({ desiredRevision: Number.MAX_SAFE_INTEGER })]) {
    assert.throws(() => hostingSettingsChanges(value, draft()), code('hosting_target_invalid'));
  }
});
test('missing certificate produces a warning, never a claim of HTTPS readiness', () => {
  assert.equal(hostingSettingsWarnings(record({ certificateId: null }), draft()).length, 1);
  assert.deepEqual(hostingSettingsWarnings(record(), draft()), []);
});
test('valid preview matches the requested policy and keeps unrelated fields', () => {
  const base = record(); const original = structuredClone(base);
  const value = validateHostingSettingsPreview(base, draft(), preview());
  assert.deepEqual(value.changes, { httpsRedirect: true }); assert.equal(value.nextRevision, 4);
  assert.deepEqual(base, original);
});
const corruptions = {
  version: (p) => { p.version = 2; }, target: (p) => { p.domainId = 'site-b'; },
  revision: (p) => { p.currentRevision++; }, nextRevision: (p) => { p.nextRevision++; },
  digest: (p) => { p.previewDigest = 'invalid'; }, confirmation: (p) => { p.confirmation = 'other'; },
  hostname: (p) => { p.next.primaryDomain = 'other.example'; }, aliases: (p) => { p.next.aliases = []; },
  httpsMode: (p) => { p.next.httpsMode = 'off'; }, policy: (p) => { p.next.httpsRedirect = false; },
  otherPolicy: (p) => { p.next.canonicalRedirect = true; }, settings: (p) => { p.next.nginxSettings.headers = []; },
  impactHostname: (p) => { p.impact.hostnameChanged = true; }, impactPolicy: (p) => { p.impact.policyChanged = false; },
  impactSettings: (p) => { p.impact.settingsChanged = true; }, impactApply: (p) => { p.impact.requiresStageAndActivation = false; },
  certificate: (p) => { p.impact.certificate.id = null; }, detached: (p) => { p.impact.certificate.detached = true; },
};
for (const [name, mutate] of Object.entries(corruptions)) {
  test(`reject unexpected preview ${name} before PATCH`, async () => {
    const h = harness({ mutatePreview: mutate });
    await assert.rejects(h.client.preview(record(), draft()), code('hosting_response_invalid'));
    assert.equal(h.calls.filter((call) => call.method === 'PATCH').length, 0);
  });
}
test('preview/save re-read the correct target and never stage, activate or retry', async () => {
  const h = harness(); const base = record(); const values = draft();
  const plan = await h.client.preview(base, values);
  base.aliases.push('changed.example'); values.httpsRedirect = false;
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.base.aliases));
  const result = await h.client.save(plan);
  assert.equal(result.domain.httpsRedirect, true); assert.equal(result.domain.appliedRevision, 3);
  assert.equal(result.domain.desiredRevision, 4); assert.equal(result.domain.certificateId, 'certificate-a');
  assert.deepEqual(result.domain.target, record().target);
  assert.deepEqual(h.calls.map(({ method }) => method), ['GET', 'POST', 'GET', 'PATCH', 'GET']);
  assert.ok(h.calls.every(({ path }) => path === '/domains/site-a' || path === '/domains/site-a/update-preview'));
  await assert.rejects(h.client.save(plan), code('hosting_preview_required'));
});
test('canonical redirect alone uses the same narrow policy update', async () => {
  const h = harness(); const plan = await h.client.preview(record(), draft({ httpsRedirect: false, canonicalRedirect: true }));
  assert.deepEqual(plan.changes, { canonicalRedirect: true });
  const result = await h.client.save(plan); assert.equal(result.domain.canonicalRedirect, true);
});
test('forged, copied and cross-client plans cannot be saved', async () => {
  const h = harness(); const plan = await h.client.preview(record(), draft());
  for (const value of [{}, null, { ...plan }]) await assert.rejects(h.client.save(value), code('hosting_preview_required'));
  await assert.rejects(harness().client.save(plan), code('hosting_preview_required'));
});
for (const patch of [{ desiredRevision: 4 }, { serverId: 'server-b' }, { websiteId: 'website-b' }, { certificateId: 'other' }, { state: 'suspended' }, { aliases: ['other.example'] }]) {
  test(`record drift ${JSON.stringify(patch)} prevents PATCH`, async () => {
    const h = harness(); const plan = await h.client.preview(record(), draft()); h.change(patch);
    await assert.rejects(h.client.save(plan), code('alias_stale'));
    assert.equal(h.calls.filter(({ method }) => method === 'PATCH').length, 0);
  });
}
test('inactive context and duplicate in-flight preview fail closed', async () => {
  const h = harness(); const first = h.client.preview(record(), draft());
  await assert.rejects(h.client.preview(record(), draft()), code('hosting_busy')); await first;
  h.stop(); const count = h.calls.length;
  await assert.rejects(h.client.preview(record(), draft()), code('hosting_context_changed'));
  assert.equal(h.calls.length, count);
});
test('context transition during GET prevents the preview POST', async () => {
  let active = true; const calls = [];
  const client = createDomainHostingClient({ isCurrent: () => active, request: async (...args) => { calls.push(args); active = false; return record(); } });
  await assert.rejects(client.preview(record(), draft()), code('hosting_context_changed'));
  assert.equal(calls.length, 1);
});
test('uncertain PATCH must be reloaded, and the same plan is never retried', async () => {
  const h = harness({ patchError: new Error('connection lost') }); const plan = await h.client.preview(record(), draft());
  await assert.rejects(h.client.save(plan), (error) => error.code === 'hosting_save_unconfirmed' && error.needsReload === true);
  await assert.rejects(h.client.save(plan), code('hosting_preview_required'));
  assert.equal(h.calls.filter(({ method }) => method === 'PATCH').length, 1);
});
for (const [name, mutate] of Object.entries({ wrongDomain: (r) => { r.domain.id = 'site-b'; }, changedCertificate: (r) => { r.domain.certificateId = null; }, detached: (r) => { r.impact.certificate.detached = true; }, wrongDigest: (r) => { r.previewDigest = 'wrong'; } })) {
  test(`unconfirmed save response ${name} is not success`, async () => {
    const h = harness({ afterPatch: mutate }); const plan = await h.client.preview(record(), draft());
    await assert.rejects(h.client.save(plan), code('hosting_save_unconfirmed'));
  });
}
test('failed verification GET after PATCH is not a confirmed save', async () => {
  const h = harness({ read: (value, calls) => { if (calls.some(({ method }) => method === 'PATCH')) throw new Error('reload failed'); return value; } });
  const plan = await h.client.preview(record(), draft());
  await assert.rejects(h.client.save(plan), code('hosting_save_unconfirmed'));
});
test('no-op preview sends no requests', async () => {
  const h = harness(); await assert.rejects(h.client.preview(record(), hostingSettingsFromDomain(record())), code('hosting_no_changes'));
  assert.equal(h.calls.length, 0);
});

test('one approved save waits for actual stage and activation and returns only the verified applied revision', async () => {
  let domain = record(), savedBeforeApply = false;
  const events = [], queue = new Map();
  const client = createDomainHostingClient({ isCurrent: () => true,
    onSaved: value => { assert.equal(value.desiredRevision, 4); assert.equal(value.appliedRevision, 3); savedBeforeApply = true; },
    request: async (path, options = {}) => {
      const method = options.method ?? 'GET'; events.push(`${method} ${path}`);
      if (method === 'GET') return structuredClone(domain);
      if (path.endsWith('/update-preview')) return preview(domain, options.body.changes);
      if (method === 'PATCH') {
        const result = preview(domain, options.body.changes); domain = hostingExpectedDomain(domain, options.body.changes, 4);
        return { domain: structuredClone(domain), previewDigest: result.previewDigest, impact: result.impact };
      }
      assert.equal(savedBeforeApply, true);
      const action = path.endsWith('/stage') ? 'stage' : 'activate';
      const job = { id: `job-${action}-1234`, serverId: domain.serverId, resourceType: 'domain', resourceId: domain.id, status: 'queued' };
      queue.set(job.id, action); return job;
    },
    waitForJob: async id => {
      const action = queue.get(id);
      if (action === 'stage') domain = { ...domain, stagedRevision: 4, stagedChecksum: digest };
      else domain = { ...domain, appliedRevision: 4, state: 'active' };
      return { id, serverId: domain.serverId, resourceType: 'domain', resourceId: domain.id, status: 'succeeded' };
    },
  });
  const result = await client.save(await client.preview(record(), draft()), { apply: true });
  assert.equal(result.domain.appliedRevision, 4); assert.equal(result.domain.httpsRedirect, true);
  assert.equal(events.filter(event => event.includes('/stage')).length, 1); assert.equal(events.filter(event => event.includes('/activate')).length, 1);
});

test('a saved change whose publication failed preserves the saved revision and requires inspection before retry', async () => {
  const saved = record({ desiredRevision: 4, appliedRevision: 3, httpsRedirect: true });
  let posts = 0;
  const client = createDomainHostingClient({ isCurrent: () => true, request: async (_path, options = {}) => {
    if (!options.method) return saved; posts++; throw new Error('Fixture lost reply');
  }, waitForJob: async () => { throw new Error('must not wait without a job'); } });
  await assert.rejects(client.apply(saved), error => error.code === 'alias_apply_unconfirmed' && error.needsReload);
  assert.equal(posts, 1);
});

test('a web server update validates the settings impact and preserves routing identities', async () => {
  const h = harness(), base = record(), values = hostingSettingsFromDomain(base);
  const settings = { ...values.nginxSettings, clientMaxBodySizeMb: 24, spaFallback: true,
    headers: [{ name: 'X-Site-Policy', value: 'enabled', always: true }] };
  const plan = await h.client.preview(base, { ...values, nginxSettings: settings });
  settings.headers[0].value = 'mutated-after-preview';
  assert.equal(plan.changes.nginxSettings.headers[0].value, 'enabled');
  assert.deepEqual(Object.keys(plan.changes), ['nginxSettings']);
  const result = await h.client.save(plan);
  assert.equal(result.domain.target.spaFallback, true);
  assert.equal(result.domain.target.root, base.target.root);
  assert.equal(result.domain.websiteId, base.websiteId);
  assert.equal(result.domain.certificateId, base.certificateId);
  assert.equal(result.domain.nginxSettings.clientMaxBodySizeMb, 24);
});

test('preview rejects a settings update mislabeled as a policy-only change before any PATCH', async () => {
  const h = harness({ mutatePreview: value => { value.impact.settingsChanged = false; } });
  const values = hostingSettingsFromDomain(record());
  await assert.rejects(h.client.preview(record(), { ...values,
    nginxSettings: { ...values.nginxSettings, clientMaxBodySizeMb: 12 } }), code('hosting_response_invalid'));
  assert.equal(h.calls.some(call => call.method === 'PATCH'), false);
});

for (const [targetType, settings] of [
  ['php', { clientMaxBodySizeMb: 32, headers: [] }],
  ['passenger', { clientMaxBodySizeMb: null, headers: [] }],
  ['proxy', { clientMaxBodySizeMb: 8, proxyTimeoutSeconds: 25, websocket: false, headers: [] }],
  ['python', { clientMaxBodySizeMb: 16, proxyTimeoutSeconds: 40, websocket: true, headers: [] }],
]) {
  test(`${targetType} validates only the settings supported by its runtime`, () => {
    const base = record({ targetType, nginxSettings: settings });
    const values = hostingSettingsFromDomain(base);
    assert.deepEqual(hostingSettingsChanges(base, { ...values,
      nginxSettings: { ...values.nginxSettings, clientMaxBodySizeMb: 48 } }),
    { nginxSettings: { ...settings, clientMaxBodySizeMb: 48 } });
    assert.throws(() => hostingSettingsChanges(base, { ...values,
      nginxSettings: { ...values.nginxSettings, spaFallback: true } }), code('hosting_draft_invalid'));
  });
}

for (const settings of [
  { clientMaxBodySizeMb: 0 }, { clientMaxBodySizeMb: 1025 },
  { staticAssetCacheSeconds: -1 }, { staticAssetCacheSeconds: 3.5 },
  { headers: [{ name: 'Set-Cookie', value: 'unsafe', always: true }] },
  { headers: [{ name: 'X-Value', value: 'line\nnext', always: true }] },
  { headers: [{ name: 'X-Same', value: 'a', always: true }, { name: 'x-same', value: 'b', always: true }] },
]) {
  test('invalid or protocol-managed web server settings send no host update', async () => {
    const h = harness(), values = hostingSettingsFromDomain(record());
    await assert.rejects(h.client.preview(record(), { ...values,
      nginxSettings: { ...values.nginxSettings, ...settings } }), code('hosting_draft_invalid'));
    assert.equal(h.calls.length, 0);
  });
}
