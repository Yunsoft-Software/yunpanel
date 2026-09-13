import { OPERATIONS } from '@yunpanel/protocol';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export class MailDeleteFinalizeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDeleteFinalizeError';
    this.code = code;
    this.status = status;
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailDeleteFinalizeError('mail_delete_revision_invalid', 'expectedRevision must be a positive integer');
  }
  return value;
}

function jobId(value) {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
    throw new MailDeleteFinalizeError('mail_delete_job_id_invalid', 'deleteJobId is invalid');
  }
  return value;
}

function confirmation(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 400 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MailDeleteFinalizeError('mail_delete_confirmation_invalid', 'Deletion confirmation is invalid');
  }
  return value;
}

function assertTerminalDeleteJob(job, {
  deleteJobId,
  mailDomainId,
  resourceId,
  expectedRevision,
  scope,
  identity,
}) {
  if (!job || job.id !== deleteJobId || job.status !== 'succeeded'
    || job.operation !== OPERATIONS.MAIL_DATA_DELETE
    || job.resourceType !== 'mail_domain' || job.resourceId !== mailDomainId
    || !job.result || job.result.transactionId !== deleteJobId
    || job.result.mailDomainId !== mailDomainId || job.result.resourceId !== resourceId
    || job.result.expectedResourceRevision !== expectedRevision
    || job.result.scope !== scope || job.result.identity !== identity
    || job.result.deleted !== true || job.result.sideEffects !== true) {
    throw new MailDeleteFinalizeError(
      'mail_delete_job_mismatch',
      'Completed mail data delete job does not match the requested resource revision',
      409,
    );
  }
  return job.result;
}

function assertImpact(impact, {
  resourceType,
  resourceId,
  expectedRevision,
  expectedConfirmation,
}) {
  if (!impact || impact.resourceType !== resourceType || impact.resourceId !== resourceId
    || impact.revision !== expectedRevision || impact.confirmation !== expectedConfirmation
    || impact.safeToDelete !== true || !Array.isArray(impact.blockers) || impact.blockers.length !== 0
    || impact.mailData?.present !== false || impact.requiresDataBackup !== false) {
    throw new MailDeleteFinalizeError(
      'mail_delete_impact_not_clear',
      'Mail delete dependencies or live mail data changed before finalization',
      409,
    );
  }
  return impact;
}

export function createMailDeleteFinalizeService({
  mailboxRegistry,
  mailDomainRegistry,
  mailDeleteImpactService,
  jobRegistry,
} = {}) {
  if (!mailboxRegistry || typeof mailboxRegistry.getMailbox !== 'function'
    || typeof mailboxRegistry.deleteMailbox !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof mailDomainRegistry.deleteMailDomain !== 'function'
    || !mailDeleteImpactService || typeof mailDeleteImpactService.inspectMailbox !== 'function'
    || typeof mailDeleteImpactService.inspectMailDomain !== 'function'
    || !jobRegistry || typeof jobRegistry.getJob !== 'function') {
    throw new MailDeleteFinalizeError(
      'mail_delete_finalize_dependencies_invalid',
      'Mail delete finalization dependencies are unavailable',
      503,
    );
  }

  async function terminal(id) {
    let job;
    try { job = await jobRegistry.getJob(jobId(id)); }
    catch {
      throw new MailDeleteFinalizeError('mail_delete_job_unavailable', 'Mail data delete job could not be read', 503);
    }
    return job;
  }

  async function finalizeMailbox({ mailboxId, expectedRevision, deleteJobId, confirmation: requestedConfirmation } = {}) {
    const expected = revision(expectedRevision);
    const confirmed = confirmation(requestedConfirmation);
    const mailbox = await mailboxRegistry.getMailbox(mailboxId);
    if (!mailbox) throw new MailDeleteFinalizeError('mailbox_not_found', 'Mailbox was not found', 404);
    if (mailbox.revision !== expected) {
      throw new MailDeleteFinalizeError('stale_mailbox_revision', 'Mailbox state changed before deletion finalization', 409);
    }
    const result = assertTerminalDeleteJob(await terminal(deleteJobId), {
      deleteJobId,
      mailDomainId: mailbox.mailDomainId,
      resourceId: mailbox.id,
      expectedRevision: expected,
      scope: 'mailbox',
      identity: mailbox.address,
    });
    assertImpact(await mailDeleteImpactService.inspectMailbox(mailbox.id), {
      resourceType: 'mailbox',
      resourceId: mailbox.id,
      expectedRevision: expected,
      expectedConfirmation: confirmed,
    });
    await mailboxRegistry.deleteMailbox(mailbox.id, {
      expectedRevision: expected,
      confirmation: confirmed,
    });
    return Object.freeze({
      id: mailbox.id,
      resourceType: 'mailbox',
      deleted: true,
      deleteJobId,
      backupId: result.backupId,
    });
  }

  async function finalizeMailDomain({ mailDomainId, expectedRevision, deleteJobId, confirmation: requestedConfirmation } = {}) {
    const expected = revision(expectedRevision);
    const confirmed = confirmation(requestedConfirmation);
    const mailDomain = await mailDomainRegistry.getMailDomain(mailDomainId);
    if (!mailDomain) throw new MailDeleteFinalizeError('mail_domain_not_found', 'Mail domain was not found', 404);
    if (mailDomain.revision !== expected) {
      throw new MailDeleteFinalizeError('mail_domain_revision_conflict', 'Mail domain state changed before deletion finalization', 409);
    }
    const result = assertTerminalDeleteJob(await terminal(deleteJobId), {
      deleteJobId,
      mailDomainId: mailDomain.id,
      resourceId: mailDomain.id,
      expectedRevision: expected,
      scope: 'domain',
      identity: mailDomain.domainName,
    });
    assertImpact(await mailDeleteImpactService.inspectMailDomain(mailDomain.id), {
      resourceType: 'mail_domain',
      resourceId: mailDomain.id,
      expectedRevision: expected,
      expectedConfirmation: confirmed,
    });
    await mailDomainRegistry.deleteMailDomain(mailDomain.id, {
      expectedRevision: expected,
      confirmation: confirmed,
    });
    return Object.freeze({
      id: mailDomain.id,
      resourceType: 'mail_domain',
      deleted: true,
      deleteJobId,
      backupId: result.backupId,
    });
  }

  return Object.freeze({ finalizeMailbox, finalizeMailDomain });
}

export const mailDeleteFinalizeInternals = Object.freeze({
  revision,
  jobId,
  confirmation,
  assertTerminalDeleteJob,
  assertImpact,
});
