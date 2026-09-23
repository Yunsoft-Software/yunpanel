import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiteSubmission, EMPTY_SITE_SUBMISSION, siteSubmissionBusy } from '../src/workspace/site-create-submission.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const websiteId = '33333333-3333-4333-8333-333333333333';
const domainId = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const input = () => ({ operationId, serverId, primaryDomain: 'example.test', parentDomainId: null, siteAdmin: { password: 'fixture-only-do-not-publish' } });
const step = (state = 'pending') => ({ id: 'nginx', required: true, state });
const operation = (state = 'pending') => ({ operationId, websiteId, ready: state === 'succeeded', steps: [step(state)] });
const preview = () => ({ operationId, ids: { websiteId, primaryDomainId: domainId }, hostname: { primaryDomain: 'example.test' }, previewDigest: 'a'.repeat(64), confirmation: `create-site:${operationId}:${'a'.repeat(64)}`, provisioning: operation() });
const result = () => ({ operationId, website: { id: websiteId, serverId }, primaryDomain: { id: domainId, websiteId, serverId, primaryDomain: 'example.test', parentDomainId: null }, provisioning: operation() });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function harness(options = {}) {
  const calls = []; const states = [];
  const flow = createSiteSubmission({
    request: async (url, request) => { calls.push({ url, request }); return url.endsWith('create-preview') ? preview() : result(); },
    advance: async (id, settings) => { calls.push({ id, settings }); return operation('succeeded'); },
    onState: (state) => states.push(state),
    ...options,
  });
  return { flow, calls, states };
}

test('publishes the verified Domain before awaiting provisioning and uses existing scoped preview/apply', async () => {
  const gate = deferred();
  const run = harness({ advance: () => gate.promise });
  const pending = run.flow.submit(input());
  await new Promise(setImmediate);
  assert.equal(run.flow.getState().phase, 'provisioning');
  assert.deepEqual(run.flow.getState().created, { id: domainId, websiteId, primaryDomain: 'example.test' });
  assert.deepEqual(run.calls.map((call) => call.url), ['/sites/create-preview', '/sites']);
  assert.equal(run.calls[1].request.body.input, run.calls[0].request.body.input);
  assert.equal(run.calls[1].request.body.confirmation, preview().confirmation);
  gate.resolve(operation('succeeded'));
  assert.equal((await pending).phase, 'ready');
  assert.ok(run.states.some((state) => state.phase === 'recorded'));
});

test('failed later request retains created site, clears busy, and never permits another create', async () => {
  const run = harness({ advance: async () => { throw new Error('fixture-secret-transport'); } });
  const first = await run.flow.submit(input());
  assert.equal(first.phase, 'attention');
  assert.equal(first.created.id, domainId);
  assert.equal(siteSubmissionBusy(first), false);
  assert.equal(await run.flow.submit(input()), first);
  assert.equal(run.calls.length, 2);
  assert.equal(JSON.stringify(run.states).includes('fixture-secret'), false);
});

for (const status of ['failed', 'blocked', 'applying', 'compensating', 'compensated', 'pending']) {
  test(`${status} provisioning remains visible but never claims successful readiness`, async () => {
    const run = harness({ advance: async (_id, { onStep }) => {
      const op = operation(status);
      onStep({ operationId, operation: op });
      return op;
    } });
    const state = await run.flow.submit(input());
    assert.equal(state.phase, 'attention');
    assert.equal(state.steps[0].state, status);
    assert.equal(state.created.id, domainId);
  });
}

test('already-ready initial plan does not auto-advance', async () => {
  let advanced = 0;
  const run = harness({ request: async (url) => url.endsWith('create-preview') ? preview() : { ...result(), provisioning: operation('succeeded') }, advance: async () => { advanced++; } });
  assert.equal((await run.flow.submit(input())).phase, 'ready');
  assert.equal(advanced, 0);
});

for (const status of [401, 403, 409, 429, 500, 503, 'network']) {
  test(`ambiguous create ${status} cannot be resent from the same controller`, async () => {
    let writes = 0;
    const run = harness({ request: async (url) => {
      if (url.endsWith('create-preview')) return preview();
      writes++;
      throw Object.assign(new Error('controlled failure'), { status });
    } });
    const state = await run.flow.submit(input());
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.created, null);
    await run.flow.submit(input());
    assert.equal(writes, 1);
  });
}

test('preview error remains editable and retry performs only one actual create', async () => {
  let previews = 0; let writes = 0;
  const run = harness({ request: async (url) => {
    if (url.endsWith('create-preview')) { if (++previews === 1) throw new Error('preview unavailable'); return preview(); }
    writes++; return result();
  } });
  assert.equal((await run.flow.submit(input())).phase, 'error');
  assert.equal((await run.flow.submit(input())).phase, 'ready');
  assert.equal(writes, 1);
});

for (const change of [
  (v) => { v.operationId = other; }, (v) => { v.ids.websiteId = '../bad'; },
  (v) => { v.hostname.primaryDomain = 'other.test'; }, (v) => { v.confirmation = 'wrong'; },
  (v) => { v.previewDigest = 'bad'; }, (v) => { v.provisioning.websiteId = other; },
]) {
  test('invalid preview cannot dispatch create', async () => {
    let writes = 0; const bad = preview(); change(bad);
    const run = harness({ request: async (url) => { if (!url.endsWith('create-preview')) writes++; return bad; } });
    assert.equal((await run.flow.submit(input())).phase, 'error');
    assert.equal(writes, 0);
  });
}

for (const change of [
  (v) => { v.operationId = other; }, (v) => { v.website.id = other; },
  (v) => { v.website.serverId = other; }, (v) => { v.primaryDomain.id = other; },
  (v) => { v.primaryDomain.websiteId = other; }, (v) => { v.primaryDomain.serverId = other; },
  (v) => { v.primaryDomain.primaryDomain = 'other.test'; }, (v) => { v.primaryDomain.parentDomainId = other; },
]) {
  test('wrong create binding remains uncertain without publishing a site or advancing', async () => {
    const bad = result(); change(bad); let advanced = 0;
    const run = harness({ request: async (url) => url.endsWith('create-preview') ? preview() : bad, advance: async () => { advanced++; } });
    const state = await run.flow.submit(input());
    assert.equal(state.phase, 'uncertain');
    assert.equal(state.created, null);
    assert.equal(advanced, 0);
    assert.equal(run.states.some((value) => value.created), false);
  });
}

for (const bad of [null, {}, { ...operation(), websiteId: other }, { ...operation(), operationId: other },
  { ...operation(), steps: [] }, { ...operation(), steps: [step(), step()] },
  { ...operation(), ready: true }, { ...operation(), steps: [{ ...step(), required: undefined }] },
  { ...operation(), steps: [{ ...step(), state: 'mystery' }] }]) {
  test('bad initial provisioning cannot erase a valid site record or start advancement', async () => {
    let advanced = 0;
    const run = harness({ request: async (url) => url.endsWith('create-preview') ? preview() : { ...result(), provisioning: bad }, advance: async () => { advanced++; } });
    const state = await run.flow.submit(input());
    assert.equal(state.phase, 'attention');
    assert.equal(state.created.id, domainId);
    assert.equal(advanced, 0);
  });
}

test('malformed final operation never changes a verified site to ready', async () => {
  const run = harness({ advance: async () => ({ ...operation('succeeded'), websiteId: other }) });
  const state = await run.flow.submit(input());
  assert.equal(state.phase, 'attention');
  assert.equal(state.created.id, domainId);
});

test('wrong callback identity cannot replace displayed steps', async () => {
  const run = harness({ advance: async (_id, { onStep }) => {
    onStep({ operationId: other, operation: operation('succeeded') });
    return operation('succeeded');
  } });
  const state = await run.flow.submit(input());
  assert.equal(state.phase, 'attention');
  assert.equal(state.steps[0].state, 'pending');
});

test('duplicate submit while preview is pending performs one preview and one create', async () => {
  const gate = deferred(); let previews = 0; let writes = 0;
  const run = harness({ request: async (url) => {
    if (url.endsWith('create-preview')) { previews++; return gate.promise; }
    writes++; return result();
  } });
  const first = run.flow.submit(input());
  await run.flow.submit(input());
  gate.resolve(preview()); await first;
  assert.equal(previews, 1); assert.equal(writes, 1);
});

test('input mutations during preview cannot change the approved create payload', async () => {
  const gate = deferred(); const sent = []; const value = input();
  const run = harness({ request: async (url, options) => {
    sent.push(options.body.input);
    return url.endsWith('create-preview') ? gate.promise : result();
  } });
  const pending = run.flow.submit(value);
  value.primaryDomain = 'changed.test'; value.siteAdmin.password = 'changed';
  gate.resolve(preview()); await pending;
  assert.equal(sent[1].primaryDomain, 'example.test');
  assert.equal(sent[1].siteAdmin.password, 'fixture-only-do-not-publish');
});

for (const stop of ['abort', 'session', 'dispose']) {
  for (const boundary of ['preview', 'create', 'advance']) {
    test(`${stop} during ${boundary} ignores late replies and cannot publish under the next actor`, async () => {
      const gate = deferred(); const controller = new AbortController(); let current = true;
      const run = harness({ isCurrent: () => current,
        request: async (url) => url.endsWith('create-preview')
          ? boundary === 'preview' ? gate.promise : preview()
          : boundary === 'create' ? gate.promise : result(),
        advance: async () => boundary === 'advance' ? gate.promise : operation('succeeded'),
      });
      const pending = run.flow.submit(input(), { signal: controller.signal });
      await new Promise(setImmediate);
      if (stop === 'abort') controller.abort();
      if (stop === 'session') current = false;
      if (stop === 'dispose') run.flow.dispose();
      const count = run.states.length;
      gate.resolve(boundary === 'preview' ? preview() : boundary === 'create' ? result() : operation('succeeded'));
      await pending;
      assert.equal(run.states.length, count);
      assert.notEqual(run.flow.getState().phase, 'ready');
    });
  }
}

test('result projection contains no raw server errors, admin passwords or runtime intents', async () => {
  const data = result(); data.privateValue = 'fixture-secret'; data.primaryDomain.password = 'fixture-secret';
  data.provisioning.steps[0].intent = { password: 'fixture-secret' };
  data.provisioning.steps[0].error = 'fixture-secret';
  const run = harness({ request: async (url) => url.endsWith('create-preview') ? preview() : data });
  await run.flow.submit(input());
  assert.equal(JSON.stringify(run.states).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(run.states).includes('fixture-only'), false);
  assert.equal(Object.isFrozen(run.flow.getState()), true);
  assert.equal(Object.isFrozen(run.flow.getState().created), true);
});

test('busy is only actual local sequencing, not a blocked or ambiguous result', () => {
  for (const phase of ['previewing', 'creating', 'provisioning']) assert.equal(siteSubmissionBusy({ phase }), true);
  for (const phase of ['idle', 'error', 'uncertain', 'attention', 'ready', 'recorded']) assert.equal(siteSubmissionBusy({ phase }), false);
  assert.equal(EMPTY_SITE_SUBMISSION.created, null);
});
