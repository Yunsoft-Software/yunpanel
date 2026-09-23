import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceProvisioning } from '../src/workspace/provisioning-advance.js';

// Public HTTP projection fixtures; no real host, credentials or provisioning adapter.
const id = '11111111-1111-4111-8111-111111111111';
const websiteId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const step = (id, state = 'pending') => ({ id, state, required: true });
const operation = (steps = [step('nginx'), step('certificate')], extra = {}) => ({
  operationId: id, websiteId, ready: steps.every((item) => !item.required || item.state === 'succeeded'), steps, ...extra,
});
const response = (steps, outcome = 'progressed', stepId = 'nginx', extra = {}) => ({
  operationId: id, outcome, stepId, operation: operation(steps), ...extra,
});
function harness({ initial = operation(), results = [], ...options } = {}) {
  const calls = []; const events = [];
  return {
    calls, events,
    run: () => advanceProvisioning({
      operationId: id,
      read: async ({ signal }) => { calls.push({ type: 'read', signal }); return initial; },
      advance: async ({ signal }) => {
        calls.push({ type: 'advance', signal });
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      onStep: (result) => events.push(result),
      ...options,
    }),
  };
}
const invalid = { code: 'provisioning_response_invalid' };

test('reads current operation first, advances each successful step once and stops at ready', async () => {
  const first = response([step('nginx', 'succeeded'), step('certificate')]);
  const last = response([step('nginx', 'succeeded'), step('certificate', 'succeeded')], 'ready', 'certificate');
  const run = harness({ results: [first, last] });
  assert.equal(await run.run(), last.operation);
  assert.deepEqual(run.calls.map((call) => call.type), ['read', 'advance', 'advance']);
  assert.deepEqual(run.events, [first, last]);
});

test('an already-ready operation is read without any new POST or artificial success event', async () => {
  const initial = operation([step('nginx', 'succeeded')]);
  const run = harness({ initial });
  assert.equal(await run.run(), initial);
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.events, []);
});

for (const state of ['failed', 'blocked', 'applying', 'compensating', 'compensated']) {
  test(`a stored ${state} step requires explicit recovery rather than automatic replay`, async () => {
    const initial = operation([step('nginx', state), step('certificate')]);
    const run = harness({ initial });
    assert.equal(await run.run(), initial);
    assert.deepEqual(run.calls.map((call) => call.type), ['read']);
  });
}

for (const [outcome, state] of [
  ['failed', 'failed'], ['blocked', 'blocked'], ['interrupted', 'applying'],
  ['compensation_interrupted', 'compensating'], ['compensation_failed', 'failed'], ['compensated', 'compensated'],
]) {
  test(`${outcome} is reported once and stops without retrying, clearing canRetry or claiming success`, async () => {
    const result = response([{ ...step('nginx', state), canRetry: true }, step('certificate')], outcome);
    const run = harness({ results: [result] });
    assert.equal(await run.run(), result.operation);
    assert.equal(result.operation.steps[0].canRetry, true);
    assert.equal(result.operation.ready, false);
    assert.equal(Object.hasOwn(result.operation, 'retryExhausted'), false);
    assert.equal(run.calls.length, 2);
    assert.deepEqual(run.events, [result]);
  });
}

for (const status of [401, 403, 404, 409, 429, 500, 503, undefined]) {
  test(`HTTP ${status ?? 'network failure'} is not automatically replayed or swallowed`, async () => {
    const failure = Object.assign(new Error('controlled transport failure'), { status, retryAfter: 120 });
    const run = harness({ results: [failure] });
    await assert.rejects(run.run(), (error) => error === failure);
    assert.equal(run.calls.length, 2);
    assert.deepEqual(run.events, []);
  });
}

test('failed initial read cannot start a mutation', async () => {
  const failure = new Error('controlled read failure');
  const run = harness({ read: async () => { throw failure; } });
  await assert.rejects(run.run(), (error) => error === failure);
  assert.deepEqual(run.calls, []);
});

for (const initial of [
  null, [], {}, operation(undefined, { operationId: otherId }), operation(undefined, { websiteId: '../other' }),
  operation(undefined, { ready: 'true' }), operation(undefined, { steps: null }),
  operation([step('nginx'), step('nginx')]), operation([step('nginx', 'unknown')]),
  operation([{ id: 'nginx', state: 'pending' }]), operation([step('nginx')], { ready: true }),
]) {
  test(`invalid initial projection cannot trigger POST: ${JSON.stringify(initial)}`, async () => {
    const run = harness({ initial });
    await assert.rejects(run.run(), invalid);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.events, []);
  });
}

for (const [name, result] of [
  ['empty', null],
  ['wrong outer identity', response([step('nginx', 'succeeded'), step('certificate')], 'progressed', 'nginx', { operationId: otherId })],
  ['wrong inner identity', response([], 'ready', null, { operation: operation([step('nginx', 'succeeded')], { operationId: otherId }) })],
  ['different Website', response([], 'ready', null, { operation: operation([step('nginx', 'succeeded')], { websiteId: otherId }) })],
  ['unknown outcome', response([step('nginx', 'succeeded'), step('certificate')], 'mystery')],
  ['missing step', response([step('nginx', 'succeeded'), step('certificate')], 'progressed', null)],
  ['different step', response([step('nginx', 'succeeded'), step('certificate')], 'progressed', 'other')],
  ['not actually advanced', response([step('nginx'), step('certificate')])],
  ['false ready', response([step('nginx'), step('certificate')], 'ready')],
  ['inconsistent readiness', response([step('nginx', 'succeeded'), step('certificate', 'succeeded')])],
  ['removed step', response([step('nginx', 'succeeded')], 'ready')],
  ['changed requirement', response([{ ...step('nginx', 'succeeded'), required: false }, step('certificate')])],
]) {
  test(`${name} result is rejected before publication or another POST`, async () => {
    const run = harness({ results: [result] });
    await assert.rejects(run.run(), invalid);
    assert.equal(run.calls.length, 2);
    assert.deepEqual(run.events, []);
  });
}

test('reconciled is real successful progress, not another retry', async () => {
  const result = response([step('nginx', 'succeeded'), step('certificate')], 'reconciled');
  const run = harness({ results: [result], maxSteps: 1 });
  assert.equal(await run.run(), result.operation);
  assert.deepEqual(run.events, [result]);
});

test('duplicate successful step cannot cause a third mutation', async () => {
  const result = response([step('nginx', 'succeeded'), step('certificate')]);
  const run = harness({ results: [result, structuredClone(result)] });
  await assert.rejects(run.run(), invalid);
  assert.equal(run.calls.length, 3);
  assert.equal(run.events.length, 1);
});

test('a previously successful step cannot be silently reset during advancement', async () => {
  const run = harness({
    initial: operation([step('nginx', 'succeeded'), step('certificate')]),
    results: [response([step('nginx'), step('certificate', 'succeeded')], 'progressed', 'certificate')],
  });
  await assert.rejects(run.run(), invalid);
  assert.deepEqual(run.events, []);
});

test('step budget returns latest verified state without marking failure, readiness or retry exhaustion', async () => {
  const result = response([step('nginx', 'succeeded'), step('certificate')]);
  const run = harness({ results: [result], maxSteps: 1 });
  assert.equal(await run.run(), result.operation);
  assert.equal(result.operation.ready, false);
  assert.equal(Object.hasOwn(result.operation, 'retryExhausted'), false);
  assert.equal(run.calls.length, 2);
});

test('invalid arguments fail before any network operation', async () => {
  for (const maxSteps of [0, -1, 1.5, 101, Infinity, NaN, '3', null]) {
    const run = harness({ maxSteps });
    await assert.rejects(run.run(), TypeError);
    assert.deepEqual(run.calls, []);
  }
  await assert.rejects(advanceProvisioning(), TypeError);
});

for (const at of ['before-read', 'after-read', 'after-post', 'callback']) {
  test(`abort at ${at} suppresses late events and prevents further requests`, async () => {
    const controller = new AbortController(); const signal = controller.signal;
    const calls = []; const events = [];
    const result = response([step('nginx', 'succeeded'), step('certificate')]);
    if (at === 'before-read') controller.abort();
    await assert.rejects(advanceProvisioning({ operationId: id, signal,
      read: async (options) => { assert.equal(options.signal, signal); calls.push('read'); if (at === 'after-read') controller.abort(); return operation(); },
      advance: async (options) => { assert.equal(options.signal, signal); calls.push('post'); if (at === 'after-post') controller.abort(); return result; },
      onStep: (value) => { events.push(value); if (at === 'callback') controller.abort(); },
    }), { name: 'AbortError' });
    assert.deepEqual(calls, at === 'before-read' ? [] : at === 'after-read' ? ['read'] : ['read', 'post']);
    assert.equal(events.length, at === 'callback' ? 1 : 0);
  });
}

for (const at of ['before-read', 'after-read', 'after-post', 'callback']) {
  test(`session change at ${at} cannot continue under the new actor`, async () => {
    let current = at !== 'before-read'; const calls = []; const events = [];
    await assert.rejects(advanceProvisioning({ operationId: id, isCurrent: () => current,
      read: async () => { calls.push('read'); if (at === 'after-read') current = false; return operation(); },
      advance: async () => { calls.push('post'); if (at === 'after-post') current = false; return response([step('nginx', 'succeeded'), step('certificate')]); },
      onStep: (value) => { events.push(value); if (at === 'callback') current = false; },
    }), { name: 'AbortError', code: 'session_superseded' });
    assert.deepEqual(calls, at === 'before-read' ? [] : at === 'after-read' ? ['read'] : ['read', 'post']);
    assert.equal(events.length, at === 'callback' ? 1 : 0);
  });
}
