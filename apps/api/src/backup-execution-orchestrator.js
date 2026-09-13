import { createBackupExecutionPlan } from './backup-execution-plan.js';

const CHILD_EXECUTORS = new Set(['database_backup', 'mail_data_backup']);
const TERMINAL_OPERATION_STATUSES = new Set(['succeeded', 'failed']);
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;

export class BackupExecutionOrchestratorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupExecutionOrchestratorError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new BackupExecutionOrchestratorError(code, message, status);
}

function childFailure(job) {
  const code = typeof job?.error?.code === 'string' && ERROR_CODE_PATTERN.test(job.error.code)
    ? job.error.code
    : job?.status === 'cancelled' ? 'backup_child_cancelled' : 'backup_child_failed';
  return Object.freeze({
    code,
    message: job?.status === 'cancelled' ? 'Backup child job was cancelled' : 'Backup child job failed',
  });
}

function publicAdvance(operation, childJob = null) {
  return Object.freeze({ operation, childJob, waiting: Boolean(childJob && !TERMINAL_JOB_STATUSES.has(childJob.status)) });
}

export function createBackupExecutionOrchestrator({
  backupResourceProvider,
  backupOperationRegistry,
  childJobDispatcher,
  localExecutors = {},
} = {}) {
  if (!backupResourceProvider || typeof backupResourceProvider.preview !== 'function') {
    throw new BackupExecutionOrchestratorError('backup_orchestrator_dependencies_invalid', 'Backup resource provider is required', 503);
  }
  if (!backupOperationRegistry
    || typeof backupOperationRegistry.create !== 'function'
    || typeof backupOperationRegistry.start !== 'function'
    || typeof backupOperationRegistry.linkStep !== 'function'
    || typeof backupOperationRegistry.succeedStep !== 'function'
    || typeof backupOperationRegistry.failStep !== 'function'
    || typeof backupOperationRegistry.getOperation !== 'function') {
    throw new BackupExecutionOrchestratorError('backup_orchestrator_dependencies_invalid', 'Backup operation registry is required', 503);
  }
  if (!childJobDispatcher
    || typeof childJobDispatcher.prepare !== 'function'
    || typeof childJobDispatcher.enqueuePrepared !== 'function'
    || typeof childJobDispatcher.evidence !== 'function') {
    throw new BackupExecutionOrchestratorError('backup_orchestrator_dependencies_invalid', 'Backup child dispatcher is required', 503);
  }
  if (!localExecutors || typeof localExecutors !== 'object' || Array.isArray(localExecutors)) {
    throw new BackupExecutionOrchestratorError('backup_orchestrator_dependencies_invalid', 'Backup local executors are invalid', 503);
  }

  function assertExecutors(plan) {
    for (const step of plan.steps) {
      if (CHILD_EXECUTORS.has(step.executorKind)) continue;
      const executor = localExecutors[step.executorKind];
      if (!executor || typeof executor.prepare !== 'function' || typeof executor.executePrepared !== 'function') {
        fail('backup_executor_unavailable', `Backup executor ${step.executorKind} is not available`, 503);
      }
    }
  }

  async function create({
    serverId,
    selectedResourceIdentities = null,
    expectedPreviewDigest,
    confirmation,
  } = {}) {
    const preview = await backupResourceProvider.preview({ serverId, selectedResourceIdentities });
    const executionPlan = createBackupExecutionPlan({
      plan: preview,
      expectedPreviewDigest,
      confirmation,
    });
    assertExecutors(executionPlan);
    return backupOperationRegistry.create(executionPlan);
  }

  async function executeLocalStep(operation, planStep, stepState) {
    const executor = localExecutors[planStep.executorKind];
    if (!executor) fail('backup_executor_unavailable', `Backup executor ${planStep.executorKind} is not available`, 503);
    let current = operation;
    let state = stepState;
    if (state.status === 'pending') {
      const prepared = await executor.prepare(operation.serverId, planStep);
      if (!prepared?.workRef || prepared.workRef.kind !== 'local') {
        fail('backup_local_prepare_invalid', 'Backup local executor returned invalid dispatch intent', 503);
      }
      current = await backupOperationRegistry.linkStep({
        operationId: operation.id,
        stepId: planStep.stepId,
        workRef: prepared.workRef,
      });
      state = current.steps.find((step) => step.stepId === planStep.stepId);
    }
    let result;
    try {
      result = await executor.executePrepared(operation.serverId, planStep, state.workRef);
    } catch (error) {
      const safeError = {
        code: typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code) ? error.code : 'backup_local_execution_failed',
        message: 'Backup local execution failed',
      };
      const failed = await backupOperationRegistry.failStep({
        operationId: current.id,
        stepId: planStep.stepId,
        workRef: state.workRef,
        error: safeError,
      });
      return publicAdvance(failed);
    }
    if (!result?.evidence) fail('backup_local_result_invalid', 'Backup local executor returned invalid evidence', 503);
    const succeeded = await backupOperationRegistry.succeedStep({
      operationId: current.id,
      stepId: planStep.stepId,
      workRef: state.workRef,
      evidence: result.evidence,
    });
    return publicAdvance(succeeded);
  }

  async function advance(operationId) {
    let operation = await backupOperationRegistry.getOperation(operationId);
    if (!operation) fail('backup_operation_not_found', 'Backup operation was not found', 404);
    if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return publicAdvance(operation);
    if (operation.status === 'queued') operation = await backupOperationRegistry.start(operation.id);

    for (;;) {
      if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return publicAdvance(operation);
      const stepIndex = operation.steps.findIndex((step) => step.status !== 'succeeded');
      if (stepIndex < 0) fail('backup_operation_state_invalid', 'Running backup operation has no remaining step');
      const stepState = operation.steps[stepIndex];
      const planStep = operation.plan.steps[stepIndex];
      if (stepState.stepId !== planStep.stepId) fail('backup_operation_state_invalid', 'Backup operation step state is misaligned');

      if (!CHILD_EXECUTORS.has(planStep.executorKind)) {
        return executeLocalStep(operation, planStep, stepState);
      }

      if (stepState.status === 'pending') {
        const prepared = await childJobDispatcher.prepare(operation.serverId, planStep);
        operation = await backupOperationRegistry.linkStep({
          operationId: operation.id,
          stepId: planStep.stepId,
          workRef: prepared.workRef,
        });
      }
      const persistedStep = operation.steps[stepIndex];
      if (persistedStep.status !== 'dispatched') {
        fail('backup_operation_state_invalid', 'Backup child step is not dispatchable');
      }
      const childJob = await childJobDispatcher.enqueuePrepared(
        operation.serverId,
        planStep,
        persistedStep.workRef,
      );
      if (!childJob || typeof childJob.status !== 'string') {
        fail('backup_child_job_invalid', 'Backup child queue returned invalid state', 503);
      }
      if (childJob.status === 'queued' || childJob.status === 'running') {
        return publicAdvance(operation, childJob);
      }
      if (childJob.status === 'succeeded') {
        const evidence = childJobDispatcher.evidence(planStep, childJob);
        operation = await backupOperationRegistry.succeedStep({
          operationId: operation.id,
          stepId: planStep.stepId,
          workRef: persistedStep.workRef,
          evidence,
        });
        continue;
      }
      const failed = await backupOperationRegistry.failStep({
        operationId: operation.id,
        stepId: planStep.stepId,
        workRef: persistedStep.workRef,
        error: childFailure(childJob),
      });
      return publicAdvance(failed, childJob);
    }
  }

  return Object.freeze({ create, advance });
}

export const backupExecutionOrchestratorInternals = Object.freeze({
  childExecutors: Object.freeze([...CHILD_EXECUTORS]),
  childFailure,
  publicAdvance,
});
