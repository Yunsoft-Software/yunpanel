import { createHash } from 'node:crypto';
import { normalizeMailboxAddress } from '@yunpanel/config-templates';
import { normalizeDomainSet } from '@yunpanel/shared';

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,160}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const LOCAL_STATUSES = new Set(['disabled', 'enabled']);
const EXTERNAL_STATUSES = new Set(['unverified', 'ready', 'degraded']);

export class MailDomainRemovalPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalPlanError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message = 'Mail Domain removal dependency evidence is invalid') {
  return new MailDomainRemovalPlanError('mail_domain_removal_plan_invalid', message, 409);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw invalid(`${field} is invalid`);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw invalid(`${field} is invalid`);
  return value;
}

function revision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${field} is invalid`);
  return value;
}

function canonicalDomain(value) {
  let canonical;
  try { canonical = normalizeDomainSet(value, []).primary; }
  catch { throw invalid('Mail Domain name is invalid'); }
  if (canonical !== value) throw invalid('Mail Domain name is not canonical');
  return canonical;
}

function mailboxAddress(value, domainName, field) {
  let normalized;
  try { normalized = normalizeMailboxAddress(value); }
  catch { throw invalid(`${field} is invalid`); }
  if (normalized.address !== value || normalized.domain !== domainName) {
    throw invalid(`${field} does not belong to the Mail Domain`);
  }
  return normalized.address;
}

function sourceMailDomain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['local', 'external'].includes(value.managementMode)
    || (value.managementMode === 'local' && !LOCAL_STATUSES.has(value.status))
    || (value.managementMode === 'external' && !EXTERNAL_STATUSES.has(value.status))) {
    throw invalid('Mail Domain lifecycle evidence is invalid');
  }
  return Object.freeze({
    id: safeId(value.id, 'mailDomainId'),
    webDomainId: safeId(value.webDomainId, 'webDomainId'),
    domainName: canonicalDomain(value.domainName),
    managementMode: value.managementMode,
    status: value.status,
    revision: revision(value.revision, 'mailDomainRevision'),
    updatedAt: timestamp(value.updatedAt, 'mailDomainUpdatedAt'),
  });
}

function webDomain(value, source, localServerId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || safeId(value.id, 'webDomainId') !== source.webDomainId
    || canonicalDomain(value.primaryDomain) !== source.domainName
    || (localServerId !== null && value.serverId !== localServerId)) {
    throw new MailDomainRemovalPlanError(
      'mail_domain_not_found',
      'Mail Domain was not found on the local server',
      404,
    );
  }
  return Object.freeze({ id: value.id, serverId: safeId(value.serverId, 'serverId') });
}

function mailboxIntent(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.mailDomainId !== source.id || typeof value.enabled !== 'boolean') {
    throw invalid('Mailbox removal evidence is invalid');
  }
  return Object.freeze({
    id: safeId(value.id, 'mailboxId'),
    address: mailboxAddress(value.address, source.domainName, 'mailboxAddress'),
    enabled: value.enabled,
    revision: revision(value.revision, 'mailboxRevision'),
    updatedAt: timestamp(value.updatedAt, 'mailboxUpdatedAt'),
  });
}

function aliasIntent(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.mailDomainId !== source.id || typeof value.enabled !== 'boolean') {
    throw invalid('Mail alias removal evidence is invalid');
  }
  return Object.freeze({
    id: safeId(value.id, 'mailAliasId'),
    source: mailboxAddress(value.source, source.domainName, 'mailAliasSource'),
    enabled: value.enabled,
    revision: revision(value.revision, 'mailAliasRevision'),
    updatedAt: timestamp(value.updatedAt, 'mailAliasUpdatedAt'),
  });
}

function mailboxPolicyIntent(value, mailboxIds, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !mailboxIds.has(value.mailboxId)) throw invalid(`${kind} removal evidence is invalid`);
  return Object.freeze({
    mailboxId: safeId(value.mailboxId, 'mailboxId'),
    revision: revision(value.revision, `${kind}Revision`),
    updatedAt: timestamp(value.updatedAt, `${kind}UpdatedAt`),
  });
}

function dkimIntent(value, source) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.mailDomainId !== source.id || value.domainName !== source.domainName
    || typeof value.selector !== 'string' || !value.selector) {
    throw invalid('DKIM removal evidence is invalid');
  }
  return Object.freeze({
    mailDomainId: source.id,
    domainName: source.domainName,
    selector: value.selector,
    revision: revision(value.revision, 'mailDkimRevision'),
    updatedAt: timestamp(value.updatedAt, 'mailDkimUpdatedAt'),
  });
}

function mailDataIntent(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.scope !== 'domain' || value.identity !== source.domainName
    || typeof value.present !== 'boolean' || !Number.isSafeInteger(value.bytes) || value.bytes < 0
    || typeof value.snapshotSha256 !== 'string' || !SHA256_PATTERN.test(value.snapshotSha256)
    || value.sideEffects !== false) throw invalid('Mail data removal evidence is invalid');
  return Object.freeze({
    present: value.present,
    bytes: value.bytes,
    snapshotSha256: value.snapshotSha256,
  });
}

function unique(values, identity, label) {
  const keys = values.map(identity);
  if (new Set(keys).size !== keys.length) throw invalid(`${label} identities are not unique`);
  return Object.freeze(values);
}

function blocker(code, count) {
  return Object.freeze({ code, count });
}

export function createMailDomainRemovalPlanService({
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry,
  mailboxForwardingRegistry,
  mailDkimRegistry,
  mailConfigurationService,
  jobRegistry,
  mailDataInspector,
  roundcubeDomainMappingRegistry = null,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.listMailboxes !== 'function'
    || !mailAliasRegistry || typeof mailAliasRegistry.listAliases !== 'function'
    || !mailboxQuotaRegistry || typeof mailboxQuotaRegistry.listQuotas !== 'function'
    || !mailboxForwardingRegistry || typeof mailboxForwardingRegistry.listForwardings !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !mailConfigurationService || typeof mailConfigurationService.previewTransition !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || !mailDataInspector || typeof mailDataInspector.inspectDomain !== 'function'
    || (roundcubeDomainMappingRegistry !== null
      && typeof roundcubeDomainMappingRegistry.getRecordForMailDomain !== 'function')
    || (localServerId !== null && (typeof localServerId !== 'string' || !SAFE_ID.test(localServerId)))) {
    throw new MailDomainRemovalPlanError(
      'mail_domain_removal_plan_dependencies_invalid',
      'Mail Domain removal plan dependencies are unavailable',
      503,
    );
  }

  async function source(mailDomainId) {
    let candidate;
    try { candidate = await mailDomainRegistry.getMailDomain(safeId(mailDomainId, 'mailDomainId')); }
    catch (error) {
      if (error instanceof MailDomainRemovalPlanError) throw error;
      throw new MailDomainRemovalPlanError(
        'mail_domain_removal_plan_unavailable',
        'Mail Domain removal state could not be inspected',
        503,
      );
    }
    if (!candidate) throw new MailDomainRemovalPlanError('mail_domain_not_found', 'Mail Domain was not found', 404);
    const mailDomain = sourceMailDomain(candidate);
    let domain;
    try { domain = await domainRegistry.getDomain(mailDomain.webDomainId); }
    catch {
      throw new MailDomainRemovalPlanError(
        'mail_domain_removal_plan_unavailable',
        'Mail Domain binding could not be inspected',
        503,
      );
    }
    return Object.freeze({ mailDomain, domain: webDomain(domain, mailDomain, localServerId) });
  }

  async function inventory(mailDomain) {
    let mailboxes;
    let aliases;
    let quotas;
    let forwardings;
    let jobs;
    try {
      [mailboxes, aliases, quotas, forwardings, jobs] = await Promise.all([
        mailboxRegistry.listMailboxes({ mailDomainId: mailDomain.id }),
        mailAliasRegistry.listAliases({ mailDomainId: mailDomain.id }),
        mailboxQuotaRegistry.listQuotas(),
        mailboxForwardingRegistry.listForwardings(),
        jobRegistry.listJobs({ resourceType: 'mail_domain', resourceId: mailDomain.id }),
      ]);
    } catch {
      throw new MailDomainRemovalPlanError(
        'mail_domain_removal_plan_unavailable',
        'Mail Domain removal dependencies could not be inspected',
        503,
      );
    }
    if (![mailboxes, aliases, quotas, forwardings, jobs].every(Array.isArray)) {
      throw invalid('Mail Domain removal dependency inventory is invalid');
    }
    const mailboxIntents = unique(
      mailboxes.map((value) => mailboxIntent(value, mailDomain))
        .sort((left, right) => left.id.localeCompare(right.id)),
      (value) => value.id,
      'Mailbox',
    );
    const mailboxIds = new Set(mailboxIntents.map((value) => value.id));
    const aliasIntents = unique(
      aliases.map((value) => aliasIntent(value, mailDomain))
        .sort((left, right) => left.id.localeCompare(right.id)),
      (value) => value.id,
      'Mail alias',
    );
    const quotaIntents = unique(
      quotas.filter((value) => mailboxIds.has(value?.mailboxId))
        .map((value) => mailboxPolicyIntent(value, mailboxIds, 'mailboxQuota'))
        .sort((left, right) => left.mailboxId.localeCompare(right.mailboxId)),
      (value) => value.mailboxId,
      'Mailbox quota',
    );
    const forwardingIntents = unique(
      forwardings.filter((value) => mailboxIds.has(value?.mailboxId))
        .map((value) => mailboxPolicyIntent(value, mailboxIds, 'mailboxForwarding'))
        .sort((left, right) => left.mailboxId.localeCompare(right.mailboxId)),
      (value) => value.mailboxId,
      'Mailbox forwarding',
    );
    const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job?.status));
    if (activeJobs.some((job) => typeof job.id !== 'string' || !SAFE_ID.test(job.id))) {
      throw invalid('Active Mail Domain job evidence is invalid');
    }
    return Object.freeze({
      mailboxes: mailboxIntents,
      aliases: aliasIntents,
      quotas: quotaIntents,
      forwardings: forwardingIntents,
      activeJobIds: Object.freeze(activeJobs.map((job) => job.id).sort()),
    });
  }

  async function localEvidence(mailDomain) {
    let dkim;
    let data;
    let disableConfiguration;
    try {
      [dkim, data, disableConfiguration] = await Promise.all([
        mailDkimRegistry.getKey(mailDomain.id),
        mailDataInspector.inspectDomain(mailDomain.domainName),
        mailDomain.status === 'enabled'
          ? mailConfigurationService.previewTransition({
            mailDomainId: mailDomain.id,
            expectedRevision: mailDomain.revision,
            status: 'disabled',
          })
          : null,
      ]);
    } catch {
      throw new MailDomainRemovalPlanError(
        'mail_domain_removal_plan_unavailable',
        'Local Mail Domain removal evidence could not be inspected',
        503,
      );
    }
    let configuration = null;
    let blockerCount = 0;
    if (disableConfiguration !== null) {
      if (!disableConfiguration || typeof disableConfiguration !== 'object'
        || disableConfiguration.version !== 1
        || disableConfiguration.operation !== 'mail_configuration_apply'
        || disableConfiguration.mailDomainId !== mailDomain.id
        || disableConfiguration.expectedRevision !== mailDomain.revision
        || disableConfiguration.currentStatus !== 'enabled'
        || disableConfiguration.desiredStatus !== 'disabled'
        || !Array.isArray(disableConfiguration.blockers)
        || typeof disableConfiguration.previewDigest !== 'string'
        || !SHA256_PATTERN.test(disableConfiguration.previewDigest)
        || disableConfiguration.sideEffects !== false) {
        throw invalid('Mail configuration disable preview is invalid');
      }
      if (disableConfiguration.readyToApply === true
        && disableConfiguration.blockers.length === 0
        && typeof disableConfiguration.configuration?.sha256 === 'string'
        && SHA256_PATTERN.test(disableConfiguration.configuration.sha256)) {
        configuration = Object.freeze({
          previewDigest: disableConfiguration.previewDigest,
          configurationSha256: disableConfiguration.configuration.sha256,
        });
      } else {
        blockerCount = Math.max(disableConfiguration.blockers.length, 1);
      }
    }
    return Object.freeze({
      dkim: dkimIntent(dkim, mailDomain),
      mailData: mailDataIntent(data, mailDomain),
      disableConfiguration: configuration,
      disableConfigurationBlockerCount: blockerCount,
    });
  }

  async function preview({ mailDomainId, parentOperationId } = {}) {
    const parentId = safeId(parentOperationId, 'parentOperationId');
    const { mailDomain } = await source(mailDomainId);
    const dependencies = await inventory(mailDomain);
    const local = mailDomain.managementMode === 'local';
    const localState = local
      ? await localEvidence(mailDomain)
      : Object.freeze({
        dkim: null,
        mailData: null,
        disableConfiguration: null,
        disableConfigurationBlockerCount: 0,
      });
    const cleanupPlan = Object.freeze({
      version: 2,
      mailDomainId: mailDomain.id,
      mailboxes: dependencies.mailboxes,
      aliases: dependencies.aliases,
      quotas: dependencies.quotas,
      forwardings: dependencies.forwardings,
      dkim: localState.dkim,
      mailData: localState.mailData,
      disableConfiguration: localState.disableConfiguration,
    });
    const blockers = [];
    if (dependencies.activeJobIds.length > 0) {
      blockers.push(blocker('mail_domain_removal_job_active', dependencies.activeJobIds.length));
    }
    if (!local && (cleanupPlan.mailboxes.length > 0 || cleanupPlan.aliases.length > 0
      || cleanupPlan.quotas.length > 0 || cleanupPlan.forwardings.length > 0)) {
      blockers.push(blocker('external_mail_domain_local_dependencies',
        cleanupPlan.mailboxes.length + cleanupPlan.aliases.length
          + cleanupPlan.quotas.length + cleanupPlan.forwardings.length));
    }
    if (localState.disableConfigurationBlockerCount > 0) {
      blockers.push(blocker(
        'mail_domain_disable_configuration_not_ready',
        localState.disableConfigurationBlockerCount,
      ));
    }
    let webmailMapping = null;
    if (roundcubeDomainMappingRegistry) {
      try {
        webmailMapping = await roundcubeDomainMappingRegistry.getRecordForMailDomain(mailDomain.id);
      } catch {
        throw new MailDomainRemovalPlanError(
          'mail_domain_removal_plan_unavailable',
          'Roundcube domain mapping registry is unavailable',
          503,
        );
      }
    }
    if (webmailMapping && webmailMapping.state !== 'removed') {
      blockers.push(blocker('mail_domain_webmail_mapping_active', 1));
    }
    const planDigest = digest(cleanupPlan);
    const identity = Object.freeze({
      version: 1,
      operation: 'mail_domain_remove',
      mailDomain,
      parentOperationId: parentId,
      removalMethod: local ? 'local_verified_data_finalize' : 'external_metadata_unlink',
      planDigest,
      blockers: Object.freeze(blockers),
    });
    const previewDigest = digest(identity);
    const readyToStart = blockers.length === 0;
    return Object.freeze({
      ...identity,
      cleanupPlan,
      readyToStart,
      previewDigest,
      confirmation: readyToStart
        ? `remove-mail-domain:${mailDomain.id}:${parentId}:${previewDigest}`
        : null,
      sideEffects: false,
    });
  }

  return Object.freeze({ preview });
}

export const mailDomainRemovalPlanInternals = Object.freeze({
  digest,
  sourceMailDomain,
  mailboxIntent,
  aliasIntent,
  mailboxPolicyIntent,
  dkimIntent,
  mailDataIntent,
});
