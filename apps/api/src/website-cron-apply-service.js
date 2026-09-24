import { createHash } from 'node:crypto';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import { OPERATIONS } from '@yunpanel/protocol';
import { createCronRemovalRequest } from './website-cron-removal-request.js';
import { verifyCronRemovalJob } from './website-cron-removal-proof.js';

export class WebsiteCronApplyServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteCronApplyServiceError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function calculateDesiredStateDigest(task) {
  const rendered = renderCronTaskFile({
    taskId: task.id,
    user: task.unixUser,
    schedule: task.schedule,
    command: task.command,
    enabled: task.enabled,
  });
  return sha256(rendered);
}

export function createWebsiteCronApplyService({
  websiteCronRegistry,
  jobRegistry,
  websiteRegistry,
  reconciliationProvider,
} = {}) {
  if (!websiteCronRegistry || typeof websiteCronRegistry.createTask !== 'function'
    || typeof websiteCronRegistry.updateTask !== 'function'
    || typeof websiteCronRegistry.deleteTask !== 'function'
    || typeof websiteCronRegistry.getTask !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new WebsiteCronApplyServiceError(
      'website_cron_service_dependencies_invalid',
      'Website cron apply service dependencies are invalid',
      500,
    );
  }

  async function assertHostedWebsite(websiteId) {
    let website;
    try {
      website = await websiteRegistry.getWebsite(websiteId);
    } catch {
      throw new WebsiteCronApplyServiceError(
        'website_unavailable',
        'Website could not be verified',
        503,
      );
    }
    if (!website) {
      throw new WebsiteCronApplyServiceError(
        'website_not_found',
        'Website was not found',
        404,
      );
    }
    if (!['static', 'node', 'php'].includes(website.runtimeType)) {
      throw new WebsiteCronApplyServiceError(
        'website_cron_unsupported_runtime',
        'Cron tasks are only supported for hosted websites (static, node, php)',
        409,
      );
    }
    return website;
  }

  async function listCrons(websiteId) {
    await assertHostedWebsite(websiteId);
    if (reconciliationProvider && typeof reconciliationProvider.reconcileWebsite === 'function') {
      return reconciliationProvider.reconcileWebsite(websiteId);
    }
    const tasks = await websiteCronRegistry.listTasks({ websiteId });
    return Object.freeze({
      websiteId,
      cronServiceActive: null,
      tasks: Object.freeze(tasks),
      summary: Object.freeze({ total: tasks.length, ready: 0, unknown: tasks.length }),
      reconciled: false,
    });
  }

  async function getCron(taskId) {
    const task = await websiteCronRegistry.getTask(taskId);
    if (!task) {
      throw new WebsiteCronApplyServiceError('cron_task_not_found', 'Cron task was not found', 404);
    }
    await assertHostedWebsite(task.websiteId);
    return task;
  }

  async function createCron({ websiteId, name, schedule, command, enabled = true }) {
    await assertHostedWebsite(websiteId);
    const task = await websiteCronRegistry.createTask({
      websiteId,
      name,
      schedule,
      command,
      enabled,
    });

    const desiredStateSha256 = calculateDesiredStateDigest(task);
    const job = await jobRegistry.enqueue({
      serverId: task.serverId,
      type: OPERATIONS.CRON_APPLY,
      operation: OPERATIONS.CRON_APPLY,
      payload: {
        taskId: task.id,
        websiteId: task.websiteId,
        applicationId: task.applicationId,
        unixUser: task.unixUser,
        expectedRevision: task.revision,
        desiredStateSha256,
      },
      resourceType: 'website_cron',
      resourceId: task.id,
      idempotencyKey: `cron.apply:${task.id}:${task.revision}:${desiredStateSha256}`,
    });

    return Object.freeze({ task, job });
  }

  async function updateCron(taskId, { expectedRevision, name, schedule, command, enabled }) {
    const current = await getCron(taskId);
    const task = await websiteCronRegistry.updateTask(taskId, {
      expectedRevision,
      name,
      schedule,
      command,
      enabled,
    });

    const desiredStateSha256 = calculateDesiredStateDigest(task);
    const job = await jobRegistry.enqueue({
      serverId: task.serverId,
      type: OPERATIONS.CRON_APPLY,
      operation: OPERATIONS.CRON_APPLY,
      payload: {
        taskId: task.id,
        websiteId: task.websiteId,
        applicationId: task.applicationId,
        unixUser: task.unixUser,
        expectedRevision: task.revision,
        desiredStateSha256,
      },
      resourceType: 'website_cron',
      resourceId: task.id,
      idempotencyKey: `cron.apply:${task.id}:${task.revision}:${desiredStateSha256}`,
    });

    return Object.freeze({ task, job });
  }

  async function deleteCron(taskId, { expectedRevision }) {
    const task = await getCron(taskId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new WebsiteCronApplyServiceError('cron_revision_invalid', 'expectedRevision must be a positive integer', 400);
    }
    if (task.revision !== expectedRevision) {
      throw new WebsiteCronApplyServiceError('cron_revision_conflict', 'Cron task changed after it was read', 409);
    }

    const { identity, request } = createCronRemovalRequest(task);
    const job = await jobRegistry.enqueue(request);
    const proof = verifyCronRemovalJob(job, identity);
    const deleted = proof.status === 'succeeded' && await websiteCronRegistry.getTask(task.id) === null;

    return Object.freeze({
      taskId: task.id,
      websiteId: task.websiteId,
      accepted: true,
      deleted,
      job,
    });
  }

  return Object.freeze({
    listCrons,
    getCron,
    createCron,
    updateCron,
    deleteCron,
  });
}
