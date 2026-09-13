const MAX_REFERENCES = 50;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);

export class MailDeleteImpactError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDeleteImpactError';
    this.code = code;
    this.status = status;
  }
}

function summarize(items, idOf = (value) => value?.id) {
  const ids = [];
  for (const item of items) {
    const id = idOf(item);
    if (typeof id === 'string' && id && ids.length < MAX_REFERENCES) ids.push(id);
  }
  return Object.freeze({
    count: items.length,
    ids: Object.freeze(ids),
    truncated: items.length > ids.length,
  });
}

function blocker(code, count = 1) {
  return Object.freeze({ code, count });
}

export function createMailDeleteImpactService({
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry,
  mailboxForwardingRegistry,
  mailDkimRegistry,
  jobRegistry,
  mailDataInspector,
  localServerId = null,
} = {}) {
  if (!mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function' || typeof mailboxRegistry.listMailboxes !== 'function'
    || !mailAliasRegistry || typeof mailAliasRegistry.listAliases !== 'function'
    || !mailboxQuotaRegistry || typeof mailboxQuotaRegistry.getQuota !== 'function'
    || !mailboxForwardingRegistry || typeof mailboxForwardingRegistry.getForwarding !== 'function'
    || !mailDkimRegistry || typeof mailDkimRegistry.getKey !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function'
    || !mailDataInspector || typeof mailDataInspector.inspectMailbox !== 'function'
    || typeof mailDataInspector.inspectDomain !== 'function') {
    throw new MailDeleteImpactError(
      'mail_delete_impact_dependencies_invalid',
      'Mail delete impact dependencies are unavailable',
      503,
    );
  }

  async function scopedMailDomain(mailDomainId) {
    const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!mailDomain) throw new MailDeleteImpactError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (!mailDomain.webDomainId) {
      throw new MailDeleteImpactError('mail_domain_server_unavailable', 'Mail domain is not bound to a web Domain', 409);
    }
    const domain = await domainRegistry.getDomain(mailDomain.webDomainId);
    if (!domain || domain.primaryDomain !== mailDomain.domainName
      || (localServerId !== null && domain.serverId !== localServerId)) {
      throw new MailDeleteImpactError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    return Object.freeze({ mailDomain, domain });
  }

  async function activeMailJobs(mailDomainId) {
    const jobs = await jobRegistry.listJobs({ resourceType: 'mail_domain', resourceId: mailDomainId });
    if (!Array.isArray(jobs)) {
      throw new MailDeleteImpactError('mail_delete_job_state_unavailable', 'Mail job state could not be inspected', 503);
    }
    return jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  }

  async function inspectMailbox(mailboxId) {
    const mailbox = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailbox) throw new MailDeleteImpactError('mailbox_not_found', 'Mailbox was not found', 404);
    await scopedMailDomain(mailbox.mailDomainId);
    let quota;
    let forwarding;
    let aliases;
    let jobs;
    let data;
    try {
      [quota, forwarding, aliases, jobs, data] = await Promise.all([
        mailboxQuotaRegistry.getQuota(mailbox.id),
        mailboxForwardingRegistry.getForwarding(mailbox.id),
        mailAliasRegistry.listAliases({ mailDomainId: mailbox.mailDomainId }),
        activeMailJobs(mailbox.mailDomainId),
        mailDataInspector.inspectMailbox(mailbox.address),
      ]);
    } catch (error) {
      if (error instanceof MailDeleteImpactError) throw error;
      throw new MailDeleteImpactError('mail_delete_impact_unavailable', 'Mailbox delete impact could not be inspected', 503);
    }
    const aliasReferences = aliases.filter((alias) => alias.destinations?.includes(mailbox.address));
    const blockers = [];
    if (quota) blockers.push(blocker('mailbox_quota_configured'));
    if (forwarding) blockers.push(blocker('mailbox_forwarding_configured'));
    if (aliasReferences.length > 0) blockers.push(blocker('mailbox_alias_reference_configured', aliasReferences.length));
    if (jobs.length > 0) blockers.push(blocker('mail_domain_job_active', jobs.length));
    if (data.present) blockers.push(blocker('mail_data_backup_required'));
    return Object.freeze({
      version: 1,
      resourceType: 'mailbox',
      resourceId: mailbox.id,
      address: mailbox.address,
      revision: mailbox.revision,
      enabled: mailbox.enabled,
      dependencies: Object.freeze({
        quotaConfigured: Boolean(quota),
        forwardingConfigured: Boolean(forwarding),
        aliasReferences: summarize(aliasReferences),
        activeJobs: summarize(jobs),
      }),
      mailData: data,
      requiresDataBackup: data.present,
      safeToDelete: blockers.length === 0,
      blockers: Object.freeze(blockers),
      confirmation: `delete-mailbox:${mailbox.address}`,
      sideEffects: false,
    });
  }

  async function inspectMailDomain(mailDomainId) {
    const { mailDomain } = await scopedMailDomain(mailDomainId);
    let mailboxes;
    let aliases;
    let dkim;
    let jobs;
    let data;
    try {
      [mailboxes, aliases, dkim, jobs, data] = await Promise.all([
        mailboxRegistry.listMailboxes({ mailDomainId: mailDomain.id }),
        mailAliasRegistry.listAliases({ mailDomainId: mailDomain.id }),
        mailDkimRegistry.getKey(mailDomain.id),
        activeMailJobs(mailDomain.id),
        mailDataInspector.inspectDomain(mailDomain.domainName),
      ]);
    } catch (error) {
      if (error instanceof MailDeleteImpactError) throw error;
      throw new MailDeleteImpactError('mail_delete_impact_unavailable', 'Mail domain delete impact could not be inspected', 503);
    }
    const blockers = [];
    if (mailDomain.managementMode === 'local' && mailDomain.status !== 'disabled') {
      blockers.push(blocker('mail_domain_disable_required'));
    }
    if (mailboxes.length > 0) blockers.push(blocker('mail_domain_mailboxes_exist', mailboxes.length));
    if (aliases.length > 0) blockers.push(blocker('mail_domain_aliases_exist', aliases.length));
    if (dkim) blockers.push(blocker('mail_domain_dkim_key_exists'));
    if (jobs.length > 0) blockers.push(blocker('mail_domain_job_active', jobs.length));
    if (data.present) blockers.push(blocker('mail_data_backup_required'));
    return Object.freeze({
      version: 1,
      resourceType: 'mail_domain',
      resourceId: mailDomain.id,
      domainName: mailDomain.domainName,
      revision: mailDomain.revision,
      managementMode: mailDomain.managementMode,
      status: mailDomain.status,
      dependencies: Object.freeze({
        mailboxes: summarize(mailboxes),
        aliases: summarize(aliases),
        dkimConfigured: Boolean(dkim),
        activeJobs: summarize(jobs),
      }),
      mailData: data,
      requiresDataBackup: data.present,
      safeToDelete: blockers.length === 0,
      blockers: Object.freeze(blockers),
      confirmation: `delete-mail-domain:${mailDomain.id}:${mailDomain.revision}`,
      sideEffects: false,
    });
  }

  return Object.freeze({ inspectMailbox, inspectMailDomain });
}

export const mailDeleteImpactInternals = Object.freeze({
  maxReferences: MAX_REFERENCES,
  summarize,
});
