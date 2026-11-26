import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { setupMockDom } from './mail-test-helpers.js';

const { doc } = setupMockDom();
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { startPolling, usePolling } = await import('../src/workspace/usePolling.js');

function fakeDocument(state = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: state,
    addEventListener(type, fn) { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') listeners.delete(fn); },
    set(next) { this.visibilityState = next; for (const fn of [...listeners]) fn(); },
    get listenerCount() { return listeners.size; },
  };
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

test('startPolling runs on the interval, never overlaps and stops cleanly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fakeDocument();
  let calls = 0;
  let release;
  const stop = startPolling(() => { calls += 1; return new Promise((resolve) => { release = resolve; }); }, 1000, { doc: page });
  t.mock.timers.tick(999); await settle();
  assert.equal(calls, 0);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(5000); await settle();
  assert.equal(calls, 1, 'a slow call is not overlapped');
  release(); await settle();
  t.mock.timers.tick(1000); await settle();
  assert.equal(calls, 2);
  stop();
  release(); await settle();
  t.mock.timers.tick(5000); await settle();
  assert.equal(calls, 2);
  assert.equal(page.listenerCount, 0);
});

test('startPolling pauses while hidden and runs at once when visible again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fakeDocument();
  let calls = 0;
  const stop = startPolling(() => { calls += 1; }, 1000, { doc: page, immediate: true });
  await settle();
  assert.equal(calls, 1, 'immediate call');
  page.set('hidden');
  t.mock.timers.tick(10_000); await settle();
  assert.equal(calls, 1, 'no calls while hidden');
  page.set('visible'); await settle();
  assert.equal(calls, 2, 'resumes immediately');
  t.mock.timers.tick(1000); await settle();
  assert.equal(calls, 3);
  stop();
});

test('startPolling waits for visibility when started hidden, stops on false and survives errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = fakeDocument('hidden');
  let calls = 0;
  startPolling(() => { calls += 1; if (calls === 1) throw new Error('geçici hata'); return calls < 3; }, 500, { doc: page, immediate: true });
  await settle();
  assert.equal(calls, 0);
  page.set('visible'); await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(500); await settle();
  assert.equal(calls, 2, 'keeps polling after a thrown error');
  t.mock.timers.tick(500); await settle();
  assert.equal(calls, 3);
  t.mock.timers.tick(5000); await settle();
  assert.equal(calls, 3, 'returning false stops polling');
  assert.equal(page.listenerCount, 0);
});

test('usePolling follows enabled, uses the latest callback and stops on unmount', async () => {
  mock.timers.reset();
  const container = doc.createElement('div');
  const root = createRoot(container);
  const seen = [];
  function Probe({ enabled, label }) {
    usePolling(() => { seen.push(label); }, 20, { enabled });
    return null;
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await act(async () => { root.render(h(Probe, { enabled: false, label: 'a' })); });
  await wait(60);
  assert.deepEqual(seen, []);
  await act(async () => { root.render(h(Probe, { enabled: true, label: 'b' })); });
  await wait(70);
  assert.ok(seen.length >= 2 && seen.every((label) => label === 'b'));
  await act(async () => { root.render(h(Probe, { enabled: true, label: 'c' })); });
  await wait(50);
  assert.equal(seen.at(-1), 'c');
  doc.visibilityState = 'hidden';
  for (const fn of doc.listeners?.visibilitychange ?? []) fn();
  const hiddenCount = seen.length;
  await wait(70);
  assert.equal(seen.length, hiddenCount, 'paused while hidden');
  doc.visibilityState = 'visible';
  for (const fn of doc.listeners?.visibilitychange ?? []) fn();
  await wait(5);
  assert.ok(seen.length > hiddenCount, 'resumes when visible');
  await act(async () => { root.unmount(); });
  const finalCount = seen.length;
  await wait(60);
  assert.equal(seen.length, finalCount);
  assert.equal(doc.listeners.visibilitychange.length, 0);
});
