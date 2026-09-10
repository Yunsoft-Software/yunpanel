const CHANNEL_NAME = 'yunpanel-session-v1';

function validMessage(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.type === 'session-changed'
    && value.version === 1
    && typeof value.source === 'string'
    && value.source.length >= 16
    && value.source.length <= 128;
}

function sourceId() {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random()}`;
}

export function createSessionBroadcast({
  BroadcastChannelClass = globalThis.BroadcastChannel,
  onChange,
  source = sourceId(),
} = {}) {
  if (typeof onChange !== 'function') throw new Error('Session broadcast change handler is required');
  if (typeof BroadcastChannelClass !== 'function') {
    return Object.freeze({ announce() {}, close() {} });
  }
  const channel = new BroadcastChannelClass(CHANNEL_NAME);
  const receive = (event) => {
    if (validMessage(event?.data) && event.data.source !== source) onChange();
  };
  channel.addEventListener('message', receive);
  let closed = false;
  return Object.freeze({
    announce() {
      if (!closed) channel.postMessage({ type: 'session-changed', version: 1, source });
    },
    close() {
      if (closed) return;
      closed = true;
      channel.removeEventListener('message', receive);
      channel.close();
    },
  });
}

export function restoredPageNeedsSessionRefresh(event) {
  return event?.persisted === true;
}

export const sessionBroadcastInternals = Object.freeze({ channelName: CHANNEL_NAME, validMessage });
