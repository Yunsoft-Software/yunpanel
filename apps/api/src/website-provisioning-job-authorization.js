const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export class WebsiteProvisioningJobAuthorizationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteProvisioningJobAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeWebsiteProvisioningJobAuthorization(value, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'website_provisioning' || value.version !== 1
    || typeof value.operationId !== 'string' || !UUID_PATTERN.test(value.operationId)
    || typeof value.websiteId !== 'string' || !UUID_PATTERN.test(value.websiteId)
    || typeof value.stepId !== 'string' || !STEP_ID_PATTERN.test(value.stepId)
    || Object.keys(value).some((key) => !['kind', 'version', 'operationId', 'websiteId', 'stepId'].includes(key))) {
    throw new WebsiteProvisioningJobAuthorizationError(
      'website_provisioning_job_authorization_invalid',
      'Website provisioning child-job authorization scope is invalid',
    );
  }
  return Object.freeze({
    kind: 'website_provisioning',
    version: 1,
    operationId: value.operationId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    stepId: value.stepId,
  });
}

export function websiteProvisioningJobAuthorization(context = {}) {
  return normalizeWebsiteProvisioningJobAuthorization({
    kind: 'website_provisioning',
    version: 1,
    operationId: context.operationId,
    websiteId: context.websiteId,
    stepId: context.stepId,
  });
}
