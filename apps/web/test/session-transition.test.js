import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSessionTransition, sessionTransitionPending, setSession, requestJson, sessionHeaders, setSessionChangePublisher } from '../src/session-client.js';

test('session transitions invalidate old requests and pause background polling', async (t) => {
  setSession({ csrfToken: 'transition-old' });
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls += 1; return promise; });
  const oldRequest = requestJson('/api/auth/session');
  const finish = beginSessionTransition();
  try {
    assert.equal(sessionTransitionPending(), true);
    await assert.rejects(requestJson('/api/auth/keep-alive', { method: 'POST' }), { name: 'AbortError' });
    assert.equal(calls, 1);
    resolve(new Response('{"error":{"code":"unauthorized"}}', { status: 401 }));
    await assert.rejects(oldRequest, { name: 'AbortError' });
    assert.equal(sessionHeaders('POST')['x-csrf-token'], 'transition-old');
  } finally { finish(); }
  assert.equal(sessionTransitionPending(), false);
});

test('parallel session transitions are rejected rather than interleaved', () => {
  const finish = beginSessionTransition();
  try { assert.throws(() => beginSessionTransition(), { name: 'AbortError' }); }
  finally { finish(); }
});

test('a lost session-mutation response still tells other tabs to recheck the cookie', async (t) => {
  let announcements = 0;
  setSessionChangePublisher(() => { announcements += 1; });
  t.after(() => setSessionChangePublisher(null));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('response lost after request dispatch'); });
  await assert.rejects(requestJson('/api/auth/mfa/verify', { method: 'POST', body: {}, changesSession: true }), /response lost/);
  assert.equal(sessionTransitionPending(), false);
  assert.equal(announcements, 1);
});
