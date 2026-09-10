import { currentAuditActorId } from './audit-request-context.js';

function safeAuditFailure(onAuditError, phase, jobId) {
  try { onAuditError(Object.freeze({ phase, jobId: typeof jobId === 'string' ? jobId : null })); } catch {}
}

export function createAuditedJobRegistry({
  registry,
  audit,
  actorProvider = currentAuditActorId,
  onAuditError = () => {},
} = {}) {
  if (!registry || typeof registry.enqueue !== 'function' || typeof registry.complete !== 'function' || typeof registry.cancel !== 'function') {
    throw new TypeError('Audited job registry requires a job registry');
  }
  if (!audit || typeof audit.linkJob !== 'function' || typeof audit.recordJobOutcome !== 'function') {
    throw new TypeError('Audited job registry requires the common audit store');
  }
  if (typeof actorProvider !== 'function' || typeof onAuditError !== 'function') {
    throw new TypeError('Audited job registry adapters are invalid');
  }

  async function enqueue(input) {
    const actorId = actorProvider() ?? 'system';
    const job = await registry.enqueue(input);
    try {
      audit.linkJob({
        jobId: job.id,
        actorId,
        action: `job.${job.operation}`,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
      });
    } catch {
      safeAuditFailure(onAuditError, 'link', job.id);
    }
    return job;
  }

  async function complete(input) {
    const job = await registry.complete(input);
    if (job?.status === 'succeeded' || job?.status === 'failed') {
      try {
        audit.recordJobOutcome({
          jobId: job.id,
          outcome: job.status,
          code: job.status === 'failed' ? job.error?.code ?? null : null,
        });
      } catch {
        safeAuditFailure(onAuditError, 'complete', job?.id);
      }
    }
    return job;
  }

  async function cancel(jobId) {
    const job = await registry.cancel(jobId);
    if (job?.status === 'cancelled') {
      try { audit.recordJobOutcome({ jobId: job.id, outcome: 'cancelled' }); }
      catch { safeAuditFailure(onAuditError, 'cancel', job?.id); }
    }
    return job;
  }

  return new Proxy(registry, {
    get(target, property, receiver) {
      if (property === 'enqueue') return enqueue;
      if (property === 'complete') return complete;
      if (property === 'cancel') return cancel;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
