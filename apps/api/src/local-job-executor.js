function safeExecutionError(error) {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code.slice(0, 120) : 'local_operation_failed',
    message: typeof error?.message === 'string' && error.message ? error.message.slice(0, 500) : 'Local host operation failed',
  };
}

/**
 * Claims and executes one control-plane job inside the API process. The executor
 * intentionally accepts the host operation function as a dependency: production
 * wiring must point it at the migrated local host-service layer, never at an HTTP
 * agent endpoint.
 */
export function createLocalJobExecutor({
  serverId,
  jobRegistry,
  executeOperation,
  reconcileCompletedJob,
  pollMs = 1000,
  onError = () => {},
} = {}) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('Local executor requires a serverId');
  if (!jobRegistry || typeof jobRegistry.claimNext !== 'function' || typeof jobRegistry.complete !== 'function') throw new Error('Local executor requires a job registry');
  if (typeof executeOperation !== 'function') throw new Error('Local executor requires an operation handler');
  if (typeof reconcileCompletedJob !== 'function') throw new Error('Local executor requires job reconciliation');
  if (!Number.isInteger(pollMs) || pollMs < 50 || pollMs > 60_000) throw new Error('Local executor poll interval is invalid');

  let stopped = true;
  let timer = null;
  let active = null;

  async function executeClaim(claim) {
    let terminal;
    try {
      const result = await executeOperation(claim.envelope.operation, claim.envelope.payload);
      terminal = await jobRegistry.complete({ serverId, jobId: claim.job.id, status: 'succeeded', result });
    } catch (error) {
      terminal = await jobRegistry.complete({
        serverId,
        jobId: claim.job.id,
        status: 'failed',
        error: safeExecutionError(error),
      });
    }
    const reconciliation = await reconcileCompletedJob(terminal);
    return { claimed: true, job: terminal, reconciliation };
  }

  async function work() {
    const claim = await jobRegistry.claimNext(serverId);
    if (!claim) return { claimed: false, job: null, reconciliation: null };
    return executeClaim(claim);
  }

  function runOnce() {
    if (active) return active;
    active = work().finally(() => { active = null; });
    return active;
  }

  function schedule(delay = pollMs) {
    if (stopped || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      try {
        const result = await runOnce();
        schedule(result.claimed ? 0 : pollMs);
      } catch (error) {
        try { onError(error); } catch {}
        schedule(pollMs);
      }
    }, delay);
    timer.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule(0);
  }

  async function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    await active?.catch(() => {});
  }

  return {
    serverId,
    runOnce,
    start,
    stop,
    running: () => !stopped,
  };
}

export const localExecutorInternals = Object.freeze({ safeExecutionError });
