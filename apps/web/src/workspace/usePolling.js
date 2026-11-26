import { useEffect, useRef } from 'react';

const isHidden = (doc) => doc?.visibilityState === 'hidden';

/**
 * Calls `run` every `intervalMs` without overlapping calls. Pauses while the
 * page is hidden and runs once as soon as it becomes visible again.
 * `run` may return (or resolve to) `false` to stop. Returns a stop function.
 */
export function startPolling(run, intervalMs, { immediate = false, doc = globalThis.document } = {}) {
  let timer = null;
  let running = false;
  let stopped = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  const schedule = () => { clear(); if (!stopped && !isHidden(doc)) timer = setTimeout(tick, intervalMs); };
  async function tick() {
    timer = null;
    if (stopped || running || isHidden(doc)) return;
    running = true;
    let result;
    try { result = await run(); } catch { /* Callers report their own errors. */ } finally { running = false; }
    if (result === false) stop();
    else schedule();
  }
  function onVisibility() {
    if (isHidden(doc)) clear();
    else if (!timer && !running) void tick();
  }
  function stop() {
    stopped = true;
    clear();
    doc?.removeEventListener?.('visibilitychange', onVisibility);
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);
  if (immediate) void tick();
  else schedule();
  return stop;
}

/** React wrapper around startPolling; always calls the latest `callback`. */
export function usePolling(callback, intervalMs, { enabled = true, immediate = false } = {}) {
  const latest = useRef(callback);
  useEffect(() => { latest.current = callback; });
  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined;
    return startPolling(() => latest.current(), intervalMs, { immediate });
  }, [enabled, intervalMs, immediate]);
}
