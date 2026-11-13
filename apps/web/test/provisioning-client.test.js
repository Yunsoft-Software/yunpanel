// Pure client transport and sequencing unit tests for provisioning-client.js.
// No host runtime or browser acceptance is claimed here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setSession } from '../src/session-client.js';
import { autoAdvanceWebsiteProvisioning } from '../src/workspace/provisioning-client.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const websiteId = '22222222-2222-4222-8222-222222222222';

const jsonResponse = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

const makeOperation = (steps, extra = {}) => ({
  operationId,
  websiteId,
  ready: steps.every((step) => !step.required || step.state === 'succeeded'),
  status: 'pending',
  steps,
  ...extra,
});

for (const [targetState, expectedOutcome] of [
  ['compensating', 'compensation_interrupted'],
  ['compensated', 'compensated'],
]) {
  test(`autoAdvanceWebsiteProvisioning reconciles 409 site_mutation_locked -> succeeded to ${targetState} cleanly via GET without extra POST`, async (t) => {
    setSession({ csrfToken: 'csrf-t894-client' });
    t.after(() => setSession(null));

    const initial = makeOperation([
      { id: 'unix_identity', required: true, state: 'succeeded' },
      { id: 'elfinder', required: true, state: 'pending' },
    ]);
    const latest = makeOperation([
      { id: 'unix_identity', required: true, state: targetState },
      { id: 'elfinder', required: true, state: 'pending' },
    ], { ready: false });

    const calls = [];
    let getCount = 0;
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ url, method, headers: options.headers, body: options.body });
      if (method === 'GET') {
        getCount += 1;
        return jsonResponse(200, { data: getCount === 1 ? initial : latest });
      }
      return jsonResponse(409, {
        error: {
          code: 'site_mutation_locked',
          message: 'Another mutation is already running for this Website',
        },
      });
    });

    const events = [];
    const final = await autoAdvanceWebsiteProvisioning(operationId, {
      lockPollDelayMs: 0,
      onStep: (event) => events.push(event),
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((entry) => `${entry.method} ${entry.url}`),
      [
        `GET /api/panel/sites/provisioning/${operationId}`,
        `POST /api/panel/sites/provisioning/${operationId}/continue`,
        `GET /api/panel/sites/provisioning/${operationId}`,
      ],
    );
    assert.equal(calls[1].headers['x-csrf-token'], 'csrf-t894-client');
    assert.deepEqual(JSON.parse(calls[1].body), {
      confirmation: `continue-site-provisioning:${operationId}`,
    });

    assert.equal(final.ready, false);
    assert.equal(final.steps[0].state, targetState);
    assert.equal(events.length, 1);
    assert.equal(events[0].operationId, operationId);
    assert.equal(events[0].outcome, expectedOutcome);
    assert.equal(events[0].stepId, 'unix_identity');
  });
}

test('autoAdvanceWebsiteProvisioning reconciles 409 site_mutation_lock_race through GET to ready:true with zero second POST', async (t) => {
  setSession({ csrfToken: 'csrf-t894-ready' });
  t.after(() => setSession(null));

  const snapshots = [
    makeOperation([
      { id: 'sftp', required: true, state: 'pending' },
      { id: 'nginx', required: true, state: 'pending' },
    ]),
    makeOperation([
      { id: 'sftp', required: true, state: 'applying' },
      { id: 'nginx', required: true, state: 'pending' },
    ]),
    makeOperation([
      { id: 'sftp', required: true, state: 'succeeded' },
      { id: 'nginx', required: true, state: 'succeeded' },
    ]),
  ];

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'GET') {
      return jsonResponse(200, { data: snapshots.shift() });
    }
    return jsonResponse(409, {
      error: {
        code: 'site_mutation_lock_race',
        message: 'Concurrent lock race detected before execution',
      },
    });
  });

  const events = [];
  const final = await autoAdvanceWebsiteProvisioning(operationId, {
    lockPollDelayMs: 0,
    onStep: (event) => events.push(event),
  });

  assert.equal(final.ready, true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0].outcome, 'interrupted');
  assert.equal(events[1].outcome, 'ready');
});

test('autoAdvanceWebsiteProvisioning stops with session_superseded if session rotates during lock-contention polling', async (t) => {
  setSession({ csrfToken: 'csrf-t894-before' });
  t.after(() => setSession(null));

  const initial = makeOperation([
    { id: 'nginx', required: true, state: 'pending' },
  ]);

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, method });
    if (method === 'GET') {
      return jsonResponse(200, { data: initial });
    }
    setSession({ csrfToken: 'csrf-t894-after' });
    return jsonResponse(409, {
      error: { code: 'site_mutation_locked', message: 'Locked' },
    });
  });

  await assert.rejects(
    autoAdvanceWebsiteProvisioning(operationId, { lockPollDelayMs: 0 }),
    { name: 'AbortError', code: 'session_superseded' },
  );
  assert.equal(calls.length, 2);
});
