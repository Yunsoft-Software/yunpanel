import { DOCKER_COMPOSE_OPERATIONS } from '@yunpanel/protocol';

const OPERATION_SET = new Set(DOCKER_COMPOSE_OPERATIONS);

export class DockerComposeRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DockerComposeRecoveryError';
    this.code = code;
  }
}

function receiptResult(job, receipt) {
  if (!job || job.status !== 'running' || job.resourceType !== 'docker_project'
    || !OPERATION_SET.has(job.operation) || !job.payload
    || receipt?.serverId !== job.serverId || receipt.jobId !== job.id
    || receipt.operation !== job.operation || receipt.projectId !== job.resourceId
    || receipt.projectId !== job.payload.projectId
    || receipt.projectRevision !== job.payload.expectedProjectRevision
    || receipt.environmentRevision !== job.payload.expectedEnvironmentRevision
    || receipt.composeSha256 !== job.payload.expectedComposeSha256
    || receipt.executed !== true || receipt.sideEffects !== true) {
    throw new DockerComposeRecoveryError(
      'docker_compose_recovery_receipt_mismatch',
      'Docker Compose recovery receipt does not match the persisted running job',
    );
  }
  return Object.freeze({
    version: 1,
    projectId: receipt.projectId,
    projectRevision: receipt.projectRevision,
    environmentRevision: receipt.environmentRevision,
    composeSha256: receipt.composeSha256,
    action: receipt.action,
    runtimeState: receipt.runtimeState,
    executed: true,
    sideEffects: true,
  });
}

export function createDockerComposeRecoveryService({
  jobRegistry,
  receiptStore,
  reconcileCompletedJob,
} = {}) {
  if (!jobRegistry || typeof jobRegistry.recovery !== 'function'
    || typeof jobRegistry.getJob !== 'function' || typeof jobRegistry.complete !== 'function'
    || typeof jobRegistry.beginReconciliation !== 'function'
    || typeof jobRegistry.acknowledgeReconciliation !== 'function'
    || !receiptStore || typeof receiptStore.read !== 'function'
    || typeof reconcileCompletedJob !== 'function') {
    throw new DockerComposeRecoveryError(
      'docker_compose_recovery_dependencies_invalid',
      'Docker Compose recovery dependencies are invalid',
    );
  }

  async function reconcileAndAcknowledge(job) {
    const reconciliation = await reconcileCompletedJob(job);
    if (!reconciliation || reconciliation.reconciled !== true) {
      throw new DockerComposeRecoveryError(
        'docker_compose_recovery_reconciliation_failed',
        'Docker Compose recovered job could not be reconciled',
      );
    }
    const acknowledged = await jobRegistry.acknowledgeReconciliation({
      serverId: job.serverId,
      jobId: job.id,
    });
    if (!acknowledged || acknowledged.jobId !== job.id || acknowledged.serverId !== job.serverId
      || acknowledged.status !== job.status || acknowledged.acknowledged !== true) {
      throw new DockerComposeRecoveryError(
        'docker_compose_recovery_acknowledgement_failed',
        'Docker Compose recovered job acknowledgement is inconsistent',
      );
    }
  }

  async function recover() {
    const recovery = jobRegistry.recovery();
    if (!recovery) return Object.freeze({ recovered: Object.freeze([]), pending: Object.freeze([]) });
    if (!Array.isArray(recovery.jobs)) {
      throw new DockerComposeRecoveryError(
        'docker_compose_recovery_state_invalid',
        'Docker Compose durable recovery state is invalid',
      );
    }

    const recovered = [];
    const pending = [];
    for (const identity of recovery.jobs) {
      const job = await jobRegistry.getJob(identity.jobId);
      if (!job || job.serverId !== identity.serverId) {
        throw new DockerComposeRecoveryError(
          'docker_compose_recovery_job_missing',
          'Docker Compose durable recovery references a missing job',
        );
      }
      if (!OPERATION_SET.has(job.operation) || job.resourceType !== 'docker_project') {
        pending.push(Object.freeze({ jobId: job.id, serverId: job.serverId, reason: 'non_compose_job' }));
        continue;
      }

      if (job.status === 'succeeded' || job.status === 'failed') {
        await reconcileAndAcknowledge(job);
        recovered.push(Object.freeze({ jobId: job.id, serverId: job.serverId, status: job.status, source: 'durable_result' }));
        continue;
      }
      if (job.status !== 'running') {
        throw new DockerComposeRecoveryError(
          'docker_compose_recovery_job_state_invalid',
          'Docker Compose recovery job is not running or terminal',
        );
      }

      const receipt = await receiptStore.read(job.id);
      if (!receipt) {
        pending.push(Object.freeze({ jobId: job.id, serverId: job.serverId, reason: 'receipt_missing' }));
        continue;
      }
      const result = receiptResult(job, receipt);
      const begun = await jobRegistry.beginReconciliation({ serverId: job.serverId, jobId: job.id });
      if (!begun || begun.jobId !== job.id || begun.serverId !== job.serverId
        || begun.status !== 'running' || begun.pending !== true) {
        throw new DockerComposeRecoveryError(
          'docker_compose_recovery_begin_failed',
          'Docker Compose recovery reconciliation could not be started',
        );
      }
      const terminal = await jobRegistry.complete({
        serverId: job.serverId,
        jobId: job.id,
        status: 'succeeded',
        result,
      });
      if (!terminal || terminal.id !== job.id || terminal.serverId !== job.serverId || terminal.status !== 'succeeded') {
        throw new DockerComposeRecoveryError(
          'docker_compose_recovery_completion_failed',
          'Docker Compose recovery completion is inconsistent',
        );
      }
      await reconcileAndAcknowledge(terminal);
      recovered.push(Object.freeze({ jobId: job.id, serverId: job.serverId, status: 'succeeded', source: 'operation_receipt' }));
    }
    return Object.freeze({ recovered: Object.freeze(recovered), pending: Object.freeze(pending) });
  }

  return Object.freeze({ recover });
}

export const dockerComposeRecoveryInternals = Object.freeze({
  operations: Object.freeze([...DOCKER_COMPOSE_OPERATIONS]),
  receiptResult,
});
