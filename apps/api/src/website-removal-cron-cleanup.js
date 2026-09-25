import { createCronRemovalRequest, cronRemovalRequestFromIdentity } from './website-cron-removal-request.js';
import { verifyCronRemovalJob } from './website-cron-removal-proof.js';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const JOB_STATES = new Set(['prepared', 'queued', 'running', 'succeeded', 'failed', 'cancelled']);

export class WebsiteRemovalCronCleanupError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteRemovalCronCleanupError';
    this.code = code;
    this.status = status;
  }
}

function cleanupUnavailable(message) {
  throw new WebsiteRemovalCronCleanupError('website_removal_cleanup_unavailable', message, 503);
}

function cleanupUnverified(message) {
  throw new WebsiteRemovalCronCleanupError('website_removal_cleanup_unverified', message, 409);
}

function exactIds(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
    cleanupUnverified('Cron cleanup inventory is invalid.');
  }
  return [...values].sort();
}

function sameIds(left, right) {
  const a = exactIds(left);
  const b = exactIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safeIdentity(value, operation) {
  try {
    const request = cronRemovalRequestFromIdentity(value);
    const identity = Object.freeze({
      taskId: request.payload.taskId,
      websiteId: request.payload.websiteId,
      serverId: request.serverId,
      applicationId: request.payload.applicationId,
      unixUser: request.payload.unixUser,
      revision: request.payload.expectedRevision,
      desiredStateSha256: request.payload.desiredStateSha256,
    });
    if (identity.websiteId !== operation.websiteId
      || identity.serverId !== operation.serverId
      || identity.applicationId !== operation.applicationId) {
      cleanupUnverified('Cron cleanup identity no longer matches the Website removal journal.');
    }
    return identity;
  } catch (error) {
    if (error instanceof WebsiteRemovalCronCleanupError) throw error;
    cleanupUnverified('Cron cleanup identity is invalid.');
  }
}

function normalizeCheckpoint(value, operation, plannedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !Array.isArray(value.tasks)) {
    cleanupUnverified('Cron cleanup checkpoint is invalid.');
  }
  const tasks = value.tasks.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !entry.identity || typeof entry.identity !== 'object'
      || !JOB_STATES.has(entry.status)
      || (entry.jobId !== null && (typeof entry.jobId !== 'string' || !JOB_ID_PATTERN.test(entry.jobId)))) {
      cleanupUnverified('Cron cleanup checkpoint task is invalid.');
    }
    return {
      identity: safeIdentity(entry.identity, operation),
      jobId: entry.jobId,
      status: entry.status,
    };
  });
  if (!sameIds(tasks.map((entry) => entry.identity.taskId), plannedIds)
    || new Set(tasks.map((entry) => entry.identity.taskId)).size !== tasks.length) {
    cleanupUnverified('Cron cleanup checkpoint does not match the planned task inventory.');
  }
  return { version: 1, tasks };
}

function publicCheckpoint(checkpoint) {
  return Object.freeze({
    version: 1,
    tasks: Object.freeze(checkpoint.tasks.map((entry) => Object.freeze({
      identity: Object.freeze({ ...entry.identity }),
      jobId: entry.jobId,
      status: entry.status,
    }))),
  });
}

async function prepareCheckpoint(operation, websiteCronRegistry, plannedIds) {
  let tasks;
  try {
    tasks = await websiteCronRegistry.listTasks({ websiteId: operation.websiteId });
  } catch {
    cleanupUnverified('Cron cleanup inventory could not be loaded.');
  }
  if (!Array.isArray(tasks) || !sameIds(tasks.map((task) => task?.id), plannedIds)) {
    cleanupUnverified('Cron task inventory changed after the Website removal preview.');
  }
  const prepared = [];
  for (const task of tasks) {
    try {
      const { identity } = createCronRemovalRequest(task);
      prepared.push({ identity: safeIdentity(identity, operation), jobId: null, status: 'prepared' });
    } catch (error) {
      if (error instanceof WebsiteRemovalCronCleanupError) throw error;
      cleanupUnverified('Cron task state cannot be converted into removal evidence.');
    }
  }
  return { version: 1, tasks: prepared };
}

function requireDependencies(operationRegistry, websiteCronRegistry, jobRegistry) {
  if (!operationRegistry || typeof operationRegistry.checkpointStep !== 'function'
    || !websiteCronRegistry || typeof websiteCronRegistry.listTasks !== 'function'
    || typeof websiteCronRegistry.getTask !== 'function'
    || !jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.findIdempotentJob !== 'function') {
    cleanupUnavailable('Verified cron cleanup dependencies are unavailable.');
  }
}

async function readRemovalJob(jobRegistry, identity) {
  const request = cronRemovalRequestFromIdentity(identity);
  let job;
  try {
    job = await jobRegistry.findIdempotentJob(request);
    if (!job) job = await jobRegistry.enqueue(request);
  } catch {
    cleanupUnverified('Cron removal job could not be durably resolved.');
  }
  try {
    return verifyCronRemovalJob(job, identity);
  } catch {
    cleanupUnverified('Cron removal job does not match the Website removal checkpoint.');
  }
}

export async function advanceWebsiteRemovalCronCleanup({
  operation,
  step,
  operationRegistry,
  websiteCronRegistry,
  jobRegistry,
} = {}) {
  requireDependencies(operationRegistry, websiteCronRegistry, jobRegistry);
  const plannedIds = operation?.plan?.additional?.crons?.ids;
  if (!operation || !step || step.kind !== 'cron_cleanup'
    || !Array.isArray(plannedIds) || plannedIds.length < 1) {
    cleanupUnverified('Website removal cron cleanup plan is invalid.');
  }

  let checkpoint;
  if (step.result === null || step.result === undefined) {
    checkpoint = await prepareCheckpoint(operation, websiteCronRegistry, plannedIds);
    await operationRegistry.checkpointStep(operation.id, step.id, publicCheckpoint(checkpoint));
  } else {
    checkpoint = normalizeCheckpoint(step.result, operation, plannedIds);
  }

  for (const task of checkpoint.tasks) {
    if (task.status === 'succeeded') continue;
    const proof = await readRemovalJob(jobRegistry, task.identity);
    task.jobId = proof.id;
    task.status = proof.status;
    const updated = await operationRegistry.checkpointStep(
      operation.id,
      step.id,
      publicCheckpoint(checkpoint),
    );

    if (proof.status === 'queued' || proof.status === 'running') {
      return Object.freeze({ complete: false, operation: updated });
    }
    if (proof.status === 'failed' || proof.status === 'cancelled') {
      throw new WebsiteRemovalCronCleanupError(
        'website_removal_cron_job_failed',
        'The existing cron removal job did not complete successfully; reconcile that job before continuing Website removal.',
        409,
      );
    }

    let remaining;
    try { remaining = await websiteCronRegistry.getTask(task.identity.taskId); }
    catch { cleanupUnverified('Cron metadata absence could not be verified.'); }
    if (remaining !== null) {
      cleanupUnverified('Cron removal job succeeded but the task metadata is still present.');
    }
    task.status = 'succeeded';
    await operationRegistry.checkpointStep(operation.id, step.id, publicCheckpoint(checkpoint));
  }

  let remainingTasks;
  try { remainingTasks = await websiteCronRegistry.listTasks({ websiteId: operation.websiteId }); }
  catch { cleanupUnverified('Final cron cleanup inventory could not be verified.'); }
  if (!Array.isArray(remainingTasks) || remainingTasks.length !== 0) {
    cleanupUnverified('Cron tasks remain after the planned Website cleanup.');
  }

  return Object.freeze({
    complete: true,
    result: Object.freeze({
      cronsCleaned: true,
      taskIds: Object.freeze(checkpoint.tasks.map((entry) => entry.identity.taskId)),
      jobIds: Object.freeze(checkpoint.tasks.map((entry) => entry.jobId)),
    }),
  });
}
