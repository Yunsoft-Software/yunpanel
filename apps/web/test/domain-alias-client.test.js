import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainAliasClient } from '../src/workspace/domain-alias-client.js';
import { normalizeAliasName, aliasList, aliasDiff, sameAliases, aliasDomainSnapshot, assertAliasDomain, refreshAliasPublication } from '../src/workspace/domain-alias-model.js';

const digest = 'a'.repeat(64);
function domain() {
  return { id: 'domain-a', serverId: 'local', websiteId: 'site-a', parentDomainId: null,
    primaryDomain: 'example.test', aliases: ['www.example.test'], desiredRevision: 2,
    appliedRevision: 2, stagedRevision: 2, stagedChecksum: digest, state: 'active',
    httpsMode: 'managed', httpsRedirect: true, canonicalRedirect: false, certificateId: 'certificate-a',
    targetType: 'static', target: { root: '/site/a' }, nginxSettings: { headers: [], spaFallback: true } };
}
function fixture(options = {}) {
  let state = domain(); let current = true; let sequence = 0;
  const calls = []; const progress = []; const observed = []; const jobs = new Map();
  const stateCopy = () => structuredClone(state);
  const makePreview = (changes) => ({ version: 1, domainId: state.id, currentRevision: state.desiredRevision,
    nextRevision: state.desiredRevision + 1, previewDigest: digest, confirmation: `update-domain:${state.id}:${digest}`,
    next: { primaryDomain: state.primaryDomain, aliases: changes.aliases, httpsMode: state.httpsMode,
      httpsRedirect: state.httpsRedirect, canonicalRedirect: state.canonicalRedirect, nginxSettings: state.nginxSettings },
    impact: { hostnameChanged: true, policyChanged: false, settingsChanged: false, requiresStageAndActivation: true,
      certificate: { id: state.certificateId, detached: state.certificateId !== null } } });
  async function request(path, input = {}) {
    calls.push({ path, ...structuredClone(input) });
    if (options.request) {
      const result = await options.request({ path, input, state, calls, makePreview });
      if (result !== undefined) return result;
    }
    if (path.endsWith('/update-preview')) {
      const value = makePreview(input.body.changes);
      return options.preview ? options.preview(value) : value;
    }
    if (input.method === 'PATCH') {
      const impact = makePreview(input.body.changes).impact;
      state = { ...state, aliases: [...input.body.changes.aliases], desiredRevision: state.desiredRevision + 1,
        stagedRevision: 0, stagedChecksum: null, state: 'draft', certificateId: null };
      return { domain: stateCopy(), impact, previewDigest: digest };
    }
    if (input.method === 'POST') {
      const action = path.split('/').at(-1);
      const job = { id: `job-${++sequence}`, serverId: state.serverId, resourceType: 'domain', resourceId: state.id, status: 'queued', operation: `domain.${action}` };
      jobs.set(job.id, { ...job, action });
      return options.queued ? options.queued(job) : job;
    }
    return stateCopy();
  }
  async function waitForJob(id) {
    const job = jobs.get(id);
    if (options.wait) return options.wait({ job, state });
    if (job.action === 'stage') { state.stagedRevision = state.desiredRevision; state.stagedChecksum = digest; state.state = 'staged'; }
    else { state.appliedRevision = state.desiredRevision; state.state = 'active'; }
    return { ...job, status: 'succeeded' };
  }
  const client = createDomainAliasClient({ request, waitForJob, isCurrent: () => current,
    onProgress: (value) => progress.push(value), observe: (job) => observed.push(job) });
  return { client, calls, progress, observed, get: stateCopy, set: (changes) => { Object.assign(state, changes); }, revoke: () => { current = false; } };
}
const names = ['www.example.test', 'other.example.test'];
const mutationCalls = (fixture) => fixture.calls.filter((call) => ['PATCH', 'POST'].includes(call.method) && !call.path.endsWith('/update-preview'));

test('alias normalization handles case, final dot, IDN and wide dots', () => {
  assert.equal(normalizeAliasName(' WWW.Example.test. '), 'www.example.test');
  assert.equal(normalizeAliasName('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeAliasName('www。example.test'), 'www.example.test');
});
test('URLs, ports, paths, wildcards, IPs and empty labels are rejected', () => {
  for (const name of ['', null, {}, 'https://example.test', 'name:443', 'example.test/path', '*.example.test', 'a@example.test', 'example.test?x', 'example%2etest', '127.0.0.1', '127.1', 'a..test', '-a.test', 'a_.test', `${'a'.repeat(64)}.test`]) assert.throws(() => normalizeAliasName(name), { code: 'alias_invalid' }, String(name));
});
test('alias limits, duplicate names and main hostname are explicit errors', () => {
  assert.deepEqual(aliasList([], 'example.test'), []);
  assert.throws(() => aliasList(Array.from({ length: 21 }, (_, n) => `a${n}.test`), 'example.test'), { code: 'alias_limit' });
  assert.throws(() => aliasList(['www.example.test', 'WWW.example.test'], 'example.test'), { code: 'alias_duplicate' });
  assert.throws(() => aliasList(['example.test'], 'example.test'), { code: 'alias_duplicate' });
});
test('diff distinguishes added/removed names and ignores order for dirty state', () => {
  assert.deepEqual(aliasDiff(['a.test', 'b.test'], ['b.test', 'c.test']), { added: ['c.test'], removed: ['a.test'] });
  assert.equal(sameAliases(['a.test', 'b.test'], ['b.test', 'a.test']), true);
  assert.equal(sameAliases([], null), false);
});
test('snapshots are independent and routing drift includes owner/server/target/policy', () => {
  const original = domain(); const copy = aliasDomainSnapshot(original); copy.aliases.push('c.test');
  assert.equal(original.aliases.length, 1);
  for (const changes of [{ id: 'domain-b' }, { serverId: 'other' }, { websiteId: 'site-b' }, { parentDomainId: 'parent-b' }, { target: { root: '/site/b' } }, { desiredRevision: 3 }, { certificateId: null }, { canonicalRedirect: true }, { state: 'suspended' }]) assert.throws(() => assertAliasDomain(original, { ...original, ...changes }), { code: 'alias_stale' });
  assert.doesNotThrow(() => assertAliasDomain(original, { ...original, stagedRevision: 1 }));
});
test('preview uses only aliases and the existing Domain API contract', async () => {
  const f = fixture(); const plan = await f.client.preview(f.get(), names);
  assert.deepEqual(f.calls.map((call) => call.path), ['/domains/domain-a', '/domains/domain-a/update-preview']);
  assert.deepEqual(f.calls[1].body, { changes: { aliases: names } });
  assert.deepEqual(plan.added, ['other.example.test']); assert.deepEqual(plan.removed, []);
  assert.equal(plan.certificateDetached, true); assert.ok(Object.isFrozen(plan.changes.aliases));
  assert.equal(mutationCalls(f).length, 0);
});
test('no change and stale base do not reach a write or acquire a new preview', async () => {
  const f = fixture(); const old = f.get();
  await assert.rejects(f.client.preview(old, old.aliases), { code: 'alias_no_changes' });
  f.set({ desiredRevision: 3 });
  await assert.rejects(f.client.preview(old, names), { code: 'alias_stale' });
  assert.equal(f.calls.some((call) => call.method === 'POST'), false);
});
for (const [label, corrupt] of [
  ['target', (p) => { p.domainId = 'other'; }], ['revision', (p) => { p.currentRevision = 99; }],
  ['digest', (p) => { p.previewDigest = 'bad'; }], ['confirmation', (p) => { p.confirmation = 'wrong'; }],
  ['names', (p) => { p.next.aliases = ['wrong.test']; }], ['main name', (p) => { p.next.primaryDomain = 'wrong.test'; }],
  ['policy', (p) => { p.next.httpsRedirect = false; }], ['hidden settings change', (p) => { p.impact.settingsChanged = true; }],
  ['hidden TLS detachment', (p) => { p.impact.certificate.detached = false; }], ['certificate target', (p) => { p.impact.certificate.id = 'other'; }],
]) test(`preview rejects mismatched ${label}`, async () => {
  const f = fixture({ preview: (p) => { corrupt(p); return p; } });
  await assert.rejects(f.client.preview(f.get(), names), { code: 'alias_response_invalid' });
  assert.equal(mutationCalls(f).length, 0);
});
test('save sends exact approved input, validates PATCH wrapper and reads saved record', async () => {
  const f = fixture(); const plan = await f.client.preview(f.get(), names); const result = await f.client.save(plan);
  const patch = mutationCalls(f)[0];
  assert.deepEqual(Object.keys(patch.body).sort(), ['changes', 'confirmation', 'previewDigest']);
  assert.deepEqual(patch.body.changes, { aliases: names });
  assert.equal(result.domain.desiredRevision, 3); assert.equal(result.domain.appliedRevision, 2);
  assert.equal(result.domain.certificateId, null); assert.equal(f.calls.at(-1).method, undefined);
  assert.equal(f.progress.at(-1).phase, 'saved');
});
test('removing all aliases preserves the main domain and requires an approved plan', async () => {
  const f = fixture(); const plan = await f.client.preview(f.get(), []); const result = await f.client.save(plan);
  assert.deepEqual(plan.removed, ['www.example.test']); assert.equal(result.domain.primaryDomain, 'example.test');
  assert.deepEqual(result.domain.aliases, []);
  await assert.rejects(f.client.save({ ...plan }), { code: 'alias_preview_required' });
});
test('a consumed confirmation cannot be replayed after success or lost response', async () => {
  const f = fixture(); const plan = await f.client.preview(f.get(), names); await f.client.save(plan);
  await assert.rejects(f.client.save(plan), { code: 'alias_preview_required' });
  assert.equal(mutationCalls(f).length, 1);
});
test('PATCH network failure is unknown, not success or an automatic retry', async () => {
  const f = fixture({ request: ({ input }) => { if (input.method === 'PATCH') throw new Error('private stack'); } });
  const plan = await f.client.preview(f.get(), names);
  await assert.rejects(f.client.save(plan), (error) => error.needsReload && !error.message.includes('private stack'));
  await assert.rejects(f.client.save(plan), { code: 'alias_preview_required' });
  assert.equal(mutationCalls(f).length, 1);
});
test('wrong saved target or malformed success cannot advance to publication', async () => {
  const f = fixture({ request: ({ input }) => input.method === 'PATCH' ? { domain: { ...domain(), id: 'other' }, impact: { certificate: { detached: true } }, previewDigest: digest } : undefined });
  const plan = await f.client.preview(f.get(), names);
  await assert.rejects(f.client.save(plan), { code: 'alias_save_unconfirmed', needsReload: true });
  assert.equal(mutationCalls(f).length, 1);
});
test('record changing while confirmation is open prevents PATCH', async () => {
  const f = fixture(); const plan = await f.client.preview(f.get(), names); f.set({ desiredRevision: 5 });
  await assert.rejects(f.client.save(plan), { code: 'alias_stale' }); assert.equal(mutationCalls(f).length, 0);
});
test('apply coordinates real job acknowledgements and verifies final registry state', async () => {
  const f = fixture(); const saved = await f.client.save(await f.client.preview(f.get(), names));
  const result = await f.client.apply(saved.domain);
  assert.equal(result.domain.state, 'active'); assert.equal(result.domain.appliedRevision, 3);
  assert.deepEqual(mutationCalls(f).map((call) => call.path), ['/domains/domain-a', '/domains/domain-a/stage', '/domains/domain-a/activate']);
  assert.deepEqual(f.observed.map((job) => job.status), ['queued', 'succeeded', 'queued', 'succeeded']);
  assert.equal(f.progress.at(-1).phase, 'applied');
});
test('already-applied and valid staged state avoid repeating completed jobs', async () => {
  const f = fixture(); assert.equal((await f.client.apply(f.get())).alreadyApplied, true); assert.equal(mutationCalls(f).length, 0);
  f.set({ state: 'staged', desiredRevision: 3, stagedRevision: 3 });
  await f.client.apply(f.get()); assert.equal(mutationCalls(f).length, 1); assert.ok(mutationCalls(f)[0].path.endsWith('/activate'));
});
test('failed staging stops before activation and preserves the saved record', async () => {
  const f = fixture({ wait: ({ job }) => ({ ...job, status: 'failed' }) }); f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed', needsReload: true });
  assert.equal(mutationCalls(f).length, 1); assert.equal(f.get().desiredRevision, 3);
});
test('success job without matching registry update is not publication evidence', async () => {
  const f = fixture({ wait: ({ job }) => ({ ...job, status: 'succeeded' }) }); f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed' });
  assert.equal(mutationCalls(f).length, 1);
});
test('wrong queued job target fails before observing or waiting', async () => {
  const f = fixture({ queued: (job) => ({ ...job, resourceId: 'other' }) }); f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed' }); assert.equal(f.observed.length, 0);
});
test('wrong finished job identity cannot be treated as the requested job', async () => {
  const f = fixture({ wait: ({ job }) => ({ ...job, id: 'other', status: 'succeeded' }) }); f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed' }); assert.equal(f.observed.length, 1);
});
test('routing revision changing during stage prevents activating an unreviewed revision', async () => {
  const f = fixture({ wait: ({ job, state }) => { state.desiredRevision++; return { ...job, status: 'succeeded' }; } });
  f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed' }); assert.equal(mutationCalls(f).length, 1);
});
test('session change before or during an operation stops subsequent mutations', async () => {
  let f; f = fixture({ wait: ({ job }) => { f.revoke(); return { ...job, status: 'succeeded' }; } });
  f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_context_changed' }); assert.equal(mutationCalls(f).length, 1);
  await assert.rejects(f.client.preview(f.get(), names), { code: 'alias_context_changed' });
});
test('overlapping requests in one editor fail without issuing a second request', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ request: async ({ calls }) => { if (calls.length === 1) await gate; } });
  const first = f.client.preview(f.get(), names);
  await assert.rejects(f.client.preview(f.get(), names), { code: 'alias_busy' }); release(); await first;
  assert.equal(f.calls.length, 2);
});

test('invalid identifier types cannot be coerced into valid routing identities', () => {
  for (const value of [3, {}, true, null]) assert.throws(() => aliasDomainSnapshot({ ...domain(), id: value }), { code: 'alias_target_invalid' });
});
test('session changing after PATCH acknowledgement cannot publish or clear a new form', async () => {
  let f; f = fixture({ request: ({ input }) => { if (input.method === 'PATCH') f.revoke(); } });
  const plan = await f.client.preview(f.get(), names);
  await assert.rejects(f.client.save(plan), { code: 'alias_context_changed' });
  assert.equal(mutationCalls(f).length, 1); assert.equal(f.progress.some((entry) => entry.phase === 'saved'), false);
});
test('registry read failure after PATCH keeps the result unconfirmed', async () => {
  const f = fixture({ request: ({ input, state }) => { if (!input.method && state.desiredRevision === 3) throw new Error('disk private detail'); } });
  const plan = await f.client.preview(f.get(), names);
  await assert.rejects(f.client.save(plan), { code: 'alias_save_unconfirmed', needsReload: true });
  assert.equal(mutationCalls(f).length, 1);
});
test('failure during activation is not success even though staging finished', async () => {
  const f = fixture({ wait: ({ job, state }) => {
    if (job.action === 'stage') { state.stagedRevision = state.desiredRevision; state.stagedChecksum = digest; return { ...job, status: 'succeeded' }; }
    throw new Error('host refused activation');
  } }); f.set({ desiredRevision: 3, state: 'draft', stagedRevision: 0 });
  await assert.rejects(f.client.apply(f.get()), { code: 'alias_apply_unconfirmed' });
  assert.equal(mutationCalls(f).length, 2); assert.equal(f.get().appliedRevision, 2);
});


test('same-version refresh updates publication state without changing routing input', () => {
  const base = { ...domain(), state: 'draft', stagedRevision: 0, appliedRevision: 1 };
  const fresh = refreshAliasPublication(base, domain());
  assert.equal(fresh.state, 'active'); assert.equal(fresh.appliedRevision, 2);
  assert.deepEqual(fresh.aliases, base.aliases); assert.notEqual(fresh, base);
  assert.equal(base.state, 'draft');
});
test('same-version suspension becomes visible after a background refresh', () => {
  const base = domain(); const fresh = refreshAliasPublication(base, { ...base, state: 'suspended' });
  assert.equal(fresh.state, 'suspended');
});
test('refresh never overwrites just-saved routing with older or unrelated versions', () => {
  const base = domain();
  for (const change of [{ desiredRevision: 1 }, { desiredRevision: 3 },
    { aliases: ['changed.test'] }, { serverId: 'other' }, { websiteId: 'other' },
    { certificateId: null }, { primaryDomain: 'other.test' }]) {
    assert.equal(refreshAliasPublication(base, { ...base, ...change }), base);
  }
});
test('invalid or missing refresh data preserves the last known baseline', () => {
  const base = domain();
  for (const data of [null, undefined, {}, { ...base, aliases: null }]) assert.equal(refreshAliasPublication(base, data), base);
  assert.equal(refreshAliasPublication(null, base), null);
});
