import { createHash } from 'node:crypto';

import {
  domainRemovalOperationPublicView,
  DomainRemovalOperationRegistryError,
} from './domain-removal-operation-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTING_CHILD_STATUSES = new Set(['pending', 'suspending', 'suspended', 'failed']);
const CONTINUABLE_STEP_KINDS = new Set([
  'child_domain', 'certificate', 'mail_domain', 'external_dns_zone', 'website_binding',
  'authoritative_dns', 'metadata_finalization',
]);
const DNS_RETIREMENT_CHILD_STATUSES = new Set(['pending', 'deleting', 'deleted', 'failed']);
const MAIL_REMOVAL_CHILD_STATUSES = new Set([
  'pending', 'disabling', 'cleaning', 'backing_up', 'deleting_data', 'finalizing',
  'blocked', 'failed', 'removed',
]);
const SAFE_REFERENCE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;

export class DomainRemovalRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeFailure(error, fallbackCode = 'domain_removal_failed', fallbackMessage = 'Domain removal failed') {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0 && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function mapped(error) {
  if (error instanceof DomainRemovalRuntimeError) return error;
  if (error instanceof DomainRemovalOperationRegistryError) {
    return new DomainRemovalRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function routingRetryConfirmation(operation) {
  return `retry-domain-remove-routing:${operation.domainId}:${operation.id}:${operation.updatedAt}:${operation.checksum}`;
}

function stepContinuationConfirmation(operation, step) {
  return `continue-domain-remove-step:${operation.domainId}:${operation.id}:${step.id}:${operation.updatedAt}:${operation.checksum}`;
}

function firstIncomplete(operation) {
  return operation.steps.find((step) => step.status !== 'succeeded') ?? null;
}

function publicOperation(operation) {
  if (!operation) return null;
  const base = domainRemovalOperationPublicView(operation);
  const step = firstIncomplete(operation);
  const routingRetryable = step?.kind === 'routing_suspend'
    && ['running', 'blocked', 'failed'].includes(step.status)
    && operation.status !== 'removed';
  const stepContinuable = step && CONTINUABLE_STEP_KINDS.has(step.kind)
    && ['pending', 'running', 'blocked', 'failed'].includes(step.status)
    && operation.status !== 'removed';
  return Object.freeze({
    ...base,
    actions: Object.freeze({
      routingRetryConfirmation: routingRetryable
        ? routingRetryConfirmation(operation)
        : null,
      stepContinuationConfirmation: stepContinuable
        ? stepContinuationConfirmation(operation, step)
        : null,
    }),
  });
}

function currentPreviewMatches(operation, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'domain_remove'
    && preview.readyToStart === true
    && Array.isArray(preview.hardBlockers)
    && preview.hardBlockers.length === 0
    && preview.domain?.id === operation.domainId
    && preview.domain?.serverId === operation.serverId
    && preview.domain?.primaryDomain === operation.primaryDomain
    && preview.domain?.desiredRevision === operation.domainRevision
    && preview.domain?.checksum === operation.checksum
    && (preview.domain?.suspensionOperationId ?? null) === operation.sourceSuspensionOperationId
    && preview.impact?.previewDigest === operation.impactPreviewDigest
    && preview.previewDigest === operation.previewDigest
    && preview.confirmation === operation.startConfirmation);
}

function exactSuspensionChild(operation, child) {
  return Boolean(child
    && child.domainId === operation.domainId
    && child.serverId === operation.serverId
    && child.primaryDomain === operation.primaryDomain
    && child.domainRevision === operation.domainRevision
    && child.checksum === operation.checksum);
}

function completedSuspensionEvidence(operation, child) {
  if (!exactSuspensionChild(operation, child)
    || child.status !== 'suspended'
    || child.suspendResult?.suspended !== true
    || typeof child.suspendResult?.suspendedAt !== 'string') {
    throw new DomainRemovalRuntimeError(
      'domain_removal_routing_evidence_invalid',
      'Domain suspension child operation did not prove the exact removed routing state',
      409,
    );
  }
  const evidenceDigest = digest({
    operationId: child.id,
    domainId: child.domainId,
    serverId: child.serverId,
    primaryDomain: child.primaryDomain,
    domainRevision: child.domainRevision,
    checksum: child.checksum,
    status: child.status,
    suspendedAt: child.suspendResult.suspendedAt,
  });
  return Object.freeze({
    referenceId: child.id,
    evidenceDigest,
  });
}

function suspensionOperationId(operation) {
  const routing = operation.steps.find((step) => step.kind === 'routing_suspend');
  if (routing?.status !== 'succeeded' || typeof routing.result?.referenceId !== 'string') {
    throw new DomainRemovalRuntimeError(
      'domain_removal_routing_evidence_missing',
      'Domain removal dependency mutation requires completed routing suspension evidence',
      409,
    );
  }
  return routing.result.referenceId;
}

function exactSuspendedDomain(operation, domain, expectedSuspensionOperationId) {
  return Boolean(domain
    && domain.id === operation.domainId
    && domain.serverId === operation.serverId
    && domain.primaryDomain === operation.primaryDomain
    && domain.state === 'suspended'
    && domain.desiredRevision === operation.domainRevision
    && domain.stagedRevision === operation.domainRevision
    && domain.appliedRevision === operation.domainRevision
    && domain.stagedChecksum === operation.checksum
    && domain.suspendedChecksum === operation.checksum
    && domain.suspensionOperationId === expectedSuspensionOperationId
    && domain.appliedPrimaryDomain === operation.primaryDomain
    && domain.lastError === null);
}

function websiteBindingEvidence(operation, websiteId, suspensionId) {
  return Object.freeze({
    referenceId: websiteId,
    evidenceDigest: digest({
      kind: 'website_binding',
      domainId: operation.domainId,
      websiteId,
      domainRevision: operation.domainRevision,
      checksum: operation.checksum,
      suspensionOperationId: suspensionId,
      detached: true,
    }),
  });
}

function certificateRetirementEvidence(operation, intent, certificate, suspensionId) {
  if (!exactRetiredCertificate(operation, intent, certificate)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_certificate_evidence_invalid',
      'Certificate retirement did not prove exact operation-owned state',
      409,
    );
  }
  return Object.freeze({
    referenceId: intent.id,
    evidenceDigest: digest({
      kind: 'certificate',
      operationId: operation.id,
      domainId: operation.domainId,
      serverId: operation.serverId,
      certificateId: intent.id,
      source: intent.source,
      retiredFromState: intent.state,
      retiredAt: certificate.retiredAt,
      suspensionOperationId: suspensionId,
      bindingDetached: operation.plan.boundCertificateId === intent.id,
      materialRetained: true,
    }),
  });
}

function metadataFinalizationEvidence(operation, suspensionId) {
  return Object.freeze({
    referenceId: operation.domainId,
    evidenceDigest: digest({
      kind: 'metadata_finalization',
      domainId: operation.domainId,
      serverId: operation.serverId,
      primaryDomain: operation.primaryDomain,
      domainRevision: operation.domainRevision,
      checksum: operation.checksum,
      suspensionOperationId: suspensionId,
      removed: true,
    }),
  });
}

function metadataFinalizationConfirmation(operation, suspensionId) {
  return `finalize-domain-remove:${operation.domainId}:${suspensionId}:${operation.domainRevision}:${operation.checksum}`;
}

function exactDnsRetirementPreview(operation, preview) {
  const expected = operation.plan.authoritativeDns;
  return Boolean(expected
    && expected.zoneSnapshotDigest !== null
    && expected.ownershipEvidenceDigest !== null
    && Number.isSafeInteger(expected.snapshotRetentionDays)
    && preview?.version === 1
    && preview.operation === 'dns_zone_retirement_impact'
    && preview.retirementPlanReady === true
    && Array.isArray(preview.blockers)
    && preview.blockers.length === 0
    && typeof preview.previewDigest === 'string'
    && SHA256_PATTERN.test(preview.previewDigest)
    && typeof preview.confirmation === 'string'
    && preview.confirmation.length > 0
    && preview.domain?.id === operation.domainId
    && preview.domain?.serverId === operation.serverId
    && preview.domain?.primaryDomain === operation.primaryDomain
    && preview.domain?.desiredRevision === operation.domainRevision
    && preview.domain?.websiteId === null
    && preview.domain?.certificateId === null
    && preview.domain?.state === 'suspended'
    && preview.hierarchy?.descendantCount === 0
    && Array.isArray(preview.hierarchy?.descendants)
    && preview.hierarchy.descendants.length === 0
    && preview.routing?.active === false
    && preview.zone?.exists === true
    && preview.zone?.snapshotDigest === expected.zoneSnapshotDigest
    && preview.zone?.ownershipOrigin?.evidenceDigest === expected.ownershipEvidenceDigest
    && preview.retention?.configured === true
    && preview.retention?.snapshotRetentionDays === expected.snapshotRetentionDays);
}

function exactDnsRetirementChild(operation, child) {
  const expected = operation.plan.authoritativeDns;
  const parentCreatedAt = Date.parse(operation.createdAt);
  const childCreatedAt = Date.parse(child?.createdAt);
  return Boolean(expected
    && child
    && typeof child.id === 'string'
    && Number.isFinite(parentCreatedAt)
    && Number.isFinite(childCreatedAt)
    && childCreatedAt >= parentCreatedAt
    && child.domainId === operation.domainId
    && child.serverId === operation.serverId
    && child.zoneName === operation.primaryDomain
    && child.domainRevision === operation.domainRevision
    && child.snapshotDigest === expected.zoneSnapshotDigest
    && child.ownershipEvidenceDigest === expected.ownershipEvidenceDigest
    && child.snapshotRetentionDays === expected.snapshotRetentionDays
    && DNS_RETIREMENT_CHILD_STATUSES.has(child.status));
}

function dnsRetirementEvidence(operation, child) {
  const deletedAtMs = Date.parse(child?.result?.deletedAt);
  const retainUntilMs = Date.parse(child?.result?.retainUntil);
  if (!exactDnsRetirementChild(operation, child)
    || child.status !== 'deleted'
    || child.result?.deleted !== true
    || child.result?.snapshotDigest !== child.snapshotDigest
    || typeof child.result?.deletedAt !== 'string'
    || typeof child.result?.retainUntil !== 'string'
    || !Number.isFinite(deletedAtMs) || !Number.isFinite(retainUntilMs)
    || new Date(deletedAtMs).toISOString() !== child.result.deletedAt
    || new Date(retainUntilMs).toISOString() !== child.result.retainUntil
    || retainUntilMs - deletedAtMs !== child.snapshotRetentionDays * 24 * 60 * 60 * 1000) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_dns_evidence_invalid',
      'DNS retirement child operation did not prove exact authoritative zone deletion',
      409,
    );
  }
  return Object.freeze({
    referenceId: child.id,
    evidenceDigest: digest({
      kind: 'authoritative_dns',
      operationId: child.id,
      domainId: child.domainId,
      serverId: child.serverId,
      zoneName: child.zoneName,
      domainRevision: child.domainRevision,
      snapshotDigest: child.snapshotDigest,
      ownershipEvidenceDigest: child.ownershipEvidenceDigest,
      snapshotRetentionDays: child.snapshotRetentionDays,
      deletedAt: child.result.deletedAt,
      retainUntil: child.result.retainUntil,
    }),
  });
}

function childDomainIntent(operation, step) {
  if (!Array.isArray(operation.plan.childDomains)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_child_intent_missing',
      'Legacy Domain removal journal has no exact child Domain intent evidence',
      409,
    );
  }
  const matches = operation.plan.childDomains.filter((child) => child.id === step.resourceId);
  if (matches.length !== 1) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_child_plan_invalid',
      'Child Domain step does not match one exact journaled intent',
      409,
    );
  }
  return matches[0];
}

function idsWithin(values, allowed) {
  if (!Array.isArray(values) || !Array.isArray(allowed)) return false;
  const allowedIds = new Set(allowed);
  return values.every((value) => allowedIds.has(value));
}

function exactChildAuthoritativeDnsIntent(expected, current) {
  return Boolean(expected
    && current
    && expected.state === current.state
    && expected.previewDigest === current.previewDigest
    && expected.zoneSnapshotDigest === current.zoneSnapshotDigest
    && expected.ownershipEvidenceDigest === current.ownershipEvidenceDigest
    && expected.snapshotRetentionDays === current.snapshotRetentionDays
    && Array.isArray(expected.blockers)
    && Array.isArray(current.blockers)
    && expected.blockers.length === current.blockers.length
    && expected.blockers.every((code, index) => code === current.blockers[index]));
}

const CERTIFICATE_INTENT_FIELDS = Object.freeze([
  'id', 'domainId', 'serverId', 'state', 'source', 'renewalMode', 'staging', 'validTo',
  'updatedAt', 'retirementOperationId', 'retiredAt', 'retiredFromState',
]);

function sameCertificateIntent(expected, current) {
  return Boolean(expected && current && CERTIFICATE_INTENT_FIELDS.every((field) => (
    expected[field] === current[field]
  )));
}

function exactRetiredCertificate(operation, intent, certificate) {
  return Boolean(certificate
    && certificate.id === intent.id
    && certificate.domainId === intent.domainId
    && certificate.serverId === intent.serverId
    && certificate.source === intent.source
    && certificate.renewalMode === intent.renewalMode
    && certificate.staging === intent.staging
    && (certificate.validTo ?? null) === intent.validTo
    && certificate.state === 'retired'
    && certificate.retiredFromState === intent.state
    && certificate.retirementOperationId === operation.id
    && certificate.retiredFromUpdatedAt === intent.updatedAt
    && typeof certificate.retiredAt === 'string'
    && Number.isFinite(Date.parse(certificate.retiredAt))
    && new Date(certificate.retiredAt).toISOString() === certificate.retiredAt
    && certificate.updatedAt === certificate.retiredAt);
}

function certificateIntent(operation, step) {
  if (!Array.isArray(operation.plan.certificateIntents)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_certificate_intent_missing',
      'Legacy Domain removal journal has no exact certificate retirement intent evidence',
      409,
    );
  }
  const matches = operation.plan.certificateIntents.filter((intent) => (
    intent.id === step.resourceId && intent.domainId === operation.domainId
  ));
  if (matches.length !== 1) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_certificate_plan_invalid',
      'Certificate step does not match one exact Domain-scoped retirement intent',
      409,
    );
  }
  return matches[0];
}

function childCertificatePlanWithinParent(operation, intent, plan) {
  if (!Array.isArray(operation.plan.certificateIntents)
    || !Array.isArray(plan.certificateIntents)
    || plan.boundCertificateId !== intent.certificateId) return false;
  const expected = operation.plan.certificateIntents.filter((candidate) => (
    candidate.domainId === intent.id
  ));
  return expected.length === plan.certificateIntents.length
    && expected.every((parentIntent) => plan.certificateIntents.some((childIntent) => (
      sameCertificateIntent(parentIntent, childIntent)
    )));
}

const EXTERNAL_DNS_INTENT_FIELDS = Object.freeze([
  'id', 'zoneName', 'webDomainId', 'managementMode', 'status', 'revision', 'updatedAt',
]);

function sameExternalDnsIntent(expected, current) {
  return Boolean(expected && current && EXTERNAL_DNS_INTENT_FIELDS.every((field) => (
    expected[field] === current[field]
  )));
}

function childExternalDnsPlanWithinParent(operation, intent, plan) {
  if (!Array.isArray(operation.plan.dnsZoneIntents)
    || !Array.isArray(plan.dnsZoneIntents)) return false;
  const expected = operation.plan.dnsZoneIntents.filter((candidate) => (
    candidate.webDomainId === intent.id
  ));
  return expected.length === plan.dnsZoneIntents.length
    && expected.every((parentIntent) => plan.dnsZoneIntents.some((childIntent) => (
      sameExternalDnsIntent(parentIntent, childIntent)
    )));
}

const MAIL_DOMAIN_INTENT_FIELDS = Object.freeze([
  'id', 'domainName', 'webDomainId', 'managementMode', 'status', 'revision', 'updatedAt',
]);

function sameMailDomainIntent(expected, current) {
  return Boolean(expected && current && MAIL_DOMAIN_INTENT_FIELDS.every((field) => (
    expected[field] === current[field]
  )));
}

function childMailDomainPlanWithinParent(operation, intent, plan) {
  if (!Array.isArray(operation.plan.mailDomainIntents)
    || !Array.isArray(plan.mailDomainIntents)) return false;
  const expected = operation.plan.mailDomainIntents.filter((candidate) => (
    candidate.webDomainId === intent.id
  ));
  return expected.length === plan.mailDomainIntents.length
    && expected.every((parentIntent) => plan.mailDomainIntents.some((childIntent) => (
      sameMailDomainIntent(parentIntent, childIntent)
    )));
}

function childPlanWithinParent(operation, intent, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || !Array.isArray(plan.childDomainIds) || plan.childDomainIds.length !== 0
    || !Array.isArray(plan.childDomains) || plan.childDomains.length !== 0
    || plan.websiteId !== intent.websiteId
    || !exactChildAuthoritativeDnsIntent(intent.authoritativeDns, plan.authoritativeDns)
    || !childCertificatePlanWithinParent(operation, intent, plan)
    || !childExternalDnsPlanWithinParent(operation, intent, plan)
    || !childMailDomainPlanWithinParent(operation, intent, plan)
    || !Array.isArray(plan.activeJobIds) || plan.activeJobIds.length !== 0
    || !idsWithin(plan.certificateIds, operation.plan.certificateIds)
    || !idsWithin(plan.dnsZoneIds, operation.plan.dnsZoneIds)
    || !idsWithin(plan.mailDomainIds, operation.plan.mailDomainIds)) {
    return false;
  }
  for (const name of ['mailboxes', 'backups', 'crons', 'dockerWorkloads']) {
    const bucket = plan.additional?.[name];
    const parentBucket = operation.plan.additional?.[name];
    if (bucket?.status !== 'available' || parentBucket?.status !== 'available'
      || !idsWithin(bucket.ids, parentBucket.ids)) return false;
  }
  return true;
}

function exactChildRemovalPreview(operation, intent, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'domain_remove'
    && preview.readyToStart === true
    && Array.isArray(preview.hardBlockers)
    && preview.hardBlockers.length === 0
    && preview.domain?.id === intent.id
    && preview.domain?.serverId === intent.serverId
    && preview.domain?.primaryDomain === intent.primaryDomain
    && preview.domain?.websiteId === intent.websiteId
    && preview.domain?.certificateId === intent.certificateId
    && preview.domain?.parentDomainId === intent.parentDomainId
    && preview.domain?.state === intent.state
    && preview.domain?.desiredRevision === intent.desiredRevision
    && preview.domain?.checksum === intent.checksum
    && (preview.domain?.suspensionOperationId ?? null) === intent.suspensionOperationId
    && typeof preview.previewDigest === 'string'
    && SHA256_PATTERN.test(preview.previewDigest)
    && typeof preview.confirmation === 'string'
    && preview.confirmation.length > 0
    && childPlanWithinParent(operation, intent, preview.plan));
}

function exactChildRemovalOperation(operation, intent, child) {
  const parentCreatedAt = Date.parse(operation.createdAt);
  const childCreatedAt = Date.parse(child?.createdAt);
  return Boolean(child
    && child.parentOperationId === operation.id
    && Number.isFinite(parentCreatedAt)
    && Number.isFinite(childCreatedAt)
    && childCreatedAt >= parentCreatedAt
    && child.domainId === intent.id
    && child.serverId === intent.serverId
    && child.primaryDomain === intent.primaryDomain
    && child.domainRevision === intent.desiredRevision
    && child.checksum === intent.checksum
    && child.sourceSuspensionOperationId === intent.suspensionOperationId
    && childPlanWithinParent(operation, intent, child.plan));
}

function childRemovalEvidence(operation, intent, child) {
  const finalStep = child?.steps?.at(-1);
  if (!exactChildRemovalOperation(operation, intent, child)
    || child.status !== 'removed'
    || !Array.isArray(child.steps)
    || child.steps.some((step) => step.status !== 'succeeded')
    || finalStep?.kind !== 'metadata_finalization'
    || finalStep.result?.referenceId !== intent.id
    || typeof finalStep.result?.evidenceDigest !== 'string'
    || !SHA256_PATTERN.test(finalStep.result.evidenceDigest)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_child_evidence_invalid',
      'Child Domain operation did not prove exact metadata removal',
      409,
    );
  }
  return Object.freeze({
    referenceId: child.id,
    evidenceDigest: digest({
      kind: 'child_domain',
      parentOperationId: operation.id,
      childOperationId: child.id,
      domainId: intent.id,
      serverId: intent.serverId,
      primaryDomain: intent.primaryDomain,
      domainRevision: intent.desiredRevision,
      checksum: intent.checksum,
      previewDigest: child.previewDigest,
      metadataEvidenceDigest: finalStep.result.evidenceDigest,
      removedAt: child.updatedAt,
    }),
  });
}


function externalDnsZoneIntent(operation, step) {
  if (!Array.isArray(operation.plan.dnsZoneIntents)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_external_dns_intent_missing',
      'Legacy Domain removal journal has no exact External DNS Zone intent evidence',
      409,
    );
  }
  const matches = operation.plan.dnsZoneIntents.filter((intent) => (
    intent.id === step.resourceId && intent.webDomainId === operation.domainId
  ));
  if (matches.length !== 1) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_external_dns_plan_invalid',
      'External DNS Zone step does not match one exact Domain-scoped removal intent',
      409,
    );
  }
  return matches[0];
}

function exactExternalDnsZone(intent, zone) {
  return Boolean(zone
    && zone.id === intent.id
    && zone.zoneName === intent.zoneName
    && zone.webDomainId === intent.webDomainId
    && zone.managementMode === 'external'
    && zone.status === intent.status
    && zone.revision === intent.revision
    && zone.updatedAt === intent.updatedAt);
}

function externalDnsZoneEvidence(operation, intent) {
  return Object.freeze({
    referenceId: intent.id,
    evidenceDigest: digest({
      kind: 'external_dns_zone',
      operationId: operation.id,
      domainId: operation.domainId,
      dnsZoneId: intent.id,
      zoneName: intent.zoneName,
      webDomainId: intent.webDomainId,
      managementMode: intent.managementMode,
      sourceStatus: intent.status,
      sourceRevision: intent.revision,
      sourceUpdatedAt: intent.updatedAt,
      metadataUnlinked: true,
    }),
  });
}

function mailDomainIntent(operation, step) {
  if (!Array.isArray(operation.plan.mailDomainIntents)) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_mail_intent_missing',
      'Legacy Domain removal journal has no exact Mail Domain intent evidence',
      409,
    );
  }
  const matches = operation.plan.mailDomainIntents.filter((intent) => (
    intent.id === step.resourceId && intent.webDomainId === operation.domainId
  ));
  if (matches.length !== 1) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_mail_plan_invalid',
      'Mail Domain step does not match one exact Domain-scoped removal intent',
      409,
    );
  }
  return matches[0];
}

function mailRemovalMethod(intent) {
  return intent.managementMode === 'local'
    ? 'local_verified_data_finalize'
    : 'external_metadata_unlink';
}

function exactMailRemovalPreview(operation, intent, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'mail_domain_remove'
    && preview.readyToStart === true
    && Array.isArray(preview.blockers)
    && preview.blockers.length === 0
    && preview.mailDomain?.id === intent.id
    && preview.mailDomain?.webDomainId === intent.webDomainId
    && preview.mailDomain?.domainName === intent.domainName
    && preview.mailDomain?.managementMode === intent.managementMode
    && preview.mailDomain?.status === intent.status
    && preview.mailDomain?.revision === intent.revision
    && preview.mailDomain?.updatedAt === intent.updatedAt
    && preview.parentOperationId === operation.id
    && preview.removalMethod === mailRemovalMethod(intent)
    && typeof preview.previewDigest === 'string'
    && SHA256_PATTERN.test(preview.previewDigest)
    && typeof preview.confirmation === 'string'
    && preview.confirmation.length > 0
    && preview.sideEffects === false);
}

function exactMailRemovalChild(operation, intent, child) {
  const parentCreatedAt = Date.parse(operation.createdAt);
  const childCreatedAt = Date.parse(child?.createdAt);
  const childUpdatedAt = Date.parse(child?.updatedAt);
  return Boolean(child
    && typeof child.id === 'string'
    && SAFE_REFERENCE_ID.test(child.id)
    && child.parentOperationId === operation.id
    && Number.isFinite(parentCreatedAt)
    && Number.isFinite(childCreatedAt)
    && Number.isFinite(childUpdatedAt)
    && new Date(childCreatedAt).toISOString() === child.createdAt
    && new Date(childUpdatedAt).toISOString() === child.updatedAt
    && childCreatedAt >= parentCreatedAt
    && childUpdatedAt >= childCreatedAt
    && child.mailDomainId === intent.id
    && child.webDomainId === intent.webDomainId
    && child.domainName === intent.domainName
    && child.managementMode === intent.managementMode
    && child.sourceStatus === intent.status
    && child.sourceRevision === intent.revision
    && child.sourceUpdatedAt === intent.updatedAt
    && child.removalMethod === mailRemovalMethod(intent)
    && typeof child.previewDigest === 'string'
    && SHA256_PATTERN.test(child.previewDigest)
    && MAIL_REMOVAL_CHILD_STATUSES.has(child.status));
}

function optionalSafeReference(value) {
  return value === null || (typeof value === 'string' && SAFE_REFERENCE_ID.test(value));
}

function mailRemovalEvidence(operation, intent, child) {
  const result = child?.result;
  const local = intent.managementMode === 'local';
  const expectedFinalRevision = intent.revision + (intent.status === 'enabled' ? 1 : 0);
  const deletedAt = Date.parse(result?.deletedAt);
  if (!exactMailRemovalChild(operation, intent, child)
    || child.status !== 'removed'
    || result?.removed !== true
    || result.mailDomainId !== intent.id
    || result.webDomainId !== intent.webDomainId
    || result.domainName !== intent.domainName
    || result.managementMode !== intent.managementMode
    || result.removalMethod !== mailRemovalMethod(intent)
    || result.finalRevision !== (local ? expectedFinalRevision : intent.revision)
    || typeof result.cleanupEvidenceDigest !== 'string'
    || !SHA256_PATTERN.test(result.cleanupEvidenceDigest)
    || typeof result.deletedAt !== 'string'
    || !Number.isFinite(deletedAt)
    || new Date(deletedAt).toISOString() !== result.deletedAt
    || deletedAt < Date.parse(child.createdAt)
    || !optionalSafeReference(result.disableJobId)
    || !optionalSafeReference(result.dataDeleteJobId)
    || !optionalSafeReference(result.backupId)
    || (local && (result.dataDeleteJobId === null || result.backupId === null))
    || (local && intent.status === 'enabled' && result.disableJobId === null)
    || (local && intent.status === 'disabled' && result.disableJobId !== null)
    || (!local && (result.disableJobId !== null
      || result.dataDeleteJobId !== null || result.backupId !== null))) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_mail_evidence_invalid',
      'Mail Domain child operation did not prove its exact destructive lifecycle',
      409,
    );
  }
  return Object.freeze({
    referenceId: child.id,
    evidenceDigest: digest({
      kind: 'mail_domain',
      parentOperationId: operation.id,
      childOperationId: child.id,
      mailDomainId: intent.id,
      webDomainId: intent.webDomainId,
      domainName: intent.domainName,
      managementMode: intent.managementMode,
      sourceStatus: intent.status,
      sourceRevision: intent.revision,
      finalRevision: result.finalRevision,
      removalMethod: result.removalMethod,
      previewDigest: child.previewDigest,
      disableJobId: result.disableJobId,
      dataDeleteJobId: result.dataDeleteJobId,
      backupId: result.backupId,
      cleanupEvidenceDigest: result.cleanupEvidenceDigest,
      deletedAt: result.deletedAt,
    }),
  });
}

export function createDomainRemovalRuntime({
  registry,
  previewProvider,
  suspensionRuntime,
  domainRegistry = null,
  certificateRegistry = null,
  dnsZoneRetirementRuntime = null,
  dnsHostingRegistry = null,
  mailDomainRemovalRuntime = null,
} = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForDomain !== 'function'
    || typeof registry.listInterrupted !== 'function' || typeof registry.markStepRunning !== 'function'
    || typeof registry.succeedStep !== 'function' || typeof registry.blockStep !== 'function'
    || typeof registry.failStep !== 'function'
    || typeof previewProvider !== 'function'
    || !suspensionRuntime || typeof suspensionRuntime.preview !== 'function'
    || typeof suspensionRuntime.start !== 'function'
    || typeof suspensionRuntime.retrySuspend !== 'function'
    || typeof suspensionRuntime.get !== 'function'
    || typeof suspensionRuntime.listForDomain !== 'function'
    || (domainRegistry !== null && (
      typeof domainRegistry?.getDomain !== 'function'
      || typeof domainRegistry?.detachWebsiteForRemoval !== 'function'
      || typeof domainRegistry?.detachCertificateForRemoval !== 'function'
      || typeof domainRegistry?.finalizeDomainRemoval !== 'function'
    ))
    || (certificateRegistry !== null && (
      typeof certificateRegistry?.getCertificate !== 'function'
      || typeof certificateRegistry?.retireForDomainRemoval !== 'function'
    ))
    || (dnsHostingRegistry !== null && (
      typeof dnsHostingRegistry?.getZone !== 'function'
      || typeof dnsHostingRegistry?.deleteZone !== 'function'
    ))
    || (dnsZoneRetirementRuntime !== null && (
      typeof dnsZoneRetirementRuntime?.preview !== 'function'
      || typeof dnsZoneRetirementRuntime?.start !== 'function'
      || typeof dnsZoneRetirementRuntime?.retry !== 'function'
      || typeof dnsZoneRetirementRuntime?.listForDomain !== 'function'
    ))
    || (mailDomainRemovalRuntime !== null && (
      typeof mailDomainRemovalRuntime?.preview !== 'function'
      || typeof mailDomainRemovalRuntime?.start !== 'function'
      || typeof mailDomainRemovalRuntime?.retry !== 'function'
      || typeof mailDomainRemovalRuntime?.listForMailDomain !== 'function'
    ))) {
    throw new DomainRemovalRuntimeError(
      'domain_removal_runtime_dependencies_invalid',
      'Domain removal runtime dependencies are unavailable',
      503,
    );
  }

  function requireDomainRegistry() {
    if (!domainRegistry) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_control_plane_unavailable',
        'Domain removal control-plane step handler is unavailable',
        503,
      );
    }
    return domainRegistry;
  }

  function requireDnsZoneRetirementRuntime() {
    if (!dnsZoneRetirementRuntime) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_dns_retirement_unavailable',
        'Domain removal authoritative DNS step handler is unavailable',
        503,
      );
    }
    return dnsZoneRetirementRuntime;
  }

  function requireCertificateRegistry() {
    if (!certificateRegistry) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_certificate_registry_unavailable',
        'Domain removal certificate retirement handler is unavailable',
        503,
      );
    }
    return certificateRegistry;
  }


  function requireDnsHostingRegistry() {
    if (!dnsHostingRegistry) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_external_dns_registry_unavailable',
        'Domain removal External DNS Zone metadata handler is unavailable',
        503,
      );
    }
    return dnsHostingRegistry;
  }

  function requireMailDomainRemovalRuntime() {
    if (!mailDomainRemovalRuntime) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_mail_runtime_unavailable',
        'Domain removal Mail Domain child lifecycle is unavailable',
        503,
      );
    }
    return mailDomainRemovalRuntime;
  }

  async function loadOperation(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    return operation;
  }

  async function runningStep(operation, expectedKind) {
    const first = firstIncomplete(operation);
    if (!first || first.kind !== expectedKind) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_step_out_of_order',
        'Domain removal step does not match the next journaled dependency',
        409,
      );
    }
    const wasRunning = first.status === 'running';
    if (!wasRunning) {
      try { operation = await registry.markStepRunning(operation.id, first.id); }
      catch (error) { throw mapped(error); }
    }
    const step = firstIncomplete(operation);
    if (!step || step.kind !== expectedKind || step.status !== 'running') {
      throw new DomainRemovalRuntimeError(
        'domain_removal_step_state_invalid',
        'Domain removal step state changed unexpectedly',
        409,
      );
    }
    return Object.freeze({ operation, step, wasRunning });
  }

  async function blockControlPlaneStep(operation, step, error) {
    try {
      return await registry.blockStep(
        operation.id,
        step.id,
        safeFailure(
          error,
          'domain_removal_step_retry_required',
          'Domain removal step requires explicit retry',
        ),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function failControlPlaneStep(operation, step, error) {
    try {
      return await registry.failStep(
        operation.id,
        step.id,
        safeFailure(error, 'domain_removal_step_failed', 'Domain removal step failed'),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function completeControlPlaneStep(operation, step, result) {
    try { return await registry.succeedStep(operation.id, step.id, result); }
    catch (error) { throw mapped(error); }
  }

  async function discoverChildDomainOperation(operation, intent) {
    let values;
    try { values = await registry.listForDomain(intent.id); }
    catch (error) { throw mapped(error); }
    if (!Array.isArray(values)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_child_inventory_invalid',
        'Child Domain removal operation inventory is invalid',
        503,
      );
    }
    const candidates = values.filter((child) => (
      exactChildRemovalOperation(operation, intent, child)
    ));
    if (candidates.length > 1) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_child_operation_ambiguous',
        'Multiple child Domain operations match the parent removal intent',
        409,
      );
    }
    return candidates[0] ?? null;
  }

  async function currentChildDomainPreview(operation, intent) {
    let preview;
    try { preview = await previewProvider({ domainId: intent.id }); }
    catch (error) { throw mapped(error); }
    if (!exactChildRemovalPreview(operation, intent, preview)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_child_preview_drift',
        'Child Domain removal state no longer matches the parent journaled intent',
        409,
      );
    }
    return preview;
  }

  async function startChildDomainRemoval(operation, intent) {
    const preview = await currentChildDomainPreview(operation, intent);
    let child;
    try { child = await registry.create(preview, { parentOperationId: operation.id }); }
    catch (error) { throw mapped(error); }
    if (!exactChildRemovalOperation(operation, intent, child)
      || !currentPreviewMatches(child, preview)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_child_operation_drift',
        'Child Domain journal does not match the parent-owned removal intent',
        409,
      );
    }
    return runRouting(child.id, { allowHostMutation: true });
  }

  async function continueChildDomainRemoval(child) {
    if (child.status === 'removed') return child;
    if (child.actions?.routingRetryConfirmation) {
      return retryRouting({
        domainId: child.domainId,
        operationId: child.id,
        expectedUpdatedAt: child.updatedAt,
        checksum: child.checksum,
        confirmation: child.actions.routingRetryConfirmation,
      });
    }
    if (child.actions?.stepContinuationConfirmation) {
      const step = firstIncomplete(child);
      return continueStep({
        domainId: child.domainId,
        operationId: child.id,
        expectedUpdatedAt: child.updatedAt,
        stepId: step.id,
        checksum: child.checksum,
        confirmation: child.actions.stepContinuationConfirmation,
      });
    }
    return child;
  }

  async function runChildDomain(operationId, { allowMutation } = {}) {
    requireDomainRegistry();
    const prepared = await runningStep(await loadOperation(operationId), 'child_domain');
    const { operation, step } = prepared;
    let intent;
    try { intent = childDomainIntent(operation, step); }
    catch (error) {
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    let child;
    try { child = await discoverChildDomainOperation(operation, intent); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (child?.status === 'removed') {
      return publicOperation(await completeControlPlaneStep(
        operation,
        step,
        childRemovalEvidence(operation, intent, child),
      ));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_child_retry_required',
        child
          ? 'Child Domain operation requires explicit continuation'
          : 'Child Domain operation was not started before interruption',
        409,
      )));
    }
    let result;
    try {
      result = child
        ? await continueChildDomainRemoval(publicOperation(child))
        : await startChildDomainRemoval(operation, intent);
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!exactChildRemovalOperation(operation, intent, result)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_child_result_invalid',
        'Child Domain operation result does not match the parent journaled intent',
        503,
      )));
    }
    if (result.status !== 'removed') {
      const pending = firstIncomplete(result);
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        pending?.error?.code ?? 'domain_removal_child_retry_required',
        pending?.error?.message ?? 'Child Domain operation requires explicit continuation',
        409,
      )));
    }
    return publicOperation(await completeControlPlaneStep(
      operation,
      step,
      childRemovalEvidence(operation, intent, result),
    ));
  }

  async function runCertificate(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const certificates = requireCertificateRegistry();
    const prepared = await runningStep(await loadOperation(operationId), 'certificate');
    const { operation, step } = prepared;
    let intent;
    try { intent = certificateIntent(operation, step); }
    catch (error) {
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    const suspensionId = suspensionOperationId(operation);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (!exactSuspendedDomain(operation, domain, suspensionId)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_domain_drift',
        'Domain state no longer matches journaled certificate retirement evidence',
        409,
      )));
    }
    const boundCertificateId = operation.plan.boundCertificateId;
    if (domain.certificateId !== null && domain.certificateId !== boundCertificateId) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_binding_drift',
        'Domain certificate binding changed before removal cleanup',
        409,
      )));
    }
    let certificate;
    try { certificate = await certificates.getCertificate(intent.id); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (!certificate) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_missing',
        'Journaled certificate disappeared before operation-owned retirement',
        409,
      )));
    }
    if (certificate.state === 'retired') {
      if (!exactRetiredCertificate(operation, intent, certificate)
        || (intent.id === boundCertificateId && domain.certificateId !== null)) {
        return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
          'domain_removal_certificate_retirement_drift',
          'Certificate retirement state does not match this Domain removal operation',
          409,
        )));
      }
      return publicOperation(await completeControlPlaneStep(
        operation,
        step,
        certificateRetirementEvidence(operation, intent, certificate, suspensionId),
      ));
    }
    if (!sameCertificateIntent(intent, certificate)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_intent_drift',
        'Certificate state changed after Domain removal planning',
        409,
      )));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_retry_required',
        'Certificate retirement requires explicit removal continuation',
        409,
      )));
    }
    if (intent.id === boundCertificateId && domain.certificateId === intent.id) {
      let detached;
      try {
        detached = await manager.detachCertificateForRemoval(operation.domainId, {
          expectedCertificateId: intent.id,
          expectedRevision: operation.domainRevision,
          checksum: operation.checksum,
          suspensionOperationId: suspensionId,
        });
      } catch (error) {
        if (Number(error?.status) === 409) {
          return publicOperation(await blockControlPlaneStep(operation, step, error));
        }
        return publicOperation(await failControlPlaneStep(operation, step, error));
      }
      if (detached?.detachedCertificateId !== intent.id
        || detached.domain?.certificateId !== null
        || !exactSuspendedDomain(operation, detached.domain, suspensionId)) {
        return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
          'domain_removal_certificate_detach_result_invalid',
          'Certificate detachment did not prove the journaled post-condition',
          503,
        )));
      }
      domain = detached.domain;
    }
    let retired;
    try {
      retired = await certificates.retireForDomainRemoval(intent.id, {
        expectedDomainId: intent.domainId,
        expectedServerId: intent.serverId,
        expectedState: intent.state,
        expectedSource: intent.source,
        expectedRenewalMode: intent.renewalMode,
        expectedStaging: intent.staging,
        expectedValidTo: intent.validTo,
        expectedUpdatedAt: intent.updatedAt,
        operationId: operation.id,
      });
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!exactRetiredCertificate(operation, intent, retired?.certificate)
      || (intent.id === boundCertificateId && domain.certificateId !== null)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_certificate_result_invalid',
        'Certificate retirement result does not match journaled intent',
        503,
      )));
    }
    return publicOperation(await completeControlPlaneStep(
      operation,
      step,
      certificateRetirementEvidence(operation, intent, retired.certificate, suspensionId),
    ));
  }

  async function discoverMailDomainOperation(operation, intent, runtime) {
    let values;
    try { values = await runtime.listForMailDomain(intent.id); }
    catch (error) { throw mapped(error); }
    if (!Array.isArray(values)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_mail_inventory_invalid',
        'Mail Domain child operation inventory is invalid',
        503,
      );
    }
    const owned = values.filter((child) => child?.parentOperationId === operation.id);
    if (owned.length > 1) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_mail_operation_ambiguous',
        'Multiple Mail Domain child operations match the removal intent',
        409,
      );
    }
    if (owned.length === 1 && !exactMailRemovalChild(operation, intent, owned[0])) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_mail_operation_drift',
        'Parent-owned Mail Domain child operation no longer matches the removal intent',
        409,
      );
    }
    return owned[0] ?? null;
  }

  async function currentMailDomainPreview(operation, intent, runtime) {
    let preview;
    try {
      preview = await runtime.preview({
        mailDomainId: intent.id,
        parentOperationId: operation.id,
      });
    } catch (error) { throw mapped(error); }
    if (!exactMailRemovalPreview(operation, intent, preview)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_mail_preview_drift',
        'Mail Domain removal state no longer matches the parent journaled intent',
        409,
      );
    }
    return preview;
  }

  async function continueMailDomainChild(operation, intent, child, runtime) {
    if (child?.status === 'removed') return child;
    if (child) {
      if (child.recovery?.retryable !== true
        || typeof child.recovery?.retryConfirmation !== 'string'
        || child.recovery.retryConfirmation.length < 1) {
        throw new DomainRemovalRuntimeError(
          'domain_removal_mail_retry_evidence_invalid',
          'Mail Domain child operation retry evidence is unavailable',
          409,
        );
      }
      try {
        return await runtime.retry({
          mailDomainId: intent.id,
          operationId: child.id,
          parentOperationId: operation.id,
          expectedUpdatedAt: child.updatedAt,
          confirmation: child.recovery.retryConfirmation,
        });
      } catch (error) { throw mapped(error); }
    }
    const preview = await currentMailDomainPreview(operation, intent, runtime);
    try {
      const started = await runtime.start({
        mailDomainId: intent.id,
        parentOperationId: operation.id,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      });
      if (started?.previewDigest !== preview.previewDigest) {
        throw new DomainRemovalRuntimeError(
          'domain_removal_mail_operation_drift',
          'Mail Domain child journal does not match the parent-approved preview',
          409,
        );
      }
      return started;
    } catch (error) { throw mapped(error); }
  }

  async function runMailDomain(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const runtime = requireMailDomainRemovalRuntime();
    const prepared = await runningStep(await loadOperation(operationId), 'mail_domain');
    const { operation, step } = prepared;
    let intent;
    try { intent = mailDomainIntent(operation, step); }
    catch (error) {
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    const suspensionId = suspensionOperationId(operation);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (!exactSuspendedDomain(operation, domain, suspensionId)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_mail_domain_drift',
        'Domain state no longer matches journaled Mail Domain removal evidence',
        409,
      )));
    }
    let child;
    try { child = await discoverMailDomainOperation(operation, intent, runtime); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (child?.status === 'removed') {
      try {
        return publicOperation(await completeControlPlaneStep(
          operation,
          step,
          mailRemovalEvidence(operation, intent, child),
        ));
      } catch (error) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_mail_retry_required',
        child
          ? 'Mail Domain child operation requires explicit continuation'
          : 'Mail Domain child operation was not started before interruption',
        409,
      )));
    }
    let result;
    try { result = await continueMailDomainChild(operation, intent, child, runtime); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!exactMailRemovalChild(operation, intent, result)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_mail_result_invalid',
        'Mail Domain child operation result does not match journaled removal intent',
        503,
      )));
    }
    if (result.status !== 'removed') {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        result.error?.code ?? 'domain_removal_mail_retry_required',
        result.error?.message ?? 'Mail Domain child operation requires explicit continuation',
        409,
      )));
    }
    try {
      return publicOperation(await completeControlPlaneStep(
        operation,
        step,
        mailRemovalEvidence(operation, intent, result),
      ));
    } catch (error) {
      return publicOperation(await blockControlPlaneStep(operation, step, error));
    }
  }


  async function runExternalDnsZone(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const dnsRegistry = requireDnsHostingRegistry();
    const prepared = await runningStep(await loadOperation(operationId), 'external_dns_zone');
    const { operation, step, wasRunning } = prepared;
    let intent;
    try { intent = externalDnsZoneIntent(operation, step); }
    catch (error) {
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    const suspensionId = suspensionOperationId(operation);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (!exactSuspendedDomain(operation, domain, suspensionId)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_external_dns_domain_drift',
        'Domain state no longer matches journaled External DNS Zone removal evidence',
        409,
      )));
    }

    const evidence = externalDnsZoneEvidence(operation, intent);
    let current;
    try { current = await dnsRegistry.getZone(intent.id); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (current === null) {
      if (!wasRunning) {
        return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
          'domain_removal_external_dns_absence_unowned',
          'External DNS Zone metadata disappeared before this removal step owned the mutation',
          409,
        )));
      }
      return publicOperation(await completeControlPlaneStep(operation, step, evidence));
    }
    if (!exactExternalDnsZone(intent, current)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_external_dns_drift',
        'External DNS Zone metadata changed before removal cleanup',
        409,
      )));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_external_dns_retry_required',
        'External DNS Zone metadata remains present; explicit removal continuation is required',
        409,
      )));
    }

    let removed;
    try {
      removed = await dnsRegistry.deleteZone(intent.id, {
        expectedRevision: intent.revision,
        confirmation: 'delete-dns-zone:' + intent.id + ':' + intent.revision,
      });
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!removed || removed.deleted !== true
      || removed.id !== intent.id || removed.resourceType !== 'dns_zone') {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_external_dns_result_invalid',
        'External DNS Zone metadata removal did not prove the journaled post-condition',
        503,
      )));
    }
    return publicOperation(await completeControlPlaneStep(operation, step, evidence));
  }

  async function runWebsiteBinding(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const prepared = await runningStep(await loadOperation(operationId), 'website_binding');
    const { operation, step, wasRunning } = prepared;
    const expectedWebsiteId = operation.plan.websiteId;
    if (expectedWebsiteId === null || step.resourceId !== expectedWebsiteId) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_website_plan_invalid',
        'Domain removal Website step does not match journaled dependency identity',
        409,
      )));
    }
    const suspensionId = suspensionOperationId(operation);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (!exactSuspendedDomain(operation, domain, suspensionId)) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_website_domain_drift',
        'Domain state no longer matches journaled Website detachment evidence',
        409,
      )));
    }
    const evidence = websiteBindingEvidence(operation, expectedWebsiteId, suspensionId);
    if (domain.websiteId === null) {
      if (!wasRunning && !allowMutation) {
        return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
          'domain_removal_website_detachment_unowned',
          'Website binding disappeared before this removal step owned the mutation',
          409,
        )));
      }
      return publicOperation(await completeControlPlaneStep(operation, step, evidence));
    }
    if (domain.websiteId !== expectedWebsiteId) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_website_binding_drift',
        'Domain Website binding changed before removal cleanup',
        409,
      )));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_website_detach_retry_required',
        'Website binding is still present; explicit removal continuation is required',
        409,
      )));
    }
    let detached;
    try {
      detached = await manager.detachWebsiteForRemoval(operation.domainId, {
        expectedWebsiteId,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
        suspensionOperationId: suspensionId,
      });
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (detached?.detachedWebsiteId !== expectedWebsiteId
      || detached.domain?.websiteId !== null
      || !exactSuspendedDomain(operation, detached.domain, suspensionId)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_website_result_invalid',
        'Website detachment result did not prove the journaled post-condition',
        503,
      )));
    }
    return publicOperation(await completeControlPlaneStep(operation, step, evidence));
  }

  async function runMetadataFinalization(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const prepared = await runningStep(await loadOperation(operationId), 'metadata_finalization');
    const { operation, step, wasRunning } = prepared;
    if (step.resourceId !== operation.domainId) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_metadata_plan_invalid',
        'Domain metadata finalization does not match journaled identity',
        409,
      )));
    }
    const suspensionId = suspensionOperationId(operation);
    const evidence = metadataFinalizationEvidence(operation, suspensionId);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) { return publicOperation(await failControlPlaneStep(operation, step, error)); }
    if (domain === null) {
      if (!wasRunning) {
        return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
          'domain_removal_metadata_absence_unowned',
          'Domain metadata disappeared before this removal step owned the mutation',
          409,
        )));
      }
      return publicOperation(await completeControlPlaneStep(operation, step, evidence));
    }
    if (!exactSuspendedDomain(operation, domain, suspensionId)
      || domain.websiteId !== null || domain.certificateId !== null) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_metadata_domain_drift',
        'Domain metadata no longer matches finalization prerequisites',
        409,
      )));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_metadata_retry_required',
        'Domain metadata remains present; explicit removal continuation is required',
        409,
      )));
    }
    let finalized;
    try {
      finalized = await manager.finalizeDomainRemoval(operation.domainId, {
        operationId: suspensionId,
        expectedRevision: operation.domainRevision,
        checksum: operation.checksum,
        confirmation: metadataFinalizationConfirmation(operation, suspensionId),
      });
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockControlPlaneStep(operation, step, error));
      }
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (finalized?.removed !== true
      || finalized.domain?.id !== operation.domainId
      || finalized.domain?.serverId !== operation.serverId
      || finalized.domain?.primaryDomain !== operation.primaryDomain
      || finalized.domain?.desiredRevision !== operation.domainRevision
      || finalized.domain?.suspensionOperationId !== suspensionId
      || finalized.domain?.suspendedChecksum !== operation.checksum) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_metadata_result_invalid',
        'Domain metadata finalization did not prove the journaled post-condition',
        503,
      )));
    }
    return publicOperation(await completeControlPlaneStep(operation, step, evidence));
  }

  async function dnsRetirementChild(operation, runtime) {
    let values;
    try { values = await runtime.listForDomain(operation.domainId); }
    catch (error) { throw mapped(error); }
    if (!Array.isArray(values)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_dns_inventory_invalid',
        'DNS retirement child operation inventory is invalid',
        503,
      );
    }
    const candidates = values.filter((child) => exactDnsRetirementChild(operation, child));
    if (candidates.length > 1) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_dns_operation_ambiguous',
        'Multiple DNS retirement child operations match the removal intent',
        409,
      );
    }
    return candidates[0] ?? null;
  }

  async function currentDnsRetirementPreview(operation, runtime) {
    let preview;
    try { preview = await runtime.preview({ domainId: operation.domainId }); }
    catch (error) { throw mapped(error); }
    if (!exactDnsRetirementPreview(operation, preview)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_dns_preview_drift',
        'Authoritative DNS retirement state no longer matches the journaled removal intent',
        409,
      );
    }
    return preview;
  }

  async function continueDnsRetirementChild(operation, child, runtime) {
    if (child?.status === 'deleted') return child;
    if (child && ['deleting', 'failed'].includes(child.status)) {
      if (child.recovery?.retryable !== true
        || typeof child.recovery?.retryConfirmation !== 'string') {
        throw new DomainRemovalRuntimeError(
          'domain_removal_dns_retry_evidence_invalid',
          'DNS retirement child operation retry evidence is unavailable',
          409,
        );
      }
      try {
        return await runtime.retry({
          domainId: operation.domainId,
          operationId: child.id,
          expectedUpdatedAt: child.updatedAt,
          snapshotDigest: child.snapshotDigest,
          confirmation: child.recovery.retryConfirmation,
        });
      } catch (error) { throw mapped(error); }
    }
    const preview = await currentDnsRetirementPreview(operation, runtime);
    try {
      return await runtime.start({
        domainId: operation.domainId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      });
    } catch (error) { throw mapped(error); }
  }

  async function runAuthoritativeDns(operationId, { allowMutation } = {}) {
    const manager = requireDomainRegistry();
    const runtime = requireDnsZoneRetirementRuntime();
    const prepared = await runningStep(await loadOperation(operationId), 'authoritative_dns');
    const { operation, step } = prepared;
    const planned = operation.plan.authoritativeDns;
    if (step.resourceId !== operation.domainId
      || !planned || planned.zoneSnapshotDigest === null
      || planned.ownershipEvidenceDigest === null
      || !Number.isSafeInteger(planned.snapshotRetentionDays)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_dns_plan_invalid',
        'Authoritative DNS step does not contain exact journaled ownership and retention evidence',
        409,
      )));
    }
    const suspensionId = suspensionOperationId(operation);
    let domain;
    try { domain = await manager.getDomain(operation.domainId); }
    catch (error) {
      if (!allowMutation) throw mapped(error);
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!exactSuspendedDomain(operation, domain, suspensionId)
      || domain.websiteId !== null || domain.certificateId !== null) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_dns_domain_drift',
        'Domain state no longer matches authoritative DNS retirement prerequisites',
        409,
      )));
    }
    let child;
    try { child = await dnsRetirementChild(operation, runtime); }
    catch (error) {
      if (!allowMutation) throw error;
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (child?.status === 'deleted') {
      return publicOperation(await completeControlPlaneStep(
        operation,
        step,
        dnsRetirementEvidence(operation, child),
      ));
    }
    if (!allowMutation) {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_dns_retry_required',
        child
          ? 'DNS retirement child operation requires explicit continuation'
          : 'DNS retirement child operation was not started before interruption',
        409,
      )));
    }
    let result;
    try { result = await continueDnsRetirementChild(operation, child, runtime); }
    catch (error) {
      return publicOperation(await failControlPlaneStep(operation, step, error));
    }
    if (!exactDnsRetirementChild(operation, result)) {
      return publicOperation(await failControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_dns_result_invalid',
        'DNS retirement child operation result does not match journaled removal intent',
        503,
      )));
    }
    if (result.status !== 'deleted') {
      return publicOperation(await blockControlPlaneStep(operation, step, new DomainRemovalRuntimeError(
        result.error?.code ?? 'domain_removal_dns_retry_required',
        result.error?.message ?? 'DNS retirement child operation requires explicit continuation',
        409,
      )));
    }
    return publicOperation(await completeControlPlaneStep(
      operation,
      step,
      dnsRetirementEvidence(operation, result),
    ));
  }

  async function runControlPlaneStep(operationId, { allowMutation } = {}) {
    const operation = await loadOperation(operationId);
    const step = firstIncomplete(operation);
    if (!step) return publicOperation(operation);
    if (step.kind === 'child_domain') {
      return runChildDomain(operation.id, { allowMutation });
    }
    if (step.kind === 'certificate') {
      return runCertificate(operation.id, { allowMutation });
    }
    if (step.kind === 'mail_domain') {
      return runMailDomain(operation.id, { allowMutation });
    }
    if (step.kind === 'external_dns_zone') {
      return runExternalDnsZone(operation.id, { allowMutation });
    }
    if (step.kind === 'website_binding') {
      return runWebsiteBinding(operation.id, { allowMutation });
    }
    if (step.kind === 'authoritative_dns') {
      return runAuthoritativeDns(operation.id, { allowMutation });
    }
    if (step.kind === 'metadata_finalization') {
      return runMetadataFinalization(operation.id, { allowMutation });
    }
    throw new DomainRemovalRuntimeError(
      'domain_removal_step_handler_unavailable',
      'The next Domain removal dependency does not yet have a destructive lifecycle handler',
      409,
    );
  }

  async function childBySource(operation) {
    if (operation.sourceSuspensionOperationId === null) return null;
    let child;
    try { child = await suspensionRuntime.get(operation.sourceSuspensionOperationId); }
    catch (error) { throw mapped(error); }
    if (!child) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_missing',
        'Journaled Domain suspension operation could not be found',
        409,
      );
    }
    if (!exactSuspensionChild(operation, child)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_drift',
        'Journaled Domain suspension operation no longer matches removal intent',
        409,
      );
    }
    return child;
  }

  async function discoverChild(operation) {
    const pinned = await childBySource(operation);
    if (pinned) return pinned;

    let values;
    try { values = await suspensionRuntime.listForDomain(operation.domainId); }
    catch (error) { throw mapped(error); }
    if (!Array.isArray(values)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_inventory_invalid',
        'Domain suspension operation inventory is invalid',
        503,
      );
    }
    const candidates = values.filter((child) => (
      exactSuspensionChild(operation, child)
      && ROUTING_CHILD_STATUSES.has(child.status)
    ));
    if (candidates.length > 1) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_operation_ambiguous',
        'Multiple Domain suspension operations match removal routing intent',
        409,
      );
    }
    return candidates[0] ?? null;
  }

  async function completeRouting(operation, step, child) {
    let result;
    try { result = completedSuspensionEvidence(operation, child); }
    catch (error) { throw mapped(error); }
    try {
      return await registry.succeedStep(operation.id, step.id, result);
    } catch (error) { throw mapped(error); }
  }

  async function blockRouting(operation, step, error) {
    try {
      return await registry.blockStep(
        operation.id,
        step.id,
        safeFailure(
          error,
          'domain_removal_routing_retry_required',
          'Domain routing suspension requires explicit retry',
        ),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function failRouting(operation, step, error) {
    try {
      return await registry.failStep(
        operation.id,
        step.id,
        safeFailure(error, 'domain_removal_routing_failed', 'Domain routing suspension failed'),
      );
    } catch (registryError) { throw mapped(registryError); }
  }

  async function executeChildRetry(operation, child) {
    if (!child.actions?.suspendRetryConfirmation
      || typeof child.updatedAt !== 'string'
      || child.checksum !== operation.checksum) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_retry_unavailable',
        'Matching Domain suspension operation cannot be retried safely',
        409,
      );
    }
    try {
      return await suspensionRuntime.retrySuspend({
        domainId: operation.domainId,
        operationId: child.id,
        expectedUpdatedAt: child.updatedAt,
        checksum: operation.checksum,
        confirmation: child.actions.suspendRetryConfirmation,
      });
    } catch (error) { throw mapped(error); }
  }

  async function startChild(operation) {
    let preview;
    try { preview = await suspensionRuntime.preview({ domainId: operation.domainId }); }
    catch (error) { throw mapped(error); }
    if (!preview || preview.readyToSuspend !== true
      || preview.domain?.id !== operation.domainId
      || preview.domain?.serverId !== operation.serverId
      || preview.domain?.primaryDomain !== operation.primaryDomain
      || preview.domain?.desiredRevision !== operation.domainRevision
      || preview.domain?.stagedRevision !== operation.domainRevision
      || preview.domain?.appliedRevision !== operation.domainRevision
      || preview.domain?.stagedChecksum !== operation.checksum
      || typeof preview.previewDigest !== 'string' || !SHA256_PATTERN.test(preview.previewDigest)
      || typeof preview.confirmation !== 'string' || !preview.confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_suspension_preview_stale',
        'Domain suspension preview no longer matches journaled removal intent',
        409,
      );
    }
    try {
      return await suspensionRuntime.start({
        domainId: operation.domainId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      });
    } catch (error) { throw mapped(error); }
  }

  async function runRouting(operationId, { allowHostMutation } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const first = firstIncomplete(operation);
    if (!first || first.kind !== 'routing_suspend') return publicOperation(operation);
    if (first.status !== 'running') {
      try {
        operation = await registry.markStepRunning(operation.id, first.id);
      } catch (error) { throw mapped(error); }
    }
    const step = firstIncomplete(operation);
    if (!step || step.kind !== 'routing_suspend' || step.status !== 'running') {
      throw new DomainRemovalRuntimeError(
        'domain_removal_routing_state_invalid',
        'Domain removal routing step state changed unexpectedly',
        409,
      );
    }

    let child;
    try { child = await discoverChild(operation); }
    catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      throw error;
    }

    if (child?.status === 'suspended') {
      return publicOperation(await completeRouting(operation, step, child));
    }

    if (!allowHostMutation) {
      return publicOperation(await blockRouting(operation, step, new DomainRemovalRuntimeError(
        child
          ? 'domain_removal_suspension_retry_required'
          : 'domain_removal_suspension_start_required',
        child
          ? 'Matching Domain suspension operation is incomplete; explicit routing retry is required'
          : 'No completed Domain suspension operation exists; explicit routing retry is required',
        409,
      )));
    }

    let result;
    try {
      if (child && ['suspending', 'failed'].includes(child.status)) {
        result = await executeChildRetry(operation, child);
      } else {
        result = await startChild(operation);
      }
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      return publicOperation(await failRouting(operation, step, error));
    }

    if (!result || result.status !== 'suspended') {
      return publicOperation(await blockRouting(operation, step, new DomainRemovalRuntimeError(
        'domain_removal_suspension_incomplete',
        'Domain suspension child operation did not reach suspended state',
        409,
      )));
    }
    try {
      return publicOperation(await completeRouting(operation, step, result));
    } catch (error) {
      if (Number(error?.status) === 409) {
        return publicOperation(await blockRouting(operation, step, error));
      }
      throw error;
    }
  }

  async function preview(input) {
    try { return await previewProvider(input); }
    catch (error) { throw mapped(error); }
  }

  async function start({ domainId, previewDigest, confirmation } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_confirmation_invalid',
        'A current Domain removal preview digest and exact confirmation are required',
        409,
      );
    }
    let current;
    try { current = await previewProvider({ domainId }); }
    catch (error) { throw mapped(error); }
    if (!current || current.readyToStart !== true
      || current.previewDigest !== previewDigest
      || current.confirmation !== confirmation) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_preview_stale',
        'Domain removal preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    if (!currentPreviewMatches(operation, current)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_intent_mismatch',
        'Domain removal journal does not match current preview intent',
        409,
      );
    }
    return runRouting(operation.id, { allowHostMutation: true });
  }

  async function retryRouting({
    domainId,
    operationId,
    expectedUpdatedAt,
    checksum,
    confirmation,
  } = {}) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation || operation.domainId !== domainId) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const step = firstIncomplete(operation);
    if (!step || step.kind !== 'routing_suspend'
      || !['running', 'blocked', 'failed'].includes(step.status)
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== routingRetryConfirmation(operation)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_routing_retry_stale',
        'Domain removal routing retry is stale or confirmation is invalid',
        409,
      );
    }
    return runRouting(operation.id, { allowHostMutation: true });
  }

  async function continueStep({
    domainId,
    operationId,
    expectedUpdatedAt,
    stepId,
    checksum,
    confirmation,
  } = {}) {
    const operation = await loadOperation(operationId);
    if (operation.domainId !== domainId) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_operation_not_found',
        'Domain removal operation was not found',
        404,
      );
    }
    const step = firstIncomplete(operation);
    if (!step || !CONTINUABLE_STEP_KINDS.has(step.kind)
      || !['pending', 'running', 'blocked', 'failed'].includes(step.status)
      || stepId !== step.id
      || expectedUpdatedAt !== operation.updatedAt
      || checksum !== operation.checksum
      || confirmation !== stepContinuationConfirmation(operation, step)) {
      throw new DomainRemovalRuntimeError(
        'domain_removal_step_continuation_stale',
        'Domain removal step continuation is stale or confirmation is invalid',
        409,
      );
    }
    return runControlPlaneStep(operation.id, { allowMutation: true });
  }

  async function reconcileInterrupted(operation) {
    const step = firstIncomplete(operation);
    if (!step || step.status !== 'running') {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_removal_recovery_state_invalid',
          message: 'Domain removal interrupted state is invalid',
        }),
      });
    }
    if (CONTINUABLE_STEP_KINDS.has(step.kind)) {
      const result = await runControlPlaneStep(operation.id, { allowMutation: false });
      const recoveredStep = result.steps.find((candidate) => candidate.id === step.id);
      return Object.freeze({
        operationId: operation.id,
        recovered: recoveredStep?.status === 'succeeded',
        operation: result,
        ...(
          recoveredStep?.status === 'succeeded'
            ? {}
            : {
              error: Object.freeze({
                code: 'domain_removal_step_retry_required',
                message: 'Domain removal step requires explicit retry',
              }),
            }
        ),
      });
    }
    if (step.kind !== 'routing_suspend') {
      return Object.freeze({
        operationId: operation.id,
        recovered: false,
        operation: publicOperation(operation),
        error: Object.freeze({
          code: 'domain_removal_step_retry_required',
          message: 'Interrupted Domain removal step requires explicit retry',
        }),
      });
    }
    const result = await runRouting(operation.id, { allowHostMutation: false });
    return Object.freeze({
      operationId: operation.id,
      recovered: result.steps.find((candidate) => candidate.id === step.id)?.status === 'succeeded',
      operation: result,
      ...(
        result.steps.find((candidate) => candidate.id === step.id)?.status === 'succeeded'
          ? {}
          : {
            error: Object.freeze({
              code: 'domain_removal_routing_retry_required',
              message: 'Domain routing suspension requires explicit retry',
            }),
          }
      ),
    });
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    let interrupted;
    try { interrupted = await registry.listInterrupted(); }
    catch (error) { throw mapped(error); }
    const recovery = [];
    for (const operation of interrupted) {
      try { recovery.push(await reconcileInterrupted(operation)); }
      catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          recovered: false,
          error: safeFailure(
            error,
            'domain_removal_recovery_pending',
            'Domain removal recovery remains pending',
          ),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  async function get(operationId) {
    try { return publicOperation(await registry.get(operationId)); }
    catch (error) { throw mapped(error); }
  }

  async function listForDomain(domainId) {
    try { return Object.freeze((await registry.listForDomain(domainId)).map(publicOperation)); }
    catch (error) { throw mapped(error); }
  }

  return Object.freeze({
    init,
    preview,
    start,
    retryRouting,
    continueStep,
    get,
    listForDomain,
  });
}

export const domainRemovalRuntimeInternals = Object.freeze({
  digest,
  safeFailure,
  routingRetryConfirmation,
  stepContinuationConfirmation,
  firstIncomplete,
  publicOperation,
  currentPreviewMatches,
  exactSuspensionChild,
  completedSuspensionEvidence,
  suspensionOperationId,
  exactSuspendedDomain,
  websiteBindingEvidence,
  metadataFinalizationEvidence,
  metadataFinalizationConfirmation,
  exactDnsRetirementPreview,
  exactDnsRetirementChild,
  dnsRetirementEvidence,
  childDomainIntent,
  exactChildAuthoritativeDnsIntent,
  sameCertificateIntent,
  exactRetiredCertificate,
  certificateIntent,
  childCertificatePlanWithinParent,
  sameMailDomainIntent,
  childMailDomainPlanWithinParent,
  certificateRetirementEvidence,
  childPlanWithinParent,
  exactChildRemovalPreview,
  exactChildRemovalOperation,
  childRemovalEvidence,
  sameExternalDnsIntent,
  childExternalDnsPlanWithinParent,
  externalDnsZoneIntent,
  exactExternalDnsZone,
  externalDnsZoneEvidence,
});
