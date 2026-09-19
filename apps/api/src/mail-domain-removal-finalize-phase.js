import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDomainRemovalFinalizePhaseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalFinalizePhaseError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new MailDomainRemovalFinalizePhaseError(code, message, status);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidence(operation, overrides = {}) {
  return Object.freeze({
    disableJobId: operation.disableJobId,
    finalRevision: operation.finalRevision,
    cleanupEvidenceDigest: operation.cleanupEvidenceDigest,
    dataDeleteJobId: operation.dataDeleteJobId,
    backupId: operation.backupId,
    ...overrides,
  });
}

function outcome(operation, disposition, details, sideEffects) {
  return Object.freeze({
    version: 1,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    fromStatus: operation.status,
    disposition,
    sideEffects,
    ...details,
  });
}

function blocked(operation, code, message, sideEffects) {
  return outcome(operation, 'blocked', {
    error: Object.freeze({ code, message }),
  }, sideEffects);
}

function failed(operation, code, message, sideEffects) {
  return outcome(operation, 'failed', {
    error: Object.freeze({ code, message }),
  }, sideEffects);
}

function removed(operation, now, sideEffects) {
  return outcome(operation, 'removed', {
    deletedAt: new Date(now()).toISOString(),
  }, sideEffects);
}

function externalCleanupDigest(operation) {
  return digest({
    version: 1,
    operationId: operation.id,
    parentOperationId: operation.parentOperationId,
    mailDomainId: operation.mailDomainId,
    webDomainId: operation.webDomainId,
    domainName: operation.domainName,
    planDigest: operation.planDigest,
    removalMethod: 'external_metadata_unlink',
  });
}

function externalPlanIsEmpty(operation) {
  const plan = operation.cleanupPlan;
  return Boolean(plan
    && plan.version === 2
    && plan.mailDomainId === operation.mailDomainId
    && Array.isArray(plan.mailboxes) && plan.mailboxes.length === 0
    && Array.isArray(plan.aliases) && plan.aliases.length === 0
    && Array.isArray(plan.quotas) && plan.quotas.length === 0
    && Array.isArray(plan.forwardings) && plan.forwardings.length === 0
    && plan.dkim === null
    && plan.mailData === null
    && plan.disableConfiguration === null);
}

function operationIdentity(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || typeof operation.id !== 'string' || !operation.id
    || typeof operation.parentOperationId !== 'string' || !operation.parentOperationId
    || typeof operation.mailDomainId !== 'string' || !operation.mailDomainId
    || typeof operation.webDomainId !== 'string' || !operation.webDomainId
    || typeof operation.domainName !== 'string' || !operation.domainName
    || typeof operation.planDigest !== 'string' || !SHA256_PATTERN.test(operation.planDigest)
    || !['local', 'external'].includes(operation.managementMode)
    || !Number.isSafeInteger(operation.sourceRevision) || operation.sourceRevision < 1) {
    fail(
      'mail_domain_removal_finalize_operation_invalid',
      'Mail Domain removal finalization operation is invalid',
    );
  }

  if (operation.managementMode === 'external') {
    if (!['pending', 'finalizing'].includes(operation.status)
      || operation.removalMethod !== 'external_metadata_unlink'
      || !externalPlanIsEmpty(operation)
      || operation.disableJobId !== null
      || operation.dataDeleteJobId !== null
      || operation.backupId !== null
      || (operation.status === 'pending'
        && (operation.finalRevision !== null || operation.cleanupEvidenceDigest !== null))
      || (operation.status === 'finalizing'
        && (operation.finalRevision !== operation.sourceRevision
          || operation.cleanupEvidenceDigest !== externalCleanupDigest(operation)))) {
      fail(
        'mail_domain_removal_finalize_operation_invalid',
        'External Mail Domain removal finalization evidence is invalid',
      );
    }
    return operation;
  }

  const expectedFinalRevision = operation.sourceRevision
    + (operation.sourceStatus === 'enabled' ? 1 : 0);
  if (operation.status !== 'finalizing'
    || operation.removalMethod !== 'local_verified_data_finalize'
    || operation.finalRevision !== expectedFinalRevision
    || typeof operation.cleanupEvidenceDigest !== 'string'
    || !SHA256_PATTERN.test(operation.cleanupEvidenceDigest)
    || typeof operation.dataDeleteJobId !== 'string' || !operation.dataDeleteJobId
    || typeof operation.backupId !== 'string' || !operation.backupId) {
    fail(
      'mail_domain_removal_finalize_operation_invalid',
      'Local Mail Domain removal finalization evidence is invalid',
    );
  }
  return operation;
}

export function createMailDomainRemovalFinalizePhase({
  mailDomainRegistry,
  domainRegistry,
  mailDeleteFinalizeService,
  localServerId = null,
  now = () => Date.now(),
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.deleteMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailDeleteFinalizeService
    || typeof mailDeleteFinalizeService.finalizeMailDomain !== 'function'
    || typeof now !== 'function') {
    throw new MailDomainRemovalFinalizePhaseError(
      'mail_domain_removal_finalize_dependencies_invalid',
      'Mail Domain removal finalization dependencies are unavailable',
      503,
    );
  }

  async function domainIdentity(operation) {
    let domain;
    try { domain = await domainRegistry.getDomain(operation.webDomainId); }
    catch {
      fail(
        'mail_domain_removal_finalize_domain_unavailable',
        'Mail Domain web Domain could not be inspected',
        503,
      );
    }
    if (!domain || domain.id !== operation.webDomainId
      || domain.primaryDomain !== operation.domainName
      || typeof domain.serverId !== 'string' || !domain.serverId
      || (localServerId !== null && domain.serverId !== localServerId)) {
      fail(
        'mail_domain_removal_finalize_domain_drift',
        'Mail Domain web Domain changed after removal approval',
      );
    }
    return domain;
  }

  async function currentMailDomain(operation) {
    let mailDomain;
    try { mailDomain = await mailDomainRegistry.getMailDomain(operation.mailDomainId); }
    catch {
      fail(
        'mail_domain_removal_finalize_state_unavailable',
        'Mail Domain finalization state could not be inspected',
        503,
      );
    }
    return mailDomain;
  }

  function exactLocal(operation, mailDomain) {
    return Boolean(mailDomain
      && mailDomain.id === operation.mailDomainId
      && mailDomain.webDomainId === operation.webDomainId
      && mailDomain.domainName === operation.domainName
      && mailDomain.managementMode === 'local'
      && mailDomain.status === 'disabled'
      && mailDomain.revision === operation.finalRevision);
  }

  function exactExternal(operation, mailDomain) {
    return Boolean(mailDomain
      && mailDomain.id === operation.mailDomainId
      && mailDomain.webDomainId === operation.webDomainId
      && mailDomain.domainName === operation.domainName
      && mailDomain.managementMode === 'external'
      && mailDomain.status === operation.sourceStatus
      && mailDomain.revision === operation.sourceRevision
      && mailDomain.updatedAt === operation.sourceUpdatedAt);
  }

  async function executeExternal(operation) {
    await domainIdentity(operation);
    const mailDomain = await currentMailDomain(operation);
    if (mailDomain === null) return removed(operation, now(), true);
    if (!exactExternal(operation, mailDomain)) {
      return failed(
        operation,
        'mail_domain_removal_external_state_drift',
        'External Mail Domain changed after removal approval',
        true,
      );
    }
    if (operation.status === 'pending') {
      return outcome(operation, 'advance', {
        status: 'finalizing',
        evidence: evidence(operation, {
          finalRevision: operation.sourceRevision,
          cleanupEvidenceDigest: externalCleanupDigest(operation),
        }),
      }, true);
    }

    try {
      const result = await mailDomainRegistry.deleteMailDomain(operation.mailDomainId, {
        expectedRevision: operation.sourceRevision,
        confirmation: 'delete-mail-domain:' + operation.mailDomainId + ':' + operation.sourceRevision,
      });
      if (!result || result.deleted !== true || result.id !== operation.mailDomainId) {
        return failed(
          operation,
          'mail_domain_removal_external_unlink_unconfirmed',
          'External Mail Domain metadata unlink did not confirm deletion',
          true,
        );
      }
    } catch (error) {
      if (Number(error?.status) === 404) return removed(operation, now(), true);
      return failed(
        operation,
        typeof error?.code === 'string' ? error.code : 'mail_domain_removal_external_unlink_failed',
        typeof error?.message === 'string'
          ? error.message
          : 'External Mail Domain metadata unlink failed',
        true,
      );
    }
    return removed(operation, now(), true);
  }

  async function executeLocal(operation) {
    await domainIdentity(operation);
    const mailDomain = await currentMailDomain(operation);
    if (mailDomain === null) return removed(operation, now(), true);
    if (!exactLocal(operation, mailDomain)) {
      return failed(
        operation,
        'mail_domain_removal_finalize_state_drift',
        'Local Mail Domain changed before finalization',
        true,
      );
    }
    let result;
    try {
      result = await mailDeleteFinalizeService.finalizeMailDomain({
        mailDomainId: operation.mailDomainId,
        expectedRevision: operation.finalRevision,
        deleteJobId: operation.dataDeleteJobId,
        confirmation: 'delete-mail-domain:' + operation.mailDomainId + ':' + operation.finalRevision,
      });
    } catch (error) {
      if (Number(error?.status) === 404) return removed(operation, now(), true);
      return failed(
        operation,
        typeof error?.code === 'string' ? error.code : 'mail_domain_removal_finalize_failed',
        typeof error?.message === 'string'
          ? error.message
          : 'Mail Domain finalization failed',
        true,
      );
    }
    if (!result || result.deleted !== true
      || result.id !== operation.mailDomainId
      || result.deleteJobId !== operation.dataDeleteJobId
      || result.backupId !== operation.backupId) {
      return failed(
        operation,
        'mail_domain_removal_finalize_unconfirmed',
        'Mail Domain finalization did not confirm the pinned delete evidence',
        true,
      );
    }
    return removed(operation, now(), true);
  }

  async function execute(operationValue) {
    const operation = operationIdentity(operationValue);
    return operation.managementMode === 'external'
      ? executeExternal(operation)
      : executeLocal(operation);
  }

  async function inspect(operationValue) {
    const operation = operationIdentity(operationValue);
    if (operation.status !== 'finalizing') {
      fail(
        'mail_domain_removal_finalize_inspection_invalid',
        'Only an interrupted Mail Domain finalization can be inspected',
      );
    }
    await domainIdentity(operation);
    const mailDomain = await currentMailDomain(operation);
    if (mailDomain === null) return removed(operation, now(), false);
    const exact = operation.managementMode === 'external'
      ? exactExternal(operation, mailDomain)
      : exactLocal(operation, mailDomain);
    if (!exact) {
      return failed(
        operation,
        'mail_domain_removal_finalize_state_drift',
        'Mail Domain state changed during finalization',
        false,
      );
    }
    return blocked(
      operation,
      'mail_domain_removal_finalize_retry_required',
      'Mail Domain finalization requires explicit continuation',
      false,
    );
  }

  return Object.freeze({ execute, inspect });
}

export const mailDomainRemovalFinalizePhaseInternals = Object.freeze({
  digest,
  externalCleanupDigest,
  externalPlanIsEmpty,
  operationIdentity,
});
