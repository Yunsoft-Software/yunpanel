import { createHash } from 'node:crypto';
import { deterministicWebsiteMailDkimSelector } from './website-mail-dkim-selector.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'domainName',
  'expectedMailDomainRevision',
  'expectedMailDomainStatus',
  'expectedKeyRevision',
  'selector',
]);

export class WebsiteMailDkimKeyProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMailDkimKeyProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function intent(value, websiteId, operationId) {
  let expectedSelector;
  try { expectedSelector = deterministicWebsiteMailDkimSelector(operationId); }
  catch {
    throw new WebsiteMailDkimKeyProvisioningError(
      'website_mail_dkim_operation_invalid',
      'Website DKIM provisioning operation identity is invalid',
      400,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'managed-mail-dkim-key'
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '') || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.domainName !== 'string' || !value.domainName
    || value.expectedMailDomainRevision !== 2
    || value.expectedMailDomainStatus !== 'enabled'
    || value.expectedKeyRevision !== 0
    || value.selector !== expectedSelector) {
    throw new WebsiteMailDkimKeyProvisioningError(
      'website_mail_dkim_intent_invalid',
      'Website DKIM provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    serverId: value.serverId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    webDomainId: value.webDomainId.toLowerCase(),
    mailDomainId: value.mailDomainId.toLowerCase(),
    domainName: value.domainName,
    expectedMailDomainRevision: value.expectedMailDomainRevision,
    expectedMailDomainStatus: value.expectedMailDomainStatus,
    expectedKeyRevision: value.expectedKeyRevision,
    selector: value.selector,
  });
}

function keyEvidence(key, request) {
  if (!key || key.mailDomainId !== request.mailDomainId
    || key.domainName !== request.domainName
    || key.selector !== request.selector
    || key.revision !== request.expectedKeyRevision + 1
    || key.algorithm !== 'rsa-sha256'
    || key.dnsRecord?.type !== 'TXT'
    || key.dnsRecord.name !== `${request.selector}._domainkey.${request.domainName}`
    || typeof key.dnsRecord.value !== 'string' || !key.dnsRecord.value) {
    throw new WebsiteMailDkimKeyProvisioningError(
      'website_mail_dkim_key_drift',
      'Website DKIM key does not match operation-owned intent',
    );
  }
  const dnsRecordSha256 = createHash('sha256').update(JSON.stringify({
    type: key.dnsRecord.type,
    name: key.dnsRecord.name,
    value: key.dnsRecord.value,
  })).digest('hex');
  return Object.freeze({
    satisfied: true,
    adapter: 'managed-mail-dkim-key',
    mailDomainId: request.mailDomainId,
    selector: request.selector,
    keyRevision: key.revision,
    dnsRecordSha256,
  });
}

export function createWebsiteMailDkimKeyProvisioningHandler({
  mailDomainRegistry,
  domainRegistry,
  mailDkimRegistry,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || typeof mailDkimRegistry.createKey !== 'function') {
    throw new WebsiteMailDkimKeyProvisioningError(
      'website_mail_dkim_dependencies_invalid',
      'Website DKIM provisioning dependencies are invalid',
      503,
    );
  }

  async function scope(request) {
    const [mailDomain, webDomain] = await Promise.all([
      mailDomainRegistry.getMailDomain(request.mailDomainId),
      domainRegistry.getDomain(request.webDomainId),
    ]);
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local') {
      throw new WebsiteMailDkimKeyProvisioningError(
        'website_mail_dkim_domain_conflict',
        'Website DKIM Mail Domain ownership does not match provisioning intent',
      );
    }
    if (!webDomain || webDomain.id !== request.webDomainId
      || webDomain.serverId !== request.serverId
      || webDomain.websiteId !== request.websiteId
      || webDomain.primaryDomain !== request.domainName) {
      throw new WebsiteMailDkimKeyProvisioningError(
        'website_mail_dkim_web_domain_conflict',
        'Website DKIM Web Domain ownership does not match provisioning intent',
      );
    }
    if (mailDomain.status !== request.expectedMailDomainStatus
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteMailDkimKeyProvisioningError(
        'website_mail_dkim_mail_state_drift',
        'Website DKIM key generation requires the operation-owned enabled Mail Domain revision',
      );
    }
    return Object.freeze({ mailDomain, webDomain });
  }

  async function inspect(context = {}) {
    const request = intent(context.intent, context.websiteId, context.operationId);
    await scope(request);
    const key = await mailDkimRegistry.getKey(request.mailDomainId);
    if (!key) return Object.freeze({ satisfied: false, reason: 'website_mail_dkim_key_missing' });
    return keyEvidence(key, request);
  }

  async function apply(context = {}) {
    const request = intent(context.intent, context.websiteId, context.operationId);
    await scope(request);
    const existing = await mailDkimRegistry.getKey(request.mailDomainId);
    if (existing) return keyEvidence(existing, request);

    const created = await mailDkimRegistry.createKey(request.mailDomainId, {
      expectedRevision: request.expectedKeyRevision,
      selector: request.selector,
    });
    const evidence = keyEvidence(created, request);
    const persisted = await mailDkimRegistry.getKey(request.mailDomainId);
    keyEvidence(persisted, request);
    return evidence;
  }

  return Object.freeze({ apply, inspect });
}

export const websiteMailDkimKeyProvisioningInternals = Object.freeze({
  intent,
  keyEvidence,
});
