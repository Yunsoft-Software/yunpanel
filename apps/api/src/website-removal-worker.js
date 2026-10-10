// Drive the existing durable operation journal. Browser state is never an
// execution authority; every step uses the current Owner session and site lock.
export function createWebsiteRemovalWorker({ registry, runtime, intervalMs = 1000, onError = () => {} } = {}) {
  if (typeof registry?.list !== 'function' || typeof registry?.getExecution !== 'function'
    || typeof registry?.getActor !== 'function' || typeof registry?.blockStep !== 'function'
    || typeof runtime?.get !== 'function' || typeof runtime?.continueStep !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || typeof onError !== 'function') {
    throw new TypeError('Website removal worker dependencies are invalid');
  }
  let started = false, timer = null, inFlight = null;
  const busyCodes = new Set(['website_removal_busy', 'website_removal_step_continuation_stale',
    'site_mutation_busy', 'site_busy', 'process_store_busy']);
  function report() { try { onError({ code: 'website_removal_worker_state_unavailable' }); } catch {} }
  async function inspectAndAdvance() {
    const operations = await registry.list();
    if (!Array.isArray(operations)) throw new TypeError('Removal journal is unavailable');
    for (const candidate of operations) {
      if (candidate.status === 'removed') continue;
      let operation, step;
      try {
        const execution = await registry.getExecution(candidate.id);
        if (execution?.mode !== 'automatic') continue;
        operation = await runtime.get(candidate.id);
        if (!operation || operation.websiteId !== candidate.websiteId || operation.serverId !== candidate.serverId) {
          report(); continue;
        }
        step = operation.steps.find(step => step.status !== 'succeeded');
        const interrupted = operation.status === 'blocked' && step?.error?.code === 'website_removal_interrupted';
        if (!step || !['pending', 'running'].includes(operation.status) && !interrupted) continue;
        if (!operation.actions?.stepContinuationConfirmation) { report(); continue; }
        const actor = await registry.getActor(operation.id);
        if (!actor) {
          await registry.blockStep(operation.id, step.id, {
            code: 'website_removal_actor_forbidden', message: 'Removal paused because its Owner authorization is unavailable',
          });
          continue;
        }
        await runtime.continueStep({ websiteId: operation.websiteId, operationId: operation.id,
          stepId: step.id, expectedUpdatedAt: operation.updatedAt,
          confirmation: operation.actions.stepContinuationConfirmation, actor });
      } catch (error) {
        if (busyCodes.has(error?.code)) continue; // Inspect the newer journal on the next sweep.
        if (operation && step) {
          try {
            const current = await runtime.get(operation.id);
            // Never replace a result completed by another actor/process.
            if (current?.updatedAt === operation.updatedAt && current.status !== 'removed') {
              await registry.blockStep(operation.id, step.id, {
                code: error?.status === 403 ? 'website_removal_actor_forbidden' : 'website_removal_worker_state_unavailable',
                message: error?.status === 403 ? 'Removal paused because its Owner authorization changed'
                  : 'Removal paused because its current state could not be verified',
              });
            }
          } catch { report(); }
        } else report();
      }
    }
  }
  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = inspectAndAdvance();
    try { await inFlight; } finally { inFlight = null; }
  }
  async function pump() {
    try { await runOnce(); } catch { report(); }
    if (started) { timer = setTimeout(pump, intervalMs); timer.unref?.(); }
  }
  return Object.freeze({
    runOnce,
    start() { if (started) return; started = true; void pump(); },
    async stop() { started = false; clearTimeout(timer); timer = null; if (inFlight) await inFlight.catch(() => {}); },
  });
}
