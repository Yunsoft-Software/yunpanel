import test from 'node:test';
import assert from 'node:assert/strict';
import { observeJob } from '../src/workspace/observe-job.js';
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, replies) {
  const states = [], jobs = [], scheduled = [];
  let done = 0, signal;
  const stop = observeJob({ id: 'job-a', request: async (path, options) => {
    assert.equal(path, '/jobs/job-a'); signal = options.signal;
    const next = replies.shift(); if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }, onState: (state) => states.push(state), onJob: (job) => jobs.push(job), onDone: () => { done++; },
  schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, cancel: () => {} });
  t.after(stop);
  return { states, jobs, scheduled, stop, done: () => done, signal: () => signal };
}
const running = { id: 'job-a', status: 'running', type: 'deploy' };
test('opening a dialog starts empty and verifies the exact requested job', async (t) => {
  const f = fixture(t, [running]);
  assert.deepEqual(f.states[0], { job: null, error: null });
  await settle();
  assert.equal(f.states.at(-1).job, running);
  assert.equal(f.scheduled[0].delay, 1500);
});
test('another job ID is never accepted or retried as this job', async (t) => {
  const f = fixture(t, [{ id: 'job-b', status: 'succeeded' }]);
  await settle();
  assert.equal(f.states.at(-1).job, null);
  assert.ok(f.states.at(-1).error);
  assert.equal(f.jobs.length, 0); assert.equal(f.scheduled.length, 0);
});
test('malformed API response fails closed instead of retrying endlessly', async (t) => {
  const f = fixture(t, [{}]); await settle();
  assert.equal(f.states.at(-1).job, null); assert.equal(f.scheduled.length, 0);
});
for (const status of [401, 403, 404]) {
  test(`${status} clears previously verified details and stops observation`, async (t) => {
    const f = fixture(t, [running, Object.assign(new Error('private server detail'), { status })]);
    await settle(); await f.scheduled.shift().callback();
    assert.equal(f.states.at(-1).job, null);
    assert.ok(!f.states.at(-1).error.includes('private server detail'));
    assert.equal(f.scheduled.length, 0);
  });
}
test('transient failure retains verified data with an explicit stale message', async (t) => {
  const f = fixture(t, [running, new TypeError('offline')]);
  await settle(); await f.scheduled.shift().callback();
  assert.equal(f.states.at(-1).job, running);
  assert.ok(f.states.at(-1).error); assert.equal(f.scheduled[0].delay, 4000);
});
test('completed observation refreshes inventory and does not schedule another read', async (t) => {
  const f = fixture(t, [{ ...running, status: 'succeeded' }]); await settle();
  assert.equal(f.done(), 1); assert.equal(f.scheduled.length, 0);
});
test('disposal prevents late response from repopulating a closed dialog', async (t) => {
  let complete;
  const f = fixture(t, [() => new Promise((resolve) => { complete = resolve; })]);
  f.stop(); complete(running); await settle();
  assert.equal(f.signal().aborted, true);
  assert.equal(f.states.length, 1); assert.equal(f.jobs.length, 0); assert.equal(f.scheduled.length, 0);
});
