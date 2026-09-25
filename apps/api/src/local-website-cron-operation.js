import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { createWebsiteCronManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { createWebsiteCronOperationReceiptStore } from './website-cron-operation-receipt.js';
import { cronRemovalIdentity, verifyCronHostRemoval } from './website-cron-removal-proof.js';

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalWebsiteCronOperationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LocalWebsiteCronOperationError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertExecution(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !EXECUTION_ID_PATTERN.test(execution.jobId)
    || typeof execution.serverId !== 'string' || !UUID_PATTERN.test(execution.serverId)
    || execution.resourceType !== 'website_cron' || typeof execution.resourceId !== 'string' || !execution.resourceId) {
    throw new LocalWebsiteCronOperationError(
      'website_cron_execution_context_invalid',
      'Website cron execution context is invalid',
    );
  }
  return execution;
}

export function createLocalWebsiteCronOperation({
  websiteCronRegistry,
  websiteCronManager = createWebsiteCronManager(),
  receiptStore = createWebsiteCronOperationReceiptStore(),
  siteMutationLock = null,
  authorizeActor = null,
  authorizeSystemRemoval = null,
} = {}) {
  if (!websiteCronRegistry || typeof websiteCronRegistry.getTask !== 'function'
    || !websiteCronManager || typeof websiteCronManager.apply !== 'function' || typeof websiteCronManager.remove !== 'function'
    || !receiptStore || typeof receiptStore.write !== 'function') {
    throw new LocalWebsiteCronOperationError(
      'website_cron_operation_dependencies_invalid',
      'Website cron local operation dependencies are invalid',
      500,
    );
  }

  async function authorizeMutation(operation, payload, execution) {
    if (payload?.authorizationMode === 'system_removal') {
      if (operation !== OPERATIONS.CRON_REMOVE) {
        throw new LocalWebsiteCronOperationError(
          'website_cron_authorization_invalid',
          'System Website removal authorization is valid only for cron removal',
          403,
        );
      }
      if (typeof authorizeSystemRemoval === 'function') {
        const authorization = await authorizeSystemRemoval({
          taskId: payload.taskId,
          websiteId: payload.websiteId,
          applicationId: payload.applicationId,
          serverId: execution.serverId,
          jobId: execution.jobId,
        });
        if (!authorization || authorization.authorized !== true) {
          throw new LocalWebsiteCronOperationError(
            'website_cron_actor_forbidden',
            'Website removal authorization changed before cron execution',
            403,
          );
        }
      }
      return Object.freeze({ mode: 'system_removal' });
    }
    if (payload?.authorizationMode !== 'user'
      || typeof authorizeActor !== 'function'
      || typeof payload.actorSessionId !== 'string'
      || typeof payload.actorUserId !== 'string'
      || !['owner', 'site_manager'].includes(payload.actorRole)) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_authorization_invalid',
        'Live panel authorization is required before cron execution',
        403,
      );
    }
    const actor = await authorizeActor({
      sessionId: payload.actorSessionId,
      userId: payload.actorUserId,
      role: payload.actorRole,
    }, payload.websiteId);
    if (!actor || actor.sessionId !== payload.actorSessionId
      || actor.userId !== payload.actorUserId || actor.role !== payload.actorRole) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_actor_forbidden',
        'Panel access changed before cron execution',
        403,
      );
    }
    return Object.freeze({ mode: 'user', actor });
  }

  async function executeUnlocked(operation, payload, execution) {
    const context = assertExecution(execution);
    if (![OPERATIONS.CRON_APPLY, OPERATIONS.CRON_REMOVE].includes(operation)) {
      throw new LocalWebsiteCronOperationError('website_cron_operation_invalid', 'Website cron operation is invalid');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || context.resourceId !== payload.taskId) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_resource_mismatch',
        'Execution resourceId does not match the payload taskId',
      );
    }

    await authorizeMutation(operation, payload, context);

    const task = await websiteCronRegistry.getTask(payload.taskId);
    if (!task) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_task_not_found',
        'Website cron task was not found in registry',
        404,
      );
    }

    if (task.id !== payload.taskId || task.serverId !== context.serverId
      || task.websiteId !== payload.websiteId
      || task.applicationId !== payload.applicationId
      || task.unixUser !== payload.unixUser
      || task.revision !== payload.expectedRevision) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_state_conflict',
        'Website cron task in registry does not match queued job payload',
        409,
      );
    }

    const rendered = renderCronTaskFile({
      taskId: task.id,
      user: task.unixUser,
      schedule: task.schedule,
      command: task.command,
      enabled: task.enabled,
    });
    const calculatedSha256 = sha256(rendered);
    if (calculatedSha256 !== payload.desiredStateSha256) {
      throw new LocalWebsiteCronOperationError(
        'website_cron_digest_mismatch',
        'Website cron task content digest does not match the queued desired state',
        409,
      );
    }

    let hostResult;
    let safeResult;

    if (operation === OPERATIONS.CRON_APPLY) {
      hostResult = await websiteCronManager.apply({
        taskId: task.id,
        user: task.unixUser,
        schedule: task.schedule,
        command: task.command,
        enabled: task.enabled,
      });

      safeResult = Object.freeze({
        version: 1,
        taskId: task.id,
        websiteId: task.websiteId,
        applicationId: task.applicationId,
        unixUser: task.unixUser,
        revision: task.revision,
        desiredStateSha256: payload.desiredStateSha256,
        contentSha256: hostResult.currentSha256,
        applied: true,
        sideEffects: hostResult.sideEffects,
      });
    } else {
      // A missing finalizer must be detected before touching the host.
      if (typeof websiteCronRegistry.deleteTask !== 'function') {
        throw new LocalWebsiteCronOperationError('website_cron_cleanup_unavailable', 'Cron metadata finalizer is unavailable', 503);
      }
      const identity = cronRemovalIdentity(task, calculatedSha256);
      hostResult = await websiteCronManager.remove({
        taskId: task.id,
        user: task.unixUser,
        schedule: task.schedule,
        command: task.command,
        enabled: task.enabled,
      });

      verifyCronHostRemoval(hostResult, identity);
      const deleted = await websiteCronRegistry.deleteTask(task.id, { expectedRevision: task.revision });
      if (deleted?.deleted !== true || deleted.taskId !== task.id
        || await websiteCronRegistry.getTask(task.id) !== null) {
        throw new LocalWebsiteCronOperationError('website_cron_cleanup_unverified', 'Cron host removal completed, but metadata removal is unverified', 409);
      }

      safeResult = Object.freeze({
        version: 1,
        taskId: task.id,
        websiteId: task.websiteId,
        applicationId: task.applicationId,
        unixUser: task.unixUser,
        revision: task.revision,
        desiredStateSha256: payload.desiredStateSha256,
        contentSha256: hostResult.previousSha256,
        removed: true,
        sideEffects: hostResult.sideEffects,
      });
    }

    try {
      await receiptStore.write({
        serverId: context.serverId,
        jobId: context.jobId,
        operation,
        result: safeResult,
      });
    } catch {
      // Do not hide partial removal: the host may be clean while recovery proof
      // is missing. The parent must remain blocked rather than retrying removal.
      if (operation === OPERATIONS.CRON_REMOVE) {
        throw new LocalWebsiteCronOperationError('website_cron_receipt_unavailable', 'Cron removal completed, but its recovery receipt could not be stored', 503);
      }
      // Preserve the existing apply-result contract outside this removal slice.
    }

    return safeResult;
  }

  async function execute(operation, payload, execution) {
    if (!siteMutationLock) return executeUnlocked(operation, payload, execution);
    if (typeof siteMutationLock.withSiteLock !== 'function') {
      throw new LocalWebsiteCronOperationError(
        'website_cron_operation_dependencies_invalid',
        'Site mutation lock is unavailable for Website cron execution',
        503,
      );
    }
    return siteMutationLock.withSiteLock({
      applicationId: payload?.applicationId ?? null,
      websiteId: payload?.websiteId ?? null,
    }, () => executeUnlocked(operation, payload, execution));
  }

  return Object.freeze({ execute });
}

export const localWebsiteCronOperationInternals = Object.freeze({
  assertExecution,
  sha256,
});
