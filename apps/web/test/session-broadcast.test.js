import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionBroadcast,
  restoredPageNeedsSessionRefresh,
  sessionBroadcastInternals,
} from '../src/session-broadcast.js';

function broadcastFixture() {
  const channels = new Set();
  class FakeBroadcastChannel {
    constructor(name) {
      assert.equal(name, sessionBroadcastInternals.channelName);
      this.listener = null;
      this.closed = false;
      channels.add(this);
    }
    addEventListener(type, listener) { assert.equal(type, 'message'); this.listener = listener; }
    removeEventListener(type, listener) { assert.equal(type, 'message'); if (this.listener === listener) this.listener = null; }
    postMessage(data) {
      for (const channel of channels) {
        if (channel !== this && !channel.closed) channel.listener?.({ data: structuredClone(data) });
      }
    }
    close() { this.closed = true; channels.delete(this); }
  }
  return { FakeBroadcastChannel, channels };
}

test('two tabs exchange only an opaque session invalidation signal', () => {
  const { FakeBroadcastChannel, channels } = broadcastFixture();
  let firstChanges = 0;
  let secondChanges = 0;
  const first = createSessionBroadcast({ BroadcastChannelClass: FakeBroadcastChannel, source: 'first-tab-identity', onChange: () => { firstChanges += 1; } });
  const second = createSessionBroadcast({ BroadcastChannelClass: FakeBroadcastChannel, source: 'second-tab-identity', onChange: () => { secondChanges += 1; } });
  const sent = [];
  const receiver = [...channels][1];
  const receive = receiver.listener;
  receiver.listener = (event) => { sent.push(event.data); receive(event); };

  first.announce();
  assert.equal(firstChanges, 0);
  assert.equal(secondChanges, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['source', 'type', 'version']);
  assert.doesNotMatch(JSON.stringify(sent[0]), /csrf|cookie|token|sessionId/i);

  second.announce();
  assert.equal(firstChanges, 1);
  first.close();
  second.close();
  assert.equal(channels.size, 0);
});

test('malformed, reflected and secret-bearing channel messages are ignored', () => {
  const { FakeBroadcastChannel, channels } = broadcastFixture();
  let changes = 0;
  const binding = createSessionBroadcast({ BroadcastChannelClass: FakeBroadcastChannel, source: 'current-tab-identity', onChange: () => { changes += 1; } });
  const receiver = [...channels][0];
  for (const data of [
    null,
    { type: 'session-changed', version: 1, source: 'short' },
    { type: 'session-changed', version: 1, source: 'current-tab-identity' },
    { type: 'session-changed', version: 1, source: 'another-tab-identity', csrfToken: 'must-not-pass' },
  ]) receiver.listener({ data });
  assert.equal(changes, 0);
  binding.close();
});

test('only a restored back-forward-cache page requests a session refresh', () => {
  assert.equal(restoredPageNeedsSessionRefresh({ persisted: true }), true);
  for (const value of [{ persisted: false }, {}, null]) assert.equal(restoredPageNeedsSessionRefresh(value), false);
});
