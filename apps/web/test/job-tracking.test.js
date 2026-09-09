import test from 'node:test';
import assert from 'node:assert/strict';
import { newerJob, trackJob } from '../src/workspace/job-tracking.js';
test('late collection reads cannot regress a completed or running job', () => {
  const done = { id: 'x', status: 'succeeded' }; const running = { id: 'x', status: 'running' };
  assert.equal(newerJob(done, running), done);
  assert.equal(newerJob(running, { id: 'x', status: 'queued' }), running);
  assert.equal(newerJob(running, done), done);
});
test('invalid job responses do not destroy known results', () => {
  const previous = { id: 'x', status: 'running' };
  for (const value of [null, {}, { id: 'x', status: 'invented' }]) assert.equal(newerJob(previous, value), previous);
});
test('history stays bounded while active jobs remain available', () => {
  let state = { active: { id: 'active', status: 'running' } };
  for (let i=0; i<12; i++) state = trackJob(state, { id: String(i), status: 'succeeded' }, 5);
  assert.equal(Object.keys(state).length, 5); assert.equal(state.active.status, 'running'); assert.equal(state['11'].status, 'succeeded');
});
