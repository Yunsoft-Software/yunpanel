import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class MailDomainRemovalCleanupPhaseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalCleanupPhaseError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new MailDomainRemovalCleanupPhaseError(code, message, status);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function evidence(operation, cleanupEvidenceDigest = null) {
  return Object.freeze({
    disableJobId: operation.disableJobId,
    finalRevision: operation.finalRevision,
    cleanupEvidenceDigest,
    dataDeleteJobId: null,
    backupId: null,
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
  return outcome(operation, 'blocked', { error: Object.freeze({ code, message }) }, sideEffects);
}

function failed(operation, code, message, sideEffects) {
  return outcome(operation, 'failed', { error: Object.freeze({ code, message }) }, sideEffects);
}

function operationIdentity(operation) {
  const plan = operation?.cleanupPlan;
  const expectedFinalRevision = operation?.sourceRevision
    + (operation?.sourceStatus === 'enabled' ? 1 : 0);
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || typeof operation.id !== 'string' || !operation.id
    || operation.managementMode !== 'local'
    || !['enabled', 'disabled'].includes(operation.sourceStatus)
    || !Number.isSafeInteger(operation.sourceRevision) || operation.sourceRevision < 1
    || !Number.isSafeInteger(operation.finalRevision)
    || operation.finalRevision !== expectedFinalRevision
    || typeof operation.mailDomainId !== 'string' || !operation.mailDomainId
    || typeof operation.webDomainId !== 'string' || !operation.webDomainId
    || typeof operation.domainName !== 'string' || !operation.domainName
    || operation.status !== 'cleaning'
    || operation.cleanupEvidenceDigest !== null || operation.dataDeleteJobId !== null
    || operation.backupId !== null
    || typeof operation.planDigest !== 'string' || !SHA256_PATTERN.test(operation.planDigest)
    || !plan || plan.version !== 2 || plan.mailDomainId !== operation.mailDomainId
    || !Array.isArray(plan.mailboxes) || !Array.isArray(plan.aliases)
    || !Array.isArray(plan.quotas) || !Array.isArray(plan.forwardings)
    || digest(plan) !== operation.planDigest) {
    fail(
      'mail_domain_removal_cleanup_operation_invalid',
      'Mail Domain removal cleanup operation is invalid',
    );
  }
  return operation;
}

function exactMailbox(current, pinned, mailDomainId) {
  return Boolean(current
    && current.id === pinned.id
    && current.mailDomainId === mailDomainId
    && current.address === pinned.address
    && current.enabled === pinned.enabled
    && current.revision === pinned.revision
    && current.updatedAt === pinned.updatedAt);
}

function exactAlias(current, pinned, mailDomainId) {
  return Boolean(current
    && current.id === pinned.id
    && current.mailDomainId === mailDomainId
    && current.source === pinned.source
    && current.enabled === pinned.enabled
    && current.revision === pinned.revision
    && current.updatedAt === pinned.updatedAt);
}

function exactPolicy(current, pinned) {
  return Boolean(current
    && current.mailboxId === pinned.mailboxId
    && current.revision === pinned.revision
    && current.updatedAt === pinned.updatedAt);
}

function exactDkim(current, pinned) {
  return Boolean(current
    && current.mailDomainId === pinned.mailDomainId
    && current.domainName === pinned.domainName
    && current.selector === pinned.selector
    && current.revision === pinned.revision
    && current.updatedAt === pinned.updatedAt);
}

function sameIdentities(current, pinned, identity) {
  if (current.length !== pinned.length) return false;
  const currentIds = current.map(identity);
  const pinnedIds = pinned.map(identity);
  const pinnedIdentitySet = new Set(pinnedIds);
  return new Set(currentIds).size === currentIds.length
    && pinnedIdentitySet.size === pinnedIds.length
    && currentIds.every((value) => pinnedIdentitySet.has(value));
}

function cleanupDigest(operation) {
  const plan = operation.cleanupPlan;
  return digest({
    version: 1,
    operationId: operation.id,
    mailDomainId: operation.mailDomainId,
    planDigest: operation.planDigest,
    retainedMailboxIds: plan.mailboxes.map((mailbox) => mailbox.id),
    removedAliasIds: plan.aliases.map((alias) => alias.id),
    removedQuotaMailboxIds: plan.quotas.map((quota) => quota.mailboxId),
    removedForwardingMailboxIds: plan.forwardings.map((forwarding) => forwarding.mailboxId),
    removedDkim: plan.dkim === null ? null : Object.freeze({
      selector: plan.dkim.selector,
      revision: plan.dkim.revision,
    }),
  });
}

export function createMailDomainRemovalCleanupPhase({
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry,
  mailboxForwardingRegistry,
  mailDkimRegistry,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || !mailAliasRegistry || typeof mailAliasRegistry.listAliases !== 'function'
    || typeof mailAliasRegistry.deleteAlias !== 'function'
    || !mailboxQuotaRegistry || typeof mailboxQuotaRegistry.listQuotas !== 'function'
    || typeof mailboxQuotaRegistry.clearQuota !== 'function'
    || !mailboxForwardingRegistry || typeof mailboxForwardingRegistry.listForwardings !== 'function'
    || typeof mailboxForwardingRegistry.clearForwarding !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || typeof mailDkimRegistry.deleteKey !== 'function') {
    throw new MailDomainRemovalCleanupPhaseError(
      'mail_domain_removal_cleanup_dependencies_invalid',
      'Mail Domain removal cleanup phase dependencies are unavailable',
      503,
    );
  }

  async function currentState(operation) {
    let mailDomain;
    let domain;
    try {
      [mailDomain, domain] = await Promise.all([
        mailDomainRegistry.getMailDomain(operation.mailDomainId),
        domainRegistry.getDomain(operation.webDomainId),
      ]);
    } catch {
      fail(
        'mail_domain_removal_cleanup_state_unavailable',
        'Mail Domain cleanup state could not be inspected',
        503,
      );
    }
    if (!mailDomain || mailDomain.id !== operation.mailDomainId
      || mailDomain.webDomainId !== operation.webDomainId
      || mailDomain.domainName !== operation.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== 'disabled'
      || mailDomain.revision !== operation.finalRevision
      || !domain || domain.id !== operation.webDomainId
      || domain.primaryDomain !== operation.domainName
      || typeof domain.serverId !== 'string' || !domain.serverId
      || (localServerId !== null && domain.serverId !== localServerId)) {
      fail(
        'mail_domain_removal_cleanup_state_drift',
        'Mail Domain cleanup identity changed after removal approval',
      );
    }
  }

  async function inventory(operation) {
    let values;
    try {
      values = await Promise.all([
        mailboxRegistry.listMailboxes({ mailDomainId: operation.mailDomainId }),
        mailAliasRegistry.listAliases({ mailDomainId: operation.mailDomainId }),
        mailboxQuotaRegistry.listQuotas(),
        mailboxForwardingRegistry.listForwardings(),
        mailDkimRegistry.getKey(operation.mailDomainId),
      ]);
    } catch {
      fail(
        'mail_domain_removal_cleanup_inventory_unavailable',
        'Mail Domain cleanup inventory could not be inspected',
        503,
      );
    }
    const [mailboxes, aliases, allQuotas, allForwardings, dkim] = values;
    if (![mailboxes, aliases, allQuotas, allForwardings].every(Array.isArray)) {
      fail(
        'mail_domain_removal_cleanup_inventory_invalid',
        'Mail Domain cleanup inventory is invalid',
      );
    }
    const mailboxIds = new Set(operation.cleanupPlan.mailboxes.map((mailbox) => mailbox.id));
    return Object.freeze({
      mailboxes,
      aliases,
      quotas: allQuotas.filter((quota) => mailboxIds.has(quota?.mailboxId)),
      forwardings: allForwardings.filter((forwarding) => mailboxIds.has(forwarding?.mailboxId)),
      dkim,
    });
  }

  function assess(operation, current) {
    const plan = operation.cleanupPlan;
    if (!sameIdentities(current.mailboxes, plan.mailboxes, (mailbox) => mailbox.id)
      || current.mailboxes.some((mailbox) => {
        const pinned = plan.mailboxes.find((candidate) => candidate.id === mailbox.id);
        return !exactMailbox(mailbox, pinned, operation.mailDomainId);
      })) {
      return Object.freeze({ drift: 'mailbox' });
    }
    if (current.aliases.some((alias) => {
      const pinned = plan.aliases.find((candidate) => candidate.id === alias.id);
      return !pinned || !exactAlias(alias, pinned, operation.mailDomainId);
    })) return Object.freeze({ drift: 'alias' });
    if (current.quotas.some((quota) => {
      const pinned = plan.quotas.find((candidate) => candidate.mailboxId === quota.mailboxId);
      return !pinned || !exactPolicy(quota, pinned);
    })) return Object.freeze({ drift: 'quota' });
    if (current.forwardings.some((forwarding) => {
      const pinned = plan.forwardings.find(
        (candidate) => candidate.mailboxId === forwarding.mailboxId,
      );
      return !pinned || !exactPolicy(forwarding, pinned);
    })) return Object.freeze({ drift: 'forwarding' });
    if (plan.dkim === null ? current.dkim !== null
      : current.dkim !== null && !exactDkim(current.dkim, plan.dkim)) {
      return Object.freeze({ drift: 'dkim' });
    }
    return Object.freeze({
      drift: null,
      forwarding: plan.forwardings.find((pinned) => current.forwardings.some(
        (candidate) => candidate.mailboxId === pinned.mailboxId,
      )) ?? null,
      quota: plan.quotas.find((pinned) => current.quotas.some(
        (candidate) => candidate.mailboxId === pinned.mailboxId,
      )) ?? null,
      alias: plan.aliases.find((pinned) => current.aliases.some(
        (candidate) => candidate.id === pinned.id,
      )) ?? null,
      dkim: plan.dkim !== null && current.dkim !== null ? plan.dkim : null,
    });
  }

  async function inspectCurrent(operation) {
    await currentState(operation);
    return assess(operation, await inventory(operation));
  }

  function driftOutcome(operation, assessment, sideEffects) {
    return failed(
      operation,
      `mail_domain_removal_cleanup_${assessment.drift}_drift`,
      `Mail Domain ${assessment.drift} cleanup state changed after removal approval`,
      sideEffects,
    );
  }

  async function deleteNext(operation, assessment) {
    try {
      if (assessment.forwarding) {
        await mailboxForwardingRegistry.clearForwarding(assessment.forwarding.mailboxId, {
          expectedRevision: assessment.forwarding.revision,
          confirmation: `clear-mailbox-forwarding:${assessment.forwarding.mailboxId}`,
        });
        return;
      }
      if (assessment.quota) {
        await mailboxQuotaRegistry.clearQuota(assessment.quota.mailboxId, {
          expectedRevision: assessment.quota.revision,
          confirmation: `clear-mailbox-quota:${assessment.quota.mailboxId}`,
        });
        return;
      }
      if (assessment.alias) {
        await mailAliasRegistry.deleteAlias(assessment.alias.id, {
          expectedRevision: assessment.alias.revision,
          confirmation: `delete-mail-alias:${assessment.alias.source}`,
        });
        return;
      }
      if (assessment.dkim) {
        await mailDkimRegistry.deleteKey(operation.mailDomainId, {
          expectedRevision: assessment.dkim.revision,
          confirmation: `delete-mail-dkim:${operation.mailDomainId}:${assessment.dkim.selector}:${assessment.dkim.revision}`,
        });
      }
    } catch {
      fail(
        'mail_domain_removal_cleanup_mutation_failed',
        'Mail Domain cleanup mutation could not be committed',
        503,
      );
    }
  }

  function hasTarget(assessment) {
    return Boolean(assessment.forwarding || assessment.quota || assessment.alias || assessment.dkim);
  }

  async function execute(operationValue) {
    const operation = operationIdentity(operationValue);
    const assessment = await inspectCurrent(operation);
    if (assessment.drift !== null) return driftOutcome(operation, assessment, true);
    if (!hasTarget(assessment)) {
      return outcome(operation, 'advance', {
        status: 'backing_up',
        evidence: evidence(operation, cleanupDigest(operation)),
      }, true);
    }
    await deleteNext(operation, assessment);
    return outcome(operation, 'advance', {
      status: 'cleaning',
      evidence: evidence(operation),
    }, true);
  }

  async function inspect(operationValue) {
    const operation = operationIdentity(operationValue);
    const assessment = await inspectCurrent(operation);
    if (assessment.drift !== null) return driftOutcome(operation, assessment, false);
    if (hasTarget(assessment)) {
      return blocked(
        operation,
        'mail_domain_removal_cleanup_retry_required',
        'Mail Domain cleanup requires explicit continuation',
        false,
      );
    }
    return outcome(operation, 'advance', {
      status: 'backing_up',
      evidence: evidence(operation, cleanupDigest(operation)),
    }, false);
  }

  return Object.freeze({ execute, inspect });
}

export const mailDomainRemovalCleanupPhaseInternals = Object.freeze({
  digest,
  cleanupDigest,
  operationIdentity,
  exactMailbox,
  exactAlias,
  exactPolicy,
  exactDkim,
});
