// One contract for host removal and the existing cron.remove job result.
// No command execution, registry mutation, or optimistic completion here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const USER = /^yunapp-[a-f0-9]{12}$/;
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = (value) => typeof value === 'string' && UUID.test(value);

export class WebsiteCronRemovalProofError extends Error {
  constructor(code = 'website_cron_removal_unverified', message = 'Cron removal could not be verified.', status = 409) {
    super(message); this.name = 'WebsiteCronRemovalProofError'; this.code = code; this.status = status;
  }
}
function requireValue(condition) { if (!condition) throw new WebsiteCronRemovalProofError(); }

export function cronRemovalIdentity(task, desiredStateSha256) {
  requireValue(record(task) && uuid(task.id) && uuid(task.websiteId) && uuid(task.serverId)
    && uuid(task.applicationId) && typeof task.unixUser === 'string' && USER.test(task.unixUser)
    && Number.isSafeInteger(task.revision) && task.revision > 0
    && typeof desiredStateSha256 === 'string' && SHA.test(desiredStateSha256));
  return Object.freeze({ taskId: task.id, websiteId: task.websiteId, serverId: task.serverId,
    applicationId: task.applicationId, unixUser: task.unixUser, revision: task.revision, desiredStateSha256 });
}

export function verifyCronHostRemoval(result, identity) {
  requireValue(record(result) && result.taskId === identity.taskId);
  // The existing manager reports removed:false only for proven prior absence.
  const removed = result.removed === true && result.previousSha256 === identity.desiredStateSha256 && result.sideEffects === true;
  const absent = result.removed === false && result.previousSha256 === null && result.sideEffects === false;
  requireValue(removed || absent);
  return Object.freeze({ contentSha256: result.previousSha256, sideEffects: result.sideEffects });
}

export function verifyCronRemovalJob(job, identity, expectedJobId = null) {
  requireValue(record(job) && typeof job.id === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(job.id)
    && (expectedJobId === null || job.id === expectedJobId)
    && job.serverId === identity.serverId && job.operation === 'cron.remove'
    && job.resourceType === 'website_cron' && job.resourceId === identity.taskId
    && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status));
  const projection = { id: job.id, status: job.status };
  if (job.status !== 'succeeded') return Object.freeze(projection);
  const value = job.result;
  requireValue(record(value) && value.version === 1 && value.removed === true
    && value.taskId === identity.taskId && value.websiteId === identity.websiteId
    && value.applicationId === identity.applicationId && value.unixUser === identity.unixUser
    && value.revision === identity.revision && value.desiredStateSha256 === identity.desiredStateSha256
    && ((value.contentSha256 === identity.desiredStateSha256 && value.sideEffects === true)
      || (value.contentSha256 === null && value.sideEffects === false)));
  return Object.freeze({ ...projection, removed: true });
}
