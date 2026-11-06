// Finish Website provisioning on the server once the browser that started it is gone.
// Each step still runs through the runtime with the creator's live authority and site lock;
// a step that failed or was blocked is left for the panel, never retried here.
const DAY_MS = 24 * 60 * 60 * 1000;

// True while the worker would still move this operation forward: only pending or applying steps
// remain and it changed within the idle window. Failed, blocked or abandoned setups wait for the panel.
export function provisioningInProgress(operation, nowMs, maxIdleMs = DAY_MS) {
  if (!operation || operation.ready === true || operation.status === 'abandoned' || !Array.isArray(operation.steps)) return false;
  const updatedAt = Date.parse(operation.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= maxIdleMs
    && operation.steps.some((step) => ['pending', 'applying'].includes(step.state))
    && operation.steps.every((step) => ['pending', 'applying', 'succeeded'].includes(step.state));
}

export function createWebsiteProvisioningWorker({
  registry, runtime, websiteRegistry, removalRegistry = null,
  now = () => Date.now(), maxIdleMs = DAY_MS, intervalMs = 2000, onError = () => {},
} = {}) {
  if (typeof registry?.listAdvanceable !== 'function' || typeof registry?.getActor !== 'function'
    || typeof runtime?.runNext !== 'function' || typeof websiteRegistry?.getWebsite !== 'function'
    || (removalRegistry !== null && typeof removalRegistry?.listForWebsite !== 'function')
    || typeof now !== 'function' || !Number.isSafeInteger(maxIdleMs) || maxIdleMs < 1
    || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || typeof onError !== 'function') {
    throw new TypeError('Website provisioning worker dependencies are invalid');
  }
  let started = false, timer = null, inFlight = null;
  // Operation id -> journal updatedAt it was paused at; a newer journal state is tried again.
  const paused = new Map();
  const busyCodes = new Set(['site_mutation_locked', 'site_mutation_lock_failed', 'process_store_busy']);
  function report(failure) { try { onError(failure); } catch {} }

  async function removalInProgress(websiteId) {
    if (!removalRegistry) return false;
    const removals = await removalRegistry.listForWebsite(websiteId);
    return !Array.isArray(removals) || removals.some((removal) => removal?.status !== 'removed');
  }

  async function inspectAndAdvance() {
    const operations = await registry.listAdvanceable();
    if (!Array.isArray(operations)) throw new TypeError('Provisioning journal is unavailable');
    for (const operation of operations) {
      const updatedAt = Date.parse(operation.updatedAt);
      if (!Number.isFinite(updatedAt) || now() - updatedAt > maxIdleMs) continue;
      if (paused.get(operation.operationId) === operation.updatedAt) continue;
      try {
        if (!await websiteRegistry.getWebsite(operation.websiteId)) continue;
        if (await removalInProgress(operation.websiteId)) continue;
        const actor = await registry.getActor(operation.operationId);
        if (!actor) continue;
        await runtime.runNext(operation.operationId, actor);
      } catch (error) {
        if (busyCodes.has(error?.code)) continue; // Another request holds the site; try on the next sweep.
        paused.set(operation.operationId, operation.updatedAt);
        report({
          code: error?.status === 403 ? 'website_provisioning_actor_forbidden' : 'website_provisioning_worker_failed',
          operationId: operation.operationId,
        });
      }
    }
  }

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = inspectAndAdvance();
    try { await inFlight; } finally { inFlight = null; }
  }
  async function pump() {
    try { await runOnce(); } catch { report({ code: 'website_provisioning_worker_state_unavailable' }); }
    if (started) { timer = setTimeout(pump, intervalMs); timer.unref?.(); }
  }
  return Object.freeze({
    runOnce,
    start() { if (started) return; started = true; void pump(); },
    async stop() { started = false; clearTimeout(timer); timer = null; if (inFlight) await inFlight.catch(() => {}); },
  });
}
