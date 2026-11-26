const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'zoneName',
  'mailDomainId',
  'domainName',
  'webmailHostname',
  'expectedMailDomainRevision',
  'expectedMailDomainStatus',
  'expectedDkimKeyRevision',
  'selector',
]);

export class WebsiteMailDnsProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMailDnsProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function intent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'powerdns-mail-reapply'
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '') || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.zoneName !== 'string' || !value.zoneName
    || typeof value.domainName !== 'string' || value.domainName !== value.zoneName
    || value.webmailHostname !== `webmail.${value.domainName}`
    || value.expectedMailDomainRevision !== 2
    || value.expectedMailDomainStatus !== 'enabled'
    || value.expectedDkimKeyRevision !== 1
    || typeof value.selector !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.selector)) {
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_intent_invalid',
      'Website local mail DNS provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    serverId: value.serverId.toLowerCase(),
    websiteId: value.websiteId.toLowerCase(),
    webDomainId: value.webDomainId.toLowerCase(),
    zoneName: value.zoneName,
    mailDomainId: value.mailDomainId.toLowerCase(),
    domainName: value.domainName,
    webmailHostname: value.webmailHostname,
    expectedMailDomainRevision: value.expectedMailDomainRevision,
    expectedMailDomainStatus: value.expectedMailDomainStatus,
    expectedDkimKeyRevision: value.expectedDkimKeyRevision,
    selector: value.selector,
  });
}

function validateChildOperation(operation, request, preview = null) {
  if (!operation || !UUID_PATTERN.test(operation.id ?? '')
    || operation.domainId !== request.webDomainId
    || operation.serverId !== request.serverId
    || operation.zoneName !== request.zoneName
    || operation.status !== 'succeeded'
    || !SHA256_PATTERN.test(operation.previewDigest ?? '')
    || !SHA256_PATTERN.test(operation.mailStateDigest ?? '')
    || operation.rollback?.available !== true
    || !SHA256_PATTERN.test(operation.rollback?.appliedZoneDigest ?? '')
    || !operation.result || operation.result.satisfied !== true
    || operation.result.zoneName !== request.zoneName
    || !Number.isSafeInteger(operation.result.serial) || operation.result.serial < 1) {
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_child_invalid',
      'Website local mail DNS child operation evidence is invalid',
      503,
    );
  }
  if (preview && (operation.mailStateDigest !== preview.mailStateDigest
    || operation.previewDigest !== preview.previewDigest)) {
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_child_conflict',
      'Website local mail DNS child operation does not match the planned desired state',
    );
  }
  return operation;
}

function evidence(operation, request, preview = null) {
  const spf = preview?.records?.find((record) => record?.source === 'mail'
    && record?.type === 'TXT'
    && record?.owner === request.zoneName
    && Array.isArray(record?.values)
    && record.values.some((val) => typeof val === 'string' && val.toLowerCase().startsWith('v=spf1')));
  const dmarc = preview?.records?.find((record) => record?.source === 'mail'
    && record?.type === 'TXT'
    && record?.owner === `_dmarc.${request.zoneName}`
    && Array.isArray(record?.values)
    && record.values.some((val) => typeof val === 'string' && val.toLowerCase().startsWith('v=dmarc1')));

  return Object.freeze({
    satisfied: true,
    adapter: 'powerdns-mail-reapply',
    webDomainId: request.webDomainId,
    mailDomainId: request.mailDomainId,
    webmailHostname: request.webmailHostname,
    dnsReapplyOperationId: operation.id,
    previewDigest: operation.previewDigest,
    mailStateDigest: operation.mailStateDigest,
    appliedZoneDigest: operation.rollback.appliedZoneDigest,
    serial: operation.result.serial,
    spfRecord: spf ? spf.values[0] : null,
    dmarcRecord: dmarc ? dmarc.values[0] : null,
  });
}

function rollbackEvidence(operation, request) {
  if (!operation || operation.status !== 'rolled_back'
    || operation.domainId !== request.webDomainId
    || operation.serverId !== request.serverId
    || operation.zoneName !== request.zoneName
    || operation.rollback?.status !== 'succeeded'
    || !operation.rollback?.result
    || operation.rollback.result.satisfied !== true
    || operation.rollback.result.zoneName !== request.zoneName
    || !SHA256_PATTERN.test(operation.rollback.result.sourceZoneDigest ?? '')) {
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_rollback_invalid',
      'Website local mail DNS rollback evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: 'powerdns-mail-reapply',
    webDomainId: request.webDomainId,
    mailDomainId: request.mailDomainId,
    dnsReapplyOperationId: operation.id,
    sourceZoneDigest: operation.rollback.result.sourceZoneDigest,
    rolledBack: true,
  });
}

export function createWebsiteMailDnsProvisioningHandler({
  mailDomainRegistry,
  domainRegistry,
  mailDkimRegistry,
  dnsZoneReapplyRuntime,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !dnsZoneReapplyRuntime || typeof dnsZoneReapplyRuntime.preview !== 'function'
    || typeof dnsZoneReapplyRuntime.start !== 'function'
    || typeof dnsZoneReapplyRuntime.listForDomain !== 'function'
    || typeof dnsZoneReapplyRuntime.get !== 'function'
    || typeof dnsZoneReapplyRuntime.rollbackPreview !== 'function'
    || typeof dnsZoneReapplyRuntime.rollback !== 'function') {
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_dependencies_invalid',
      'Website local mail DNS provisioning dependencies are invalid',
      503,
    );
  }

  async function scope(request) {
    const [mailDomain, webDomain, key] = await Promise.all([
      mailDomainRegistry.getMailDomain(request.mailDomainId),
      domainRegistry.getDomain(request.webDomainId),
      mailDkimRegistry.getKey(request.mailDomainId),
    ]);
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== request.expectedMailDomainStatus
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_mail_state_drift',
        'Website local mail DNS requires the operation-owned enabled Mail Domain revision',
      );
    }
    if (!webDomain || webDomain.id !== request.webDomainId
      || webDomain.serverId !== request.serverId
      || webDomain.websiteId !== request.websiteId
      || webDomain.primaryDomain !== request.zoneName
      || (webDomain.parentDomainId ?? null) !== null) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_domain_conflict',
        'Website local mail DNS ownership does not match the root Web Domain',
      );
    }
    if (!key || key.mailDomainId !== request.mailDomainId
      || key.domainName !== request.domainName
      || key.selector !== request.selector
      || key.revision !== request.expectedDkimKeyRevision
      || key.dnsRecord?.type !== 'TXT'
      || key.dnsRecord.name !== `${request.selector}._domainkey.${request.domainName}`
      || typeof key.dnsRecord.value !== 'string' || !key.dnsRecord.value) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_dkim_state_drift',
        'Website local mail DNS requires the operation-owned DKIM key revision',
      );
    }
    return Object.freeze({ mailDomain, webDomain, key });
  }

  function validatePreview(preview, request, key) {
    const mailState = preview?.mailState;
    if (!preview || preview.domainId !== request.webDomainId
      || preview.serverId !== request.serverId
      || preview.zoneName !== request.zoneName
      || !SHA256_PATTERN.test(preview.mailStateDigest ?? '')
      || !SHA256_PATTERN.test(preview.sourceZoneDigest ?? '')
      || !mailState || mailState.version !== 1 || mailState.managed !== true || mailState.enabled !== true
      || mailState.mailDomainId !== request.mailDomainId
      || mailState.mailDomainRevision !== request.expectedMailDomainRevision
      || JSON.stringify(mailState.dkimRevisions) !== JSON.stringify([request.expectedDkimKeyRevision])
      || !Array.isArray(preview.records)) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_preview_invalid',
        'Local authoritative DNS preview does not prove the expected mail desired state',
        503,
      );
    }
    const dkim = preview.records.find((record) => record?.source === 'mail'
      && record?.type === 'TXT'
      && record?.owner === key.dnsRecord.name);
    if (!dkim || !Array.isArray(dkim.values) || !dkim.values.includes(key.dnsRecord.value)) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_dkim_record_missing',
        'Local authoritative DNS preview is missing the operation-owned DKIM TXT record',
        503,
      );
    }
    const webmailRecords = preview.records.filter((record) => record?.source === 'mail'
      && ['A', 'AAAA'].includes(record?.type)
      && record?.owner === request.webmailHostname);
    if (webmailRecords.length < 1
      || webmailRecords.some((record) => !Array.isArray(record.values) || record.values.length < 1)) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_webmail_record_missing',
        'Local authoritative DNS preview is missing the webmail ACME routing record',
        503,
      );
    }
    const spf = preview.records.find((record) => record?.source === 'mail'
      && record?.type === 'TXT'
      && record?.owner === request.zoneName
      && Array.isArray(record?.values)
      && record.values.some((val) => typeof val === 'string' && val.toLowerCase().startsWith('v=spf1')));
    if (!spf) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_spf_record_missing',
        'Local authoritative DNS preview is missing the SPF policy TXT record',
        503,
      );
    }
    const dmarc = preview.records.find((record) => record?.source === 'mail'
      && record?.type === 'TXT'
      && record?.owner === `_dmarc.${request.zoneName}`
      && Array.isArray(record?.values)
      && record.values.some((val) => typeof val === 'string' && val.toLowerCase().startsWith('v=dmarc1')));
    if (!dmarc) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_dmarc_record_missing',
        'Local authoritative DNS preview is missing the DMARC policy TXT record',
        503,
      );
    }
    return preview;
  }

  async function currentPreview(request, key) {
    return validatePreview(
      await dnsZoneReapplyRuntime.preview({ domainId: request.webDomainId }),
      request,
      key,
    );
  }

  async function recoverSatisfiedChild(request, preview) {
    const operations = await dnsZoneReapplyRuntime.listForDomain(request.webDomainId);
    if (!Array.isArray(operations)) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_child_state_invalid',
        'Local authoritative DNS operation history is invalid',
        503,
      );
    }
    const candidates = operations.filter((operation) => (
      operation?.status === 'succeeded'
      && operation.domainId === request.webDomainId
      && operation.serverId === request.serverId
      && operation.zoneName === request.zoneName
      && operation.mailStateDigest === preview.mailStateDigest
      && operation.rollback?.available === true
      && operation.rollback.appliedZoneDigest === preview.sourceZoneDigest
    )).sort((left, right) => {
      const byTime = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
      return byTime !== 0 ? byTime : String(left.id).localeCompare(String(right.id));
    });
    return candidates.length > 0 ? candidates.at(-1) : null;
  }

  async function inspect(context = {}) {
    const request = intent(context.intent, context.websiteId);
    const { key } = await scope(request);
    const preview = await currentPreview(request, key);
    if (!preview.noChanges) {
      return Object.freeze({
        satisfied: false,
        reason: preview.applyAllowed === true
          ? 'website_mail_dns_reapply_required'
          : 'website_mail_dns_reapply_blocked',
      });
    }
    const child = await recoverSatisfiedChild(request, preview);
    if (!child) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_ownership_evidence_missing',
        'Desired local mail DNS state has no exact durable reapply ownership evidence',
      );
    }
    validateChildOperation(child, request);
    return evidence(child, request, preview);
  }

  async function apply(context = {}) {
    const request = intent(context.intent, context.websiteId);
    const { key } = await scope(request);
    const preview = await currentPreview(request, key);
    if (preview.noChanges) {
      const child = await recoverSatisfiedChild(request, preview);
      if (!child) {
        throw new WebsiteMailDnsProvisioningError(
          'website_mail_dns_ownership_evidence_missing',
          'Desired local mail DNS state has no exact durable reapply ownership evidence',
        );
      }
      validateChildOperation(child, request);
      return evidence(child, request, preview);
    }
    if (preview.applyAllowed !== true
      || !SHA256_PATTERN.test(preview.previewDigest ?? '')
      || typeof preview.confirmation !== 'string' || !preview.confirmation) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_reapply_blocked',
        'Local authoritative DNS desired state is not safe to apply',
        503,
      );
    }

    const child = validateChildOperation(
      await dnsZoneReapplyRuntime.start({
        domainId: request.webDomainId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
      request,
      preview,
    );
    const after = await currentPreview(request, key);
    if (!after.noChanges || after.sourceZoneDigest !== child.rollback.appliedZoneDigest
      || after.mailStateDigest !== child.mailStateDigest) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_postcondition_unverified',
        'Local authoritative DNS reapply completed without proving the exact desired state',
        503,
      );
    }
    return evidence(child, request, after);
  }

  function evidenceOperationId(context) {
    const operationId = context.evidence?.dnsReapplyOperationId;
    if (!UUID_PATTERN.test(operationId ?? '')) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_compensation_evidence_missing',
        'Website local mail DNS compensation requires the durable child operation identity',
      );
    }
    return operationId;
  }

  async function inspectCompensation(context = {}) {
    const request = intent(context.intent, context.websiteId);
    const operationId = evidenceOperationId(context);
    const operation = await dnsZoneReapplyRuntime.get(operationId);
    if (!operation || operation.domainId !== request.webDomainId
      || operation.serverId !== request.serverId || operation.zoneName !== request.zoneName) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_compensation_operation_missing',
        'Website local mail DNS rollback operation is unavailable',
      );
    }
    if (operation.status === 'rolled_back') return rollbackEvidence(operation, request);
    if (['succeeded', 'failed', 'rollback_failed'].includes(operation.status)
      && operation.rollback?.available === true) {
      return Object.freeze({ satisfied: false, reason: 'website_mail_dns_rollback_required' });
    }
    throw new WebsiteMailDnsProvisioningError(
      'website_mail_dns_compensation_state_invalid',
      'Website local mail DNS child operation is not safely rollbackable',
    );
  }

  async function compensate(context = {}) {
    const request = intent(context.intent, context.websiteId);
    const operationId = evidenceOperationId(context);
    const current = await dnsZoneReapplyRuntime.get(operationId);
    if (current?.status === 'rolled_back') return rollbackEvidence(current, request);
    if (!current || current.domainId !== request.webDomainId
      || current.serverId !== request.serverId || current.zoneName !== request.zoneName
      || current.rollback?.available !== true) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_compensation_state_invalid',
        'Website local mail DNS child operation is not safely rollbackable',
      );
    }
    const preview = await dnsZoneReapplyRuntime.rollbackPreview({
      domainId: request.webDomainId,
      operationId,
    });
    if (!preview?.operation || preview.operation.id !== operationId
      || preview.operation.domainId !== request.webDomainId
      || preview.operation.rollback?.available !== true
      || typeof preview.confirmation !== 'string' || !preview.confirmation) {
      throw new WebsiteMailDnsProvisioningError(
        'website_mail_dns_rollback_preview_invalid',
        'Website local mail DNS rollback preview is invalid',
        503,
      );
    }
    const completed = await dnsZoneReapplyRuntime.rollback({
      domainId: request.webDomainId,
      operationId,
      expectedUpdatedAt: preview.operation.updatedAt,
      sourceZoneDigest: preview.operation.rollback.sourceZoneDigest,
      appliedZoneDigest: preview.operation.rollback.appliedZoneDigest,
      confirmation: preview.confirmation,
    });
    return rollbackEvidence(completed, request);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteMailDnsProvisioningInternals = Object.freeze({
  intent,
  validateChildOperation,
  evidence,
  rollbackEvidence,
});
