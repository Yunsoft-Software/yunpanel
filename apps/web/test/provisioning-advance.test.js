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
  for (const lockPollLimit of [-1, 601, 1.5, Infinity, NaN, '10', null]) {
    const run = harness({ lockPollLimit });
    await assert.rejects(run.run(), TypeError);
    assert.deepEqual(run.calls, []);
  }
  for (const lockPollDelayMs of [-1, 5001, 1.5, Infinity, NaN, '10', null]) {
    const run = harness({ lockPollDelayMs });
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

for (const code of ['site_mutation_locked', 'site_mutation_lock_race']) {
  test(`default lockPollLimit=0 keeps ${code} 409 fail-closed without polling`, async () => {
    const conflict = Object.assign(new Error('locked'), { status: 409, code });
    const run = harness({ results: [conflict] });
    await assert.rejects(run.run(), (error) => error === conflict);
    assert.deepEqual(run.calls.map((call) => call.type), ['read', 'advance']);
    assert.deepEqual(run.events, []);
  });

  test(`pre-execution 409 ${code} reconciles via GET without any new POST and publishes step transitions to ready`, async () => {
    const snapshots = [
      operation([step('sftp'), step('nginx'), step('domain')]),
      operation([step('sftp', 'applying'), step('nginx'), step('domain')]),
      operation([step('sftp', 'succeeded'), step('nginx'), step('domain')]),
      operation([step('sftp', 'succeeded'), step('nginx'), step('domain')]),
      operation([step('sftp', 'succeeded'), step('nginx', 'succeeded'), step('domain', 'succeeded')]),
    ];
    const calls = [];
    const events = [];
    const final = await advanceProvisioning({
      operationId: id,
      lockPollLimit: 10,
      lockPollDelayMs: 0,
      read: async ({ signal }) => {
        calls.push({ type: 'read', signal });
        return snapshots.shift();
      },
      advance: async ({ signal }) => {
        calls.push({ type: 'advance', signal });
        throw Object.assign(new Error('worker holds site lock'), { status: 409, code });
      },
      onStep: (event) => events.push(event),
    });
    assert.equal(final.ready, true);
    assert.deepEqual(calls.map((call) => call.type), ['read', 'advance', 'read', 'read', 'read', 'read']);
    assert.equal(events.length, 3);
    assert.equal(events[0].operationId, id);
    assert.equal(events[0].stepId, 'sftp');
    assert.equal(events[0].operation.steps[0].state, 'applying');
    assert.equal(events[1].stepId, 'sftp');
    assert.equal(events[1].operation.steps[0].state, 'succeeded');
    assert.equal(events[2].outcome, 'ready');
    assert.equal(events[2].operation.ready, true);
  });
}

test('after earlier POST steps succeed, lock 409 reconciles remaining worker steps via GET without re-POSTing', async () => {
  const firstPost = response([step('unix_identity', 'succeeded'), step('sftp'), step('nginx')], 'progressed', 'unix_identity');
  const snapshots = [
    operation([step('unix_identity'), step('sftp'), step('nginx')]),
    operation([step('unix_identity', 'succeeded'), step('sftp', 'succeeded'), step('nginx', 'applying')]),
    operation([step('unix_identity', 'succeeded'), step('sftp', 'succeeded'), step('nginx', 'succeeded')]),
  ];
  const calls = [];
  const events = [];
  let postCount = 0;
  const final = await advanceProvisioning({
    operationId: id,
    lockPollLimit: 5,
    lockPollDelayMs: 0,
    read: async () => {
      calls.push('read');
      return snapshots.shift();
    },
    advance: async () => {
      calls.push('advance');
      postCount += 1;
      if (postCount === 1) return firstPost;
      throw Object.assign(new Error('worker locked sftp'), { status: 409, code: 'site_mutation_locked' });
    },
    onStep: (event) => events.push(event),
  });
  assert.equal(final.ready, true);
  assert.deepEqual(calls, ['read', 'advance', 'advance', 'read', 'read']);
  assert.equal(events.length, 3);
  assert.equal(events[0], firstPost);
  assert.equal(events[2].outcome, 'ready');
});

for (const terminalState of ['failed', 'blocked', 'compensating', 'compensated']) {
  test(`lock 409 reconciliation stops immediately when worker step enters ${terminalState}`, async () => {
    const stoppedOp = operation([step('sftp', 'succeeded'), step('nginx', terminalState), step('domain')]);
    const snapshots = [
      operation([step('sftp'), step('nginx'), step('domain')]),
      operation([step('sftp', 'applying'), step('nginx'), step('domain')]),
      stoppedOp,
      operation([step('sftp', 'succeeded'), step('nginx', 'succeeded'), step('domain', 'succeeded')]),
    ];
    const calls = [];
    const events = [];
    const final = await advanceProvisioning({
      operationId: id,
      lockPollLimit: 10,
      lockPollDelayMs: 0,
      read: async () => {
        calls.push('read');
        return snapshots.shift();
      },
      advance: async () => {
        calls.push('advance');
        throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' });
      },
      onStep: (event) => events.push(event),
    });
    assert.equal(final, stoppedOp);
    assert.equal(final.ready, false);
    assert.equal(final.steps[1].state, terminalState);
    assert.deepEqual(calls, ['read', 'advance', 'read', 'read']);
    assert.equal(events.length, 2);
  });
}

test('lock 409 reconciliation stops immediately if operation becomes abandoned', async () => {
  const abandonedOp = operation([step('nginx'), step('certificate')], { status: 'abandoned', ready: false });
  const snapshots = [operation(), abandonedOp];
  const calls = [];
  const final = await advanceProvisioning({
    operationId: id,
    lockPollLimit: 5,
    lockPollDelayMs: 0,
    read: async () => { calls.push('read'); return snapshots.shift(); },
    advance: async () => { calls.push('advance'); throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' }); },
  });
  assert.equal(final, abandonedOp);
  assert.equal(final.ready, false);
  assert.deepEqual(calls, ['read', 'advance', 'read']);
});

test('lock 409 reconciliation returns last verified non-ready operation when lockPollLimit is exhausted', async () => {
  const stillApplying = operation([step('nginx', 'succeeded'), step('certificate', 'applying')]);
  const snapshots = [
    operation(),
    operation([step('nginx', 'applying'), step('certificate')]),
    stillApplying,
  ];
  const calls = [];
  const final = await advanceProvisioning({
    operationId: id,
    lockPollLimit: 2,
    lockPollDelayMs: 0,
    read: async () => { calls.push('read'); return snapshots.shift(); },
    advance: async () => { calls.push('advance'); throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' }); },
  });
  assert.equal(final, stillApplying);
  assert.equal(final.ready, false);
  assert.equal(Object.hasOwn(final, 'retryExhausted'), false);
  assert.deepEqual(calls, ['read', 'advance', 'read', 'read']);
});

for (const nonLockError of [
  Object.assign(new Error('bare 409'), { status: 409 }),
  Object.assign(new Error('generic 409'), { status: 409, code: 'http_409' }),
  Object.assign(new Error('abandoned 409'), { status: 409, code: 'website_provisioning_abandoned' }),
  Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limited' }),
  Object.assign(new Error('server error'), { status: 500, code: 'internal_error' }),
]) {
  test(`non-lock error (${nonLockError.status} ${nonLockError.code ?? 'no-code'}) is never polled even with lockPollLimit > 0`, async () => {
    const calls = [];
    await assert.rejects(
      advanceProvisioning({
        operationId: id,
        lockPollLimit: 10,
        lockPollDelayMs: 0,
        read: async () => { calls.push('read'); return operation(); },
        advance: async () => { calls.push('advance'); throw nonLockError; },
      }),
      (err) => err === nonLockError,
    );
    assert.deepEqual(calls, ['read', 'advance']);
  });
}

for (const [label, brokenSnapshot] of [
  ['regressed succeeded step', operation([step('nginx', 'pending'), step('certificate', 'succeeded')])],
  ['changed step order', operation([step('certificate', 'succeeded'), step('nginx', 'succeeded')])],
  ['changed required flag', operation([step('nginx', 'succeeded'), { ...step('certificate'), required: false }])],
  ['removed step', operation([step('nginx', 'succeeded')])],
  ['wrong websiteId', operation([step('nginx', 'succeeded'), step('certificate')], { websiteId: otherId })],
  ['wrong operationId', operation([step('nginx', 'succeeded'), step('certificate')], { operationId: otherId })],
]) {
  test(`monotonicity/identity violation during lock poll (${label}) throws invalidResponse before onStep`, async () => {
    const snapshots = [
      operation([step('nginx', 'succeeded'), step('certificate')]),
      brokenSnapshot,
    ];
    const events = [];
    await assert.rejects(
      advanceProvisioning({
        operationId: id,
        lockPollLimit: 5,
        lockPollDelayMs: 0,
        read: async () => snapshots.shift(),
        advance: async () => { throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' }); },
        onStep: (event) => events.push(event),
      }),
      invalid,
    );
    assert.deepEqual(events, []);
  });
}

test('abort during lockPollDelayMs cancels timer immediately and prevents further GET requests', async () => {
  const controller = new AbortController();
  const calls = [];
  const startedAt = Date.now();
  await assert.rejects(
    advanceProvisioning({
      operationId: id,
      signal: controller.signal,
      lockPollLimit: 5,
      lockPollDelayMs: 4000,
      read: async () => {
        calls.push('read');
        return operation();
      },
      advance: async () => {
        calls.push('advance');
        setTimeout(() => controller.abort(), 15);
        throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' });
      },
    }),
    { name: 'AbortError' },
  );
  assert.ok(Date.now() - startedAt < 1000, 'Timer must be cleared immediately on abort');
  assert.deepEqual(calls, ['read', 'advance']);
});

for (const at of ['before-poll', 'after-poll-read', 'poll-callback']) {
  test(`session_superseded at ${at} during lock reconciliation aborts cleanly without leaking events`, async () => {
    let current = true;
    const calls = [];
    const events = [];
    let readCount = 0;
    await assert.rejects(
      advanceProvisioning({
        operationId: id,
        isCurrent: () => current,
        lockPollLimit: 5,
        lockPollDelayMs: 0,
        read: async () => {
          calls.push('read');
          readCount += 1;
          if (readCount === 1) return operation();
          if (at === 'after-poll-read') current = false;
          return operation([step('nginx', 'applying'), step('certificate')]);
        },
        advance: async () => {
          calls.push('advance');
          if (at === 'before-poll') current = false;
          throw Object.assign(new Error('locked'), { status: 409, code: 'site_mutation_locked' });
        },
        onStep: (event) => {
          events.push(event);
          if (at === 'poll-callback') current = false;
        },
      }),
      { name: 'AbortError', code: 'session_superseded' },
    );
    assert.deepEqual(calls, at === 'before-poll' ? ['read', 'advance'] : ['read', 'advance', 'read']);
    assert.equal(events.length, at === 'poll-callback' ? 1 : 0);
  });
}
