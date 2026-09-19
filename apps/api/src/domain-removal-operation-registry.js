import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const OPERATION_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'removed']);
const STEP_STATUSES = new Set(['pending', 'running', 'blocked', 'failed', 'succeeded']);
const STEP_KINDS = new Set([
  'routing_suspend',
  'child_domain',
  'certificate',
  'mail_domain',
  'external_dns_zone',
  'website_binding',
  'authoritative_dns',
  'metadata_finalization',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SAFE_CODE = /^[a-z0-9_]{1,120}$/;
const CERTIFICATE_STATES = new Set([
  'pending', 'validating', 'validated', 'issuing', 'active', 'renewing', 'superseded',
  'error',
]);
const CERTIFICATE_SOURCES = new Set(['acme', 'custom']);
const CERTIFICATE_RENEWAL_MODES = new Set(['automatic', 'manual']);
const MAIL_MANAGEMENT_MODES = new Set(['local', 'external']);
const LOCAL_MAIL_STATUSES = new Set(['disabled', 'enabled']);
const EXTERNAL_MAIL_STATUSES = new Set(['unverified', 'ready', 'degraded']);

export class DomainRemovalOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  return new DomainRemovalOperationRegistryError(
    'domain_removal_operation_state_invalid',
    message,
    409,
  );
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw invalid('Domain removal operation timestamp is invalid');
  }
  return value;
}

function safeError(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || Object.keys(value).some((field) => !['code', 'message'].includes(field))
    || typeof value.code !== 'string' || !SAFE_CODE.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw invalid('Domain removal operation error evidence is invalid');
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function stepResult(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || Object.keys(value).some((field) => !['referenceId', 'evidenceDigest'].includes(field))
    || (value.referenceId !== null
      && (typeof value.referenceId !== 'string' || !SAFE_ID.test(value.referenceId)))
    || (value.evidenceDigest !== null
      && (typeof value.evidenceDigest !== 'string' || !SHA256_PATTERN.test(value.evidenceDigest)))) {
    throw invalid('Domain removal step result evidence is invalid');
  }
  return Object.freeze({
    referenceId: value.referenceId,
    evidenceDigest: value.evidenceDigest,
  });
}

function persistedStep(value) {
  const fields = new Set([
    'id', 'kind', 'resourceId', 'status', 'result', 'error', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !STEP_KINDS.has(value.kind)
    || !STEP_STATUSES.has(value.status)) {
    throw invalid('Domain removal step state is invalid');
  }
  const result = stepResult(value.result);
  const error = safeError(value.error);
  if ((value.status === 'succeeded') !== (result !== null)
    || (!['blocked', 'failed'].includes(value.status) && error !== null)
    || (['blocked', 'failed'].includes(value.status) && error === null)) {
    throw invalid('Domain removal step evidence does not match lifecycle state');
  }
  return Object.freeze({
    id: safeId(value.id, 'stepId'),
    kind: value.kind,
    resourceId: safeId(value.resourceId, 'stepResourceId'),
    status: value.status,
    result,
    error,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function normalizedAuthoritativeDns(value, { allowLegacy = true } = {}) {
  if (value === null || value === undefined) return null;
  const legacyDnsFields = new Set(['state', 'previewDigest', 'zoneSnapshotDigest', 'blockers']);
  const dnsFields = new Set([
    ...legacyDnsFields, 'ownershipEvidenceDigest', 'snapshotRetentionDays',
  ]);
  const keys = Object.keys(value ?? {});
  const legacyShape = allowLegacy
    && keys.length === legacyDnsFields.size
    && keys.every((field) => legacyDnsFields.has(field));
  const currentShape = keys.length === dnsFields.size
    && keys.every((field) => dnsFields.has(field));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (!legacyShape && !currentShape)
    || !['ready', 'blocked', 'not_applicable'].includes(value.state)
    || !Array.isArray(value.blockers) || value.blockers.length > 32
    || value.blockers.some((code) => typeof code !== 'string' || !SAFE_CODE.test(code))
    || (currentShape && value.ownershipEvidenceDigest !== null
      && (typeof value.ownershipEvidenceDigest !== 'string'
        || !SHA256_PATTERN.test(value.ownershipEvidenceDigest)))
    || (currentShape && value.snapshotRetentionDays !== null
      && (!Number.isSafeInteger(value.snapshotRetentionDays)
        || value.snapshotRetentionDays < 1 || value.snapshotRetentionDays > 3650))
    || (currentShape && value.zoneSnapshotDigest === null
      && (value.ownershipEvidenceDigest !== null || value.snapshotRetentionDays !== null))) {
    throw invalid('Authoritative DNS removal plan is invalid');
  }
  const blockers = [...value.blockers].sort();
  if (new Set(blockers).size !== blockers.length) {
    throw invalid('Authoritative DNS removal plan has duplicate blockers');
  }
  return Object.freeze({
    state: value.state,
    previewDigest: safeDigest(value.previewDigest, 'authoritativeDnsPreviewDigest'),
    zoneSnapshotDigest: value.zoneSnapshotDigest === null
      ? null
      : safeDigest(value.zoneSnapshotDigest, 'authoritativeDnsZoneSnapshotDigest'),
    ownershipEvidenceDigest: currentShape ? value.ownershipEvidenceDigest : null,
    snapshotRetentionDays: currentShape ? value.snapshotRetentionDays : null,
    blockers: Object.freeze(blockers),
  });
}

function normalizedPlan(value) {
  const legacyFields = new Set([
    'childDomainIds', 'websiteId', 'applicationId', 'managedComposeProjectId',
    'certificateIds', 'dnsZoneIds', 'mailDomainIds', 'activeJobIds',
    'additional', 'authoritativeDns',
  ]);
  const priorFields = new Set([...legacyFields, 'childDomains']);
  const certificateFields = new Set([...priorFields, 'certificateIntents', 'boundCertificateId']);
  const fields = new Set([...certificateFields, 'mailDomainIntents']);
  const planKeys = Object.keys(value ?? {});
  const legacyShape = planKeys.length === legacyFields.size
    && planKeys.every((field) => legacyFields.has(field));
  const priorShape = planKeys.length === priorFields.size
    && planKeys.every((field) => priorFields.has(field));
  const certificateShape = planKeys.length === certificateFields.size
    && planKeys.every((field) => certificateFields.has(field));
  const currentShape = planKeys.length === fields.size
    && planKeys.every((field) => fields.has(field));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (!legacyShape && !priorShape && !certificateShape && !currentShape)) {
    throw invalid('Domain removal operation plan is invalid');
  }
  const ids = (items, field, { preserveOrder = false } = {}) => {
    if (!Array.isArray(items) || items.length > 500) throw invalid(`${field} plan is invalid`);
    const normalized = items.map((item) => safeId(item, field));
    if (new Set(normalized).size !== normalized.length) throw invalid(`${field} plan has duplicates`);
    if (!preserveOrder) normalized.sort();
    return Object.freeze(normalized);
  };
  const optionalId = (item, field) => item === null || item === undefined
    ? null
    : safeId(item, field);
  const childDomainIds = ids(value.childDomainIds, 'childDomainId', { preserveOrder: true });
  const certificateIds = ids(value.certificateIds, 'certificateId');
  const normalizedChildDomains = (items) => {
    if (legacyShape || items === null) return null;
    if (!Array.isArray(items) || items.length !== childDomainIds.length) {
      throw invalid('Child Domain intent evidence is invalid');
    }
    const legacyChildFields = new Set([
      'id', 'serverId', 'primaryDomain', 'websiteId', 'certificateId', 'parentDomainId',
      'state', 'desiredRevision', 'checksum', 'suspensionOperationId',
    ]);
    const childFields = new Set([...legacyChildFields, 'authoritativeDns']);
    const snapshots = items.map((item, index) => {
      const keys = Object.keys(item ?? {});
      const legacyChildShape = keys.length === legacyChildFields.size
        && keys.every((field) => legacyChildFields.has(field));
      const currentChildShape = keys.length === childFields.size
        && keys.every((field) => childFields.has(field));
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || (!legacyChildShape && !currentChildShape)
        || item.id !== childDomainIds[index]
        || typeof item.primaryDomain !== 'string' || item.primaryDomain.length < 1
        || item.primaryDomain.length > 253 || /[\u0000-\u001f\u007f]/.test(item.primaryDomain)
        || !['active', 'suspended'].includes(item.state)
        || !Number.isSafeInteger(item.desiredRevision) || item.desiredRevision < 1
        || (item.state === 'active' && item.suspensionOperationId !== null)
        || (item.state === 'suspended' && (typeof item.suspensionOperationId !== 'string'
          || !SAFE_ID.test(item.suspensionOperationId)))) {
        throw invalid('Child Domain intent evidence is invalid');
      }
      return Object.freeze({
        id: safeId(item.id, 'childDomainId'),
        serverId: safeId(item.serverId, 'childDomainServerId'),
        primaryDomain: item.primaryDomain,
        websiteId: optionalId(item.websiteId, 'childDomainWebsiteId'),
        certificateId: optionalId(item.certificateId, 'childDomainCertificateId'),
        parentDomainId: safeId(item.parentDomainId, 'childDomainParentId'),
        state: item.state,
        desiredRevision: item.desiredRevision,
        checksum: safeDigest(item.checksum, 'childDomainChecksum'),
        suspensionOperationId: item.suspensionOperationId,
        authoritativeDns: currentChildShape
          ? normalizedAuthoritativeDns(item.authoritativeDns, { allowLegacy: false })
          : null,
      });
    });
    const childIds = new Set(childDomainIds);
    const indexes = new Map(childDomainIds.map((id, index) => [id, index]));
    const externalParents = new Set();
    const servers = new Set(snapshots.map((item) => item.serverId));
    for (const [index, snapshot] of snapshots.entries()) {
      if (childIds.has(snapshot.parentDomainId)) {
        if (indexes.get(snapshot.parentDomainId) <= index) {
          throw invalid('Child Domain intent evidence is not ordered deepest-first');
        }
      } else {
        externalParents.add(snapshot.parentDomainId);
      }
    }
    if (servers.size > 1 || (snapshots.length > 0 && externalParents.size !== 1)) {
      throw invalid('Child Domain intent hierarchy is invalid');
    }
    return Object.freeze(snapshots);
  };
  const childDomains = normalizedChildDomains(value.childDomains);
  const normalizedCertificateIntents = (items) => {
    if ((!certificateShape && !currentShape) || items === null) return null;
    if (!Array.isArray(items) || items.length !== certificateIds.length) {
      throw invalid('Certificate removal intent evidence is invalid');
    }
    const certificateFields = new Set([
      'id', 'domainId', 'serverId', 'state', 'source', 'renewalMode', 'staging', 'validTo',
      'updatedAt', 'retirementOperationId', 'retiredAt', 'retiredFromState',
    ]);
    const intents = items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).length !== certificateFields.size
        || Object.keys(item).some((field) => !certificateFields.has(field))
        || item.id !== certificateIds[index]
        || !CERTIFICATE_STATES.has(item.state)
        || !CERTIFICATE_SOURCES.has(item.source)
        || !CERTIFICATE_RENEWAL_MODES.has(item.renewalMode)
        || (item.source === 'acme' && item.renewalMode !== 'automatic')
        || (item.source === 'custom' && item.renewalMode !== 'manual')
        || typeof item.staging !== 'boolean') {
        throw invalid('Certificate removal intent evidence is invalid');
      }
      const intent = {
        id: safeId(item.id, 'certificateId'),
        domainId: safeId(item.domainId, 'certificateDomainId'),
        serverId: safeId(item.serverId, 'certificateServerId'),
        state: item.state,
        source: item.source,
        renewalMode: item.renewalMode,
        staging: item.staging,
        validTo: item.validTo === null ? null : timestamp(item.validTo),
        updatedAt: timestamp(item.updatedAt),
        retirementOperationId: item.retirementOperationId === null
          ? null
          : safeId(item.retirementOperationId, 'certificateRetirementOperationId'),
        retiredAt: item.retiredAt === null ? null : timestamp(item.retiredAt),
        retiredFromState: item.retiredFromState,
      };
      const retired = intent.state === 'retired';
      if (retired !== (intent.retirementOperationId !== null
        && intent.retiredAt !== null
        && CERTIFICATE_STATES.has(intent.retiredFromState)
        && intent.retiredFromState !== 'retired')
        || (!retired && (intent.retirementOperationId !== null
          || intent.retiredAt !== null || intent.retiredFromState !== null))) {
        throw invalid('Certificate removal retirement evidence is invalid');
      }
      return Object.freeze(intent);
    });
    return Object.freeze(intents);
  };
  const certificateIntents = normalizedCertificateIntents(value.certificateIntents);
  const boundCertificateId = certificateShape || currentShape
    ? optionalId(value.boundCertificateId, 'boundCertificateId')
    : null;
  if ((certificateShape || currentShape) && boundCertificateId !== null
    && !certificateIds.includes(boundCertificateId)) {
    throw invalid('Bound certificate removal intent is missing');
  }
  const mailDomainIds = ids(value.mailDomainIds, 'mailDomainId');
  const normalizedMailDomainIntents = (items) => {
    if (!currentShape || items === null) return null;
    if (!Array.isArray(items) || items.length !== mailDomainIds.length) {
      throw invalid('Mail Domain removal intent evidence is invalid');
    }
    const intentFields = new Set([
      'id', 'domainName', 'webDomainId', 'managementMode', 'status', 'revision', 'updatedAt',
    ]);
    const intents = items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).length !== intentFields.size
        || Object.keys(item).some((field) => !intentFields.has(field))
        || item.id !== mailDomainIds[index]
        || typeof item.domainName !== 'string' || item.domainName.length < 1
        || item.domainName.length > 253 || /[\u0000-\u001f\u007f]/.test(item.domainName)
        || !MAIL_MANAGEMENT_MODES.has(item.managementMode)
        || (item.managementMode === 'local' && !LOCAL_MAIL_STATUSES.has(item.status))
        || (item.managementMode === 'external' && !EXTERNAL_MAIL_STATUSES.has(item.status))
        || !Number.isSafeInteger(item.revision) || item.revision < 1) {
        throw invalid('Mail Domain removal intent evidence is invalid');
      }
      return Object.freeze({
        id: safeId(item.id, 'mailDomainId'),
        domainName: item.domainName,
        webDomainId: safeId(item.webDomainId, 'mailDomainWebDomainId'),
        managementMode: item.managementMode,
        status: item.status,
        revision: item.revision,
        updatedAt: timestamp(item.updatedAt),
      });
    });
    if (new Set(intents.map((intent) => intent.webDomainId)).size !== intents.length) {
      throw invalid('Mail Domain removal intent contains duplicate Domain bindings');
    }
    return Object.freeze(intents);
  };
  const mailDomainIntents = normalizedMailDomainIntents(value.mailDomainIntents);
  const normalizedAdditional = (additional) => {
    const additionalFields = new Set(['mailboxes', 'backups', 'crons', 'dockerWorkloads']);
    if (!additional || typeof additional !== 'object' || Array.isArray(additional)
      || Object.keys(additional).length !== additionalFields.size
      || Object.keys(additional).some((field) => !additionalFields.has(field))) {
      throw invalid('Domain removal additional dependency plan is invalid');
    }
    const bucket = (entry, field) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).length !== 2
        || Object.keys(entry).some((key) => !['status', 'ids'].includes(key))
        || !['available', 'unavailable'].includes(entry.status)) {
        throw invalid(`${field} dependency plan is invalid`);
      }
      return Object.freeze({ status: entry.status, ids: ids(entry.ids, `${field}Id`) });
    };
    return Object.freeze({
      mailboxes: bucket(additional.mailboxes, 'mailbox'),
      backups: bucket(additional.backups, 'backup'),
      crons: bucket(additional.crons, 'cron'),
      dockerWorkloads: bucket(additional.dockerWorkloads, 'docker'),
    });
  };
  const authoritativeDns = normalizedAuthoritativeDns(value.authoritativeDns);
  return Object.freeze({
    childDomainIds,
    childDomains,
    websiteId: optionalId(value.websiteId, 'websiteId'),
    applicationId: optionalId(value.applicationId, 'applicationId'),
    managedComposeProjectId: optionalId(value.managedComposeProjectId, 'managedComposeProjectId'),
    certificateIds,
    certificateIntents,
    boundCertificateId,
    dnsZoneIds: ids(value.dnsZoneIds, 'dnsZoneId'),
    mailDomainIds,
    mailDomainIntents,
    activeJobIds: ids(value.activeJobIds, 'activeJobId'),
    additional: normalizedAdditional(value.additional),
    authoritativeDns,
  });
}
function buildSteps(preview, createdAt) {
  const plan = normalizedPlan(preview.plan);
  if (plan.childDomains === null) {
    throw invalid('Domain removal preview lacks exact child Domain intent evidence');
  }
  if (plan.childDomains.some((child) => child.authoritativeDns === null)) {
    throw invalid('Domain removal preview lacks exact child authoritative DNS intent evidence');
  }
  if (plan.certificateIntents === null) {
    throw invalid('Domain removal preview lacks exact certificate retirement intent evidence');
  }
  if (plan.mailDomainIntents === null) {
    throw invalid('Domain removal preview lacks exact Mail Domain removal intent evidence');
  }
  if ((preview.domain.certificateId ?? null) !== plan.boundCertificateId) {
    throw invalid('Domain removal preview certificate binding intent is inconsistent');
  }
  const affectedDomainIds = new Set([preview.domain.id, ...plan.childDomainIds]);
  if (plan.certificateIntents.some((certificate) => (
    certificate.serverId !== preview.domain.serverId
    || !affectedDomainIds.has(certificate.domainId)
  ))) {
    throw invalid('Certificate removal intent crosses the Domain removal boundary');
  }
  if (plan.boundCertificateId !== null
    && !plan.certificateIntents.some((certificate) => (
      certificate.id === plan.boundCertificateId && certificate.domainId === preview.domain.id
    ))) {
    throw invalid('Bound certificate removal intent does not match the root Domain');
  }
  const affectedDomains = new Map([
    [preview.domain.id, preview.domain.primaryDomain],
    ...plan.childDomains.map((child) => [child.id, child.primaryDomain]),
  ]);
  if (plan.mailDomainIntents.some((mailDomain) => (
    mailDomain.domainName !== affectedDomains.get(mailDomain.webDomainId)
  ))) {
    throw invalid('Mail Domain removal intent crosses the Domain removal boundary');
  }
  const steps = [];
  const add = (kind, resourceId) => {
    steps.push(persistedStep({
      id: `${String(steps.length + 1).padStart(3, '0')}:${kind}:${resourceId}`,
      kind,
      resourceId,
      status: 'pending',
      result: null,
      error: null,
      createdAt,
      updatedAt: createdAt,
    }));
  };
  add('routing_suspend', preview.domain.id);
  for (const id of plan.childDomainIds) add('child_domain', id);
  for (const certificate of plan.certificateIntents) {
    if (certificate.domainId === preview.domain.id) add('certificate', certificate.id);
  }
  for (const mailDomain of plan.mailDomainIntents) {
    if (mailDomain.webDomainId === preview.domain.id) add('mail_domain', mailDomain.id);
  }
  for (const id of plan.dnsZoneIds) add('external_dns_zone', id);
  if (plan.websiteId !== null) add('website_binding', plan.websiteId);
  if (plan.authoritativeDns !== null && plan.authoritativeDns.zoneSnapshotDigest !== null) {
    add('authoritative_dns', preview.domain.id);
  }
  add('metadata_finalization', preview.domain.id);
  return Object.freeze({ plan, steps: Object.freeze(steps) });
}

function persistedOperation(value) {
  const legacyFields = new Set([
    'id', 'domainId', 'serverId', 'primaryDomain', 'domainRevision', 'checksum',
    'sourceSuspensionOperationId', 'impactPreviewDigest', 'impactConfirmation',
    'previewDigest', 'startConfirmation', 'plan', 'status', 'steps', 'error',
    'createdAt', 'updatedAt',
  ]);
  const fields = new Set([...legacyFields, 'parentOperationId']);
  const keys = Object.keys(value ?? {});
  const legacyShape = keys.length === legacyFields.size
    && keys.every((field) => legacyFields.has(field));
  const currentShape = keys.length === fields.size
    && keys.every((field) => fields.has(field));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (!legacyShape && !currentShape)
    || !OPERATION_STATUSES.has(value.status)
    || typeof value.primaryDomain !== 'string' || value.primaryDomain.length < 1
    || value.primaryDomain.length > 253 || /[\u0000-\u001f\u007f]/.test(value.primaryDomain)
    || !Number.isSafeInteger(value.domainRevision) || value.domainRevision < 1
    || (value.sourceSuspensionOperationId !== null
      && (typeof value.sourceSuspensionOperationId !== 'string'
        || !SAFE_ID.test(value.sourceSuspensionOperationId)))
    || typeof value.impactConfirmation !== 'string' || value.impactConfirmation.length < 1
    || value.impactConfirmation.length > 1000
    || typeof value.startConfirmation !== 'string' || value.startConfirmation.length < 1
    || value.startConfirmation.length > 1000
    || !Array.isArray(value.steps) || value.steps.length < 2 || value.steps.length > 2000) {
    throw invalid('Domain removal operation state is invalid');
  }
  const operation = Object.freeze({
    id: safeId(value.id, 'operationId'),
    parentOperationId: currentShape && value.parentOperationId !== null
      ? safeId(value.parentOperationId, 'parentOperationId')
      : null,
    domainId: safeId(value.domainId, 'domainId'),
    serverId: safeId(value.serverId, 'serverId'),
    primaryDomain: value.primaryDomain,
    domainRevision: value.domainRevision,
    checksum: safeDigest(value.checksum, 'checksum'),
    sourceSuspensionOperationId: value.sourceSuspensionOperationId,
    impactPreviewDigest: safeDigest(value.impactPreviewDigest, 'impactPreviewDigest'),
    impactConfirmation: value.impactConfirmation,
    previewDigest: safeDigest(value.previewDigest, 'previewDigest'),
    startConfirmation: value.startConfirmation,
    plan: normalizedPlan(value.plan),
    status: value.status,
    steps: Object.freeze(value.steps.map(persistedStep)),
    error: safeError(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
  if (new Set(operation.steps.map((step) => step.id)).size !== operation.steps.length) {
    throw invalid('Domain removal step IDs are not unique');
  }
  if (operation.parentOperationId === operation.id) {
    throw invalid('Domain removal operation cannot own itself');
  }
  const unfinished = operation.steps.filter((step) => step.status !== 'succeeded');
  if (operation.status === 'removed' && unfinished.length > 0) {
    throw invalid('Removed Domain operation has unfinished steps');
  }
  if (operation.status === 'pending'
    && operation.steps.some((step) => step.status !== 'pending')) {
    throw invalid('Pending Domain removal operation contains started steps');
  }
  if ((operation.status === 'failed') !== (operation.error !== null)) {
    throw invalid('Domain removal operation error does not match lifecycle state');
  }
  if (operation.status === 'blocked' && !operation.steps.some((step) => step.status === 'blocked')) {
    throw invalid('Blocked Domain removal operation has no blocked step');
  }
  return operation;
}

function operationFromPreview(preview, now, idFactory, parentOperationId = null) {
  if (!preview || preview.version !== 1 || preview.operation !== 'domain_remove'
    || preview.readyToStart !== true || !Array.isArray(preview.hardBlockers)
    || preview.hardBlockers.length !== 0
    || !preview.domain || typeof preview.domain !== 'object' || Array.isArray(preview.domain)
    || typeof preview.domain.primaryDomain !== 'string'
    || !Number.isSafeInteger(preview.domain.desiredRevision) || preview.domain.desiredRevision < 1
    || typeof preview.confirmation !== 'string' || !preview.confirmation) {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_preview_invalid',
      'Domain removal preview cannot be journaled',
      409,
    );
  }
  const createdAtMs = now();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_clock_invalid',
      'Domain removal operation registry clock is invalid',
      503,
    );
  }
  const createdAt = new Date(createdAtMs).toISOString();
  const { plan, steps } = buildSteps(preview, createdAt);
  return persistedOperation({
    id: idFactory(),
    parentOperationId,
    domainId: preview.domain.id,
    serverId: preview.domain.serverId,
    primaryDomain: preview.domain.primaryDomain,
    domainRevision: preview.domain.desiredRevision,
    checksum: preview.domain.checksum,
    sourceSuspensionOperationId: preview.domain.suspensionOperationId ?? null,
    impactPreviewDigest: preview.impact.previewDigest,
    impactConfirmation: preview.impact.confirmation,
    previewDigest: preview.previewDigest,
    startConfirmation: preview.confirmation,
    plan,
    status: 'pending',
    steps,
    error: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export function domainRemovalOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    parentOperationId: operation.parentOperationId,
    domainId: operation.domainId,
    serverId: operation.serverId,
    primaryDomain: operation.primaryDomain,
    domainRevision: operation.domainRevision,
    checksum: operation.checksum,
    sourceSuspensionOperationId: operation.sourceSuspensionOperationId,
    impactPreviewDigest: operation.impactPreviewDigest,
    previewDigest: operation.previewDigest,
    status: operation.status,
    plan: operation.plan,
    steps: operation.steps,
    error: operation.error,
    recovery: Object.freeze({
      required: operation.steps.some((step) => step.status === 'running'),
      automaticMutationReplayBlocked: operation.steps.some((step) => step.status === 'running'),
    }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

export function createDomainRemovalOperationRegistry({
  filePath = null,
  now = () => Date.now(),
  idFactory = randomUUID,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new DomainRemovalOperationRegistryError(
      'domain_removal_operation_dependencies_invalid',
      'Domain removal operation registry dependencies are invalid',
      503,
    );
  }
  let state = { version: STORE_VERSION, operations: [] };
  let initialized = filePath === null;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const content = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    });
    await writeChain;
  }

  async function init() {
    if (initialized) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.operations)
        || Object.keys(parsed).length !== 2
        || Object.keys(parsed).some((field) => !['version', 'operations'].includes(field))) {
        throw invalid('Domain removal operation store is invalid');
      }
      const operations = parsed.operations.map(persistedOperation);
      if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
        throw invalid('Domain removal operation IDs are not unique');
      }
      const byId = new Map(operations.map((operation) => [operation.id, operation]));
      for (const operation of operations) {
        if (operation.parentOperationId === null) continue;
        const parent = byId.get(operation.parentOperationId);
        if (!parent || parent.domainId === operation.domainId
          || Date.parse(parent.createdAt) > Date.parse(operation.createdAt)) {
          throw invalid('Domain removal parent operation reference is invalid');
        }
      }
      state = { version: STORE_VERSION, operations };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await persist();
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function create(preview, { parentOperationId = null } = {}) {
    await ensureInitialized();
    const normalizedParentOperationId = parentOperationId === null
      ? null
      : safeId(parentOperationId, 'parentOperationId');
    if (normalizedParentOperationId !== null) {
      const parent = state.operations.find((operation) => operation.id === normalizedParentOperationId);
      if (!parent || parent.status === 'removed' || parent.domainId === preview?.domain?.id) {
        throw new DomainRemovalOperationRegistryError(
          'domain_removal_parent_operation_invalid',
          'Child Domain removal requires one active parent operation',
          409,
        );
      }
    }
    const duplicate = state.operations.find((operation) => (
      operation.domainId === preview?.domain?.id
      && operation.domainRevision === preview?.domain?.desiredRevision
      && operation.previewDigest === preview?.previewDigest
      && operation.parentOperationId === normalizedParentOperationId
      && operation.status !== 'removed'
    ));
    if (duplicate) return duplicate;
    const conflict = state.operations.find((operation) => (
      operation.domainId === preview?.domain?.id && operation.status !== 'removed'
    ));
    if (conflict) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_conflict',
        'Another Domain removal operation already owns this Domain',
        409,
      );
    }
    const operation = operationFromPreview(
      preview,
      now,
      idFactory,
      normalizedParentOperationId,
    );
    if (state.operations.some((candidate) => candidate.id === operation.id)) {
      throw invalid('Domain removal operation ID is not unique');
    }
    state.operations.push(operation);
    await persist();
    return operation;
  }

  async function get(operationId) {
    await ensureInitialized();
    const id = safeId(operationId, 'operationId');
    return state.operations.find((operation) => operation.id === id) ?? null;
  }

  async function listForDomain(domainId) {
    await ensureInitialized();
    const id = safeId(domainId, 'domainId');
    return Object.freeze(state.operations
      .filter((operation) => operation.domainId === id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async function listInterrupted() {
    await ensureInitialized();
    return Object.freeze(state.operations.filter((operation) => (
      operation.steps.some((step) => step.status === 'running')
    )));
  }

  async function mutate(operation, update) {
    const index = state.operations.findIndex((candidate) => candidate.id === operation.id);
    if (index < 0) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const currentMs = now();
    if (!Number.isSafeInteger(currentMs) || currentMs < 0) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_clock_invalid',
        'Domain removal operation registry clock is invalid',
        503,
      );
    }
    const updatedAt = new Date(Math.max(currentMs, Date.parse(operation.updatedAt) + 1)).toISOString();
    const next = persistedOperation({ ...operation, ...update, updatedAt });
    state.operations[index] = next;
    await persist();
    return next;
  }

  function requireOperation(operation) {
    if (!operation) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    return operation;
  }

  function firstIncomplete(operation) {
    return operation.steps.find((step) => step.status !== 'succeeded') ?? null;
  }

  async function markStepRunning(operationId, stepId) {
    const operation = requireOperation(await get(operationId));
    if (operation.status === 'removed') {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_operation_not_runnable',
        'Domain removal operation cannot run from its current state',
        409,
      );
    }
    const expected = firstIncomplete(operation);
    if (!expected || expected.id !== stepId) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_out_of_order',
        'Domain removal steps must execute in journaled order',
        409,
      );
    }
    if (expected.status === 'running') return operation;
    if (!['pending', 'blocked', 'failed'].includes(expected.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_runnable',
        'Domain removal step cannot run from its current state',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(expected.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((step) => step.id === stepId
      ? persistedStep({ ...step, status: 'running', result: null, error: null, updatedAt: changedAt })
      : step);
    return mutate(operation, { status: 'running', steps, error: null });
  }

  async function succeedStep(operationId, stepId, result = {}) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    const normalizedResult = stepResult({
      referenceId: result.referenceId ?? null,
      evidenceDigest: result.evidenceDigest ?? null,
    });
    if (step.status === 'succeeded') {
      if (JSON.stringify(step.result) !== JSON.stringify(normalizedResult)) {
        throw new DomainRemovalOperationRegistryError(
          'domain_removal_step_result_conflict',
          'Domain removal step already completed with different evidence',
          409,
        );
      }
      return operation;
    }
    if (step.status !== 'running') {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_running',
        'Domain removal step is not running',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'succeeded',
        result: normalizedResult,
        error: null,
        updatedAt: changedAt,
      })
      : candidate);
    const removed = steps.every((candidate) => candidate.status === 'succeeded');
    return mutate(operation, {
      status: removed ? 'removed' : 'running',
      steps,
      error: null,
    });
  }

  async function blockStep(operationId, stepId, error) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    if (!['pending', 'running', 'blocked'].includes(step.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_blockable',
        'Domain removal step cannot be blocked from its current state',
        409,
      );
    }
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'blocked',
        result: null,
        error: safeError(error),
        updatedAt: changedAt,
      })
      : candidate);
    return mutate(operation, { status: 'blocked', steps, error: null });
  }

  async function failStep(operationId, stepId, error) {
    const operation = requireOperation(await get(operationId));
    const step = operation.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_found',
        'Domain removal step was not found',
        404,
      );
    }
    if (!['pending', 'running', 'blocked', 'failed'].includes(step.status)) {
      throw new DomainRemovalOperationRegistryError(
        'domain_removal_step_not_mutable',
        'Domain removal step cannot fail from its current state',
        409,
      );
    }
    const failure = safeError(error);
    const changedAt = new Date(Math.max(now(), Date.parse(step.updatedAt) + 1)).toISOString();
    const steps = operation.steps.map((candidate) => candidate.id === stepId
      ? persistedStep({
        ...candidate,
        status: 'failed',
        result: null,
        error: failure,
        updatedAt: changedAt,
      })
      : candidate);
    return mutate(operation, { status: 'failed', steps, error: failure });
  }

  return Object.freeze({
    init,
    create,
    get,
    listForDomain,
    listInterrupted,
    markStepRunning,
    succeedStep,
    blockStep,
    failStep,
  });
}

export const domainRemovalOperationRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  operationStatuses: Object.freeze([...OPERATION_STATUSES]),
  stepStatuses: Object.freeze([...STEP_STATUSES]),
  stepKinds: Object.freeze([...STEP_KINDS]),
  safeError,
  stepResult,
  persistedStep,
  normalizedPlan,
  buildSteps,
  persistedOperation,
  operationFromPreview,
});
