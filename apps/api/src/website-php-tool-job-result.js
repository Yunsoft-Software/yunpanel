const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const ACTIONS = new Set([
  'wp.cache.flush',
  'wp.transients.delete-all',
  'composer.dump-autoload',
]);

export class WebsitePhpToolJobResultError extends Error {
  constructor(code = 'website_php_action_result_invalid', message = 'PHP tool job result is invalid') {
    super(message);
    this.name = 'WebsitePhpToolJobResultError';
    this.code = code;
  }
}

export function sanitizeWebsitePhpToolJobResult(job, result) {
  const fields = [
    'version', 'websiteId', 'applicationId', 'actionId', 'websiteRevision',
    'previewDigest', 'completed', 'sideEffects',
  ];
  if (!job || job.operation !== 'website.php.action'
    || job.resourceType !== 'application'
    || !result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).length !== fields.length
    || fields.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || typeof result.websiteId !== 'string' || !UUID.test(result.websiteId)
    || typeof result.applicationId !== 'string' || !UUID.test(result.applicationId)
    || result.applicationId !== job.resourceId
    || typeof result.actionId !== 'string' || !ACTIONS.has(result.actionId)
    || !Number.isSafeInteger(result.websiteRevision) || result.websiteRevision < 1
    || typeof result.previewDigest !== 'string' || !SHA.test(result.previewDigest)
    || result.completed !== true || result.sideEffects !== true
    || job.payload?.websiteId !== result.websiteId
    || job.payload?.applicationId !== result.applicationId
    || job.payload?.actionId !== result.actionId
    || job.payload?.expectedWebsiteRevision !== result.websiteRevision
    || job.payload?.previewDigest !== result.previewDigest) {
    throw new WebsitePhpToolJobResultError();
  }
  return Object.freeze({
    version: 1,
    websiteId: result.websiteId.toLowerCase(),
    applicationId: result.applicationId.toLowerCase(),
    actionId: result.actionId,
    websiteRevision: result.websiteRevision,
    previewDigest: result.previewDigest,
    completed: true,
    sideEffects: true,
  });
}
