import { OPERATIONS } from '@yunpanel/protocol';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class WebsiteCronJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteCronJobResultError';
    this.code = code;
  }
}

function invalid(message) {
  throw new WebsiteCronJobResultError('invalid_job_result', message);
}

export function sanitizeWebsiteCronJobResult(job, result) {
  const terminalField = job.operation === OPERATIONS.CRON_APPLY ? 'applied'
    : job.operation === OPERATIONS.CRON_REMOVE ? 'removed'
      : null;
  if (!terminalField || !job?.payload || !result || typeof result !== 'object' || Array.isArray(result)) {
    invalid('Website cron result is invalid');
  }
  const expectedKeys = [
    'version', 'taskId', 'websiteId', 'applicationId', 'unixUser',
    'revision', 'desiredStateSha256', 'contentSha256', terminalField, 'sideEffects',
  ];
  if (Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || result.taskId !== job.payload.taskId || !UUID_PATTERN.test(result.taskId)
    || result.websiteId !== job.payload.websiteId || !UUID_PATTERN.test(result.websiteId)
    || result.applicationId !== job.payload.applicationId || !UUID_PATTERN.test(result.applicationId)
    || result.unixUser !== job.payload.unixUser || !APP_USER_PATTERN.test(result.unixUser)
    || result.revision !== job.payload.expectedRevision || !Number.isSafeInteger(result.revision) || result.revision < 1
    || result.desiredStateSha256 !== job.payload.desiredStateSha256 || !SHA256_PATTERN.test(result.desiredStateSha256)
    || (result.contentSha256 !== null && !SHA256_PATTERN.test(result.contentSha256))
    || result[terminalField] !== true || typeof result.sideEffects !== 'boolean') {
    invalid('Website cron result does not match the queued desired state');
  }
  return Object.freeze({
    version: 1,
    taskId: result.taskId,
    websiteId: result.websiteId,
    applicationId: result.applicationId,
    unixUser: result.unixUser,
    revision: result.revision,
    desiredStateSha256: result.desiredStateSha256,
    contentSha256: result.contentSha256,
    [terminalField]: true,
    sideEffects: result.sideEffects,
  });
}
