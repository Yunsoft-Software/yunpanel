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

function safeStepFailure(error, fallbackCode, message) {
  return Object.freeze({
    code: typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code) ? error.code : fallbackCode,
    message,
  });
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
    || typeof childJobDispatcher.intent !== 'function'
    || typeof childJobDispatcher.dispatchPrepared !== 'function'
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

  async function failDispatchedStep(operation, planStep, stepState, error, fallbackCode, message, childJob = null) {
    const failed = await backupOperationRegistry.failStep({
      operationId: operation.id,
      stepId: planStep.stepId,
      workRef: stepState.workRef,
      error: safeStepFailure(error, fallbackCode, message),
    });
    return publicAdvance(failed, childJob);
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
    if (!state || state.status !== 'dispatched' || state.workRef?.kind !== 'local') {
      fail('backup_operation_state_invalid', 'Backup local step is not dispatchable');
    }

    let result;
    try {
      result = await executor.executePrepared(operation.serverId, planStep, state.workRef);
      if (!result?.evidence) {
        throw new BackupExecutionOrchestratorError(
          'backup_local_result_invalid',
          'Backup local executor returned invalid evidence',
          503,
        );
      }
    } catch (error) {
      return failDispatchedStep(
        current,
        planStep,
        state,
        error,
        'backup_local_execution_failed',
        'Backup local execution failed',
      );
    }

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
        const workRef = childJobDispatcher.intent(planStep);
        if (!workRef || workRef.kind !== 'job') {
          fail('backup_child_prepare_invalid', 'Backup child dispatcher returned invalid dispatch intent', 503);
        }
        operation = await backupOperationRegistry.linkStep({
          operationId: operation.id,
          stepId: planStep.stepId,
          workRef,
        });
      }
      const persistedStep = operation.steps[stepIndex];
      if (persistedStep.status !== 'dispatched' || persistedStep.workRef?.kind !== 'job') {
        fail('backup_operation_state_invalid', 'Backup child step is not dispatchable');
      }

      let childJob;
      try {
        childJob = await childJobDispatcher.dispatchPrepared(
          operation.serverId,
          planStep,
          persistedStep.workRef,
        );
      } catch (error) {
        return failDispatchedStep(
          operation,
          planStep,
          persistedStep,
          error,
          'backup_child_dispatch_failed',
          'Backup child dispatch failed',
        );
      }
      if (!childJob || typeof childJob.status !== 'string') {
        return failDispatchedStep(
          operation,
          planStep,
          persistedStep,
          new BackupExecutionOrchestratorError('backup_child_job_invalid', 'Backup child queue returned invalid state', 503),
          'backup_child_job_invalid',
          'Backup child dispatch failed',
        );
      }
      if (childJob.status === 'queued' || childJob.status === 'running') {
        return publicAdvance(operation, childJob);
      }
      if (childJob.status === 'succeeded') {
        let evidence;
        try { evidence = childJobDispatcher.evidence(planStep, childJob); }
        catch (error) {
          return failDispatchedStep(
            operation,
            planStep,
            persistedStep,
            error,
            'backup_child_result_invalid',
            'Backup child evidence is invalid',
            childJob,
          );
        }
        operation = await backupOperationRegistry.succeedStep({
          operationId: operation.id,
          stepId: planStep.stepId,
          workRef: persistedStep.workRef,
          evidence,
        });
        continue;
      }
      if (childJob.status !== 'failed' && childJob.status !== 'cancelled') {
        return failDispatchedStep(
          operation,
          planStep,
          persistedStep,
          new BackupExecutionOrchestratorError('backup_child_job_invalid', 'Backup child queue returned invalid state', 503),
          'backup_child_job_invalid',
          'Backup child dispatch failed',
          childJob,
        );
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
  safeStepFailure,
  childFailure,
  publicAdvance,
});
