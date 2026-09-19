import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const INTENT_FIELDS = new Set([
  'adapter',
  'serverId',
  'websiteId',
  'webDomainId',
  'mailDomainId',
  'domainName',
  'hostname',
  'expectedMailDomainRevision',
]);

export class WebsiteWebmailCertificateProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteWebmailCertificateProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function normalizeIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'acme-webmail-certificate'
    || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.webDomainId ?? '')
    || !UUID_PATTERN.test(value.mailDomainId ?? '')
    || typeof value.domainName !== 'string' || !value.domainName
    || value.hostname !== `webmail.${value.domainName}`
    || value.expectedMailDomainRevision !== 2) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_intent_invalid',
      'Website webmail certificate provisioning intent is invalid',
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
    hostname: value.hostname,
    expectedMailDomainRevision: value.expectedMailDomainRevision,
  });
}

function normalizedEmail(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value)) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_acme_email_invalid',
      'Website webmail certificate ACME account email is invalid',
      503,
    );
  }
  return value.toLowerCase();
}

function namesDigest(hostname) {
  return createHash('sha256').update(JSON.stringify([hostname])).digest('hex');
}

function prerequisiteEvidence(operation, request) {
  const nginx = operation?.steps?.find((step) => step.id === 'nginx');
  if (nginx?.state !== 'succeeded'
    || !Array.isArray(nginx.intent?.acmeOnlyHostnames)
    || !nginx.intent.acmeOnlyHostnames.includes(request.hostname)) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_http01_routing_missing',
      'Webmail HTTP-01 routing is not proven by the Website provisioning operation',
      503,
    );
  }
  const dns = operation?.steps?.find((step) => step.id === 'mail_dns_reapply');
  if (dns?.state !== 'succeeded'
    || dns.intent?.webmailHostname !== request.hostname
    || dns.intent?.webDomainId !== request.webDomainId
    || dns.intent?.mailDomainId !== request.mailDomainId
    || dns.evidence?.satisfied !== true
    || dns.evidence.adapter !== 'powerdns-mail-reapply'
    || dns.evidence.webDomainId !== request.webDomainId
    || dns.evidence.mailDomainId !== request.mailDomainId
    || dns.evidence.webmailHostname !== request.hostname
    || !UUID_PATTERN.test(dns.evidence.dnsReapplyOperationId ?? '')) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_dns_routing_missing',
      'Webmail authoritative DNS routing is not proven by the Website provisioning operation',
      503,
    );
  }
  return Object.freeze({
    nginxChecksum: nginx.evidence?.checksum ?? null,
    dnsReapplyOperationId: dns.evidence.dnsReapplyOperationId,
  });
}

function operationCertificates(certificates, request, operationId) {
  if (!Array.isArray(certificates)) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_state_invalid',
      'Webmail certificate registry state is invalid',
      503,
    );
  }
  return certificates
    .filter((certificate) => (
      certificate?.domainId === request.webDomainId
      && certificate.serverId === request.serverId
      && certificate.provisioningOperationId === operationId
      && certificate.source === 'acme'
      && certificate.purpose === 'webmail'
      && certificate.staging === false
    ))
    .sort((left, right) => {
      const byTime = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
      return byTime !== 0 ? byTime : String(left.id ?? '').localeCompare(String(right.id ?? ''));
    });
}

function exactSuccessfulIssueJob(jobs, certificate, serverId) {
  if (!Array.isArray(jobs)) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_job_state_invalid',
      'Webmail certificate child job state is invalid',
      503,
    );
  }
  const succeeded = jobs.filter((job) => (
    job?.serverId === serverId
    && job.operation === OPERATIONS.SSL_ISSUE
    && job.resourceType === 'certificate'
    && job.resourceId === certificate.id
    && job.status === 'succeeded'
  ));
  if (succeeded.length !== 1) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_issue_evidence_missing',
      'Webmail certificate has no unique durable issue-job evidence',
      503,
    );
  }
  return succeeded[0];
}

function completionEvidence(certificate, domain, job, request, operationId, prerequisite) {
  if (!certificate
    || certificate.domainId !== request.webDomainId
    || certificate.serverId !== request.serverId
    || certificate.provisioningOperationId !== operationId
    || certificate.source !== 'acme'
    || certificate.purpose !== 'webmail'
    || certificate.renewalMode !== 'automatic'
    || certificate.state !== 'active'
    || certificate.staging !== false
    || JSON.stringify(certificate.domains) !== JSON.stringify([request.hostname])
    || JSON.stringify(certificate.certificateNames) !== JSON.stringify([request.hostname])
    || typeof certificate.fingerprint256 !== 'string'
    || !FINGERPRINT_PATTERN.test(certificate.fingerprint256)
    || typeof certificate.validTo !== 'string'
    || !Number.isFinite(Date.parse(certificate.validTo))
    || domain?.certificateId === certificate.id
    || !job || job.resourceId !== certificate.id || job.status !== 'succeeded') {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_evidence_invalid',
      'Webmail certificate completion evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: 'acme-webmail-certificate',
    certificateId: certificate.id,
    issueJobId: job.id,
    provisioningOperationId: operationId,
    hostname: request.hostname,
    certificateNamesSha256: namesDigest(request.hostname),
    fingerprint256: certificate.fingerprint256,
    validTo: certificate.validTo,
    dnsReapplyOperationId: prerequisite.dnsReapplyOperationId,
  });
}

async function defaultWaitForTerminalJob(jobRegistry, job, {
  timeoutMs = 11 * 60 * 1000,
  pollMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (!['succeeded', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await jobRegistry.getJob(job.id);
    if (!current) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_issue_job_missing',
        'Webmail certificate child job disappeared before completion',
        503,
      );
    }
  }
  if (!['succeeded', 'failed', 'cancelled'].includes(current.status)) {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_issue_job_pending',
      'Webmail certificate child job is still running',
      503,
    );
  }
  return current;
}

async function defaultWaitForActive(certificateRegistry, certificateId, {
  timeoutMs = 30_000,
  pollMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let certificate = await certificateRegistry.getCertificate(certificateId);
  while (certificate?.state !== 'active' && Date.now() < deadline) {
    if (certificate?.state === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    certificate = await certificateRegistry.getCertificate(certificateId);
  }
  return certificate;
}

export function createWebsiteWebmailCertificateProvisioningHandler({
  jobRegistry,
  certificateRegistry,
  domainRegistry,
  mailDomainRegistry,
  acmeEmail = null,
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
  waitForActive = (certificateId) => defaultWaitForActive(certificateRegistry, certificateId),
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || !certificateRegistry || typeof certificateRegistry.createForDomain !== 'function'
    || typeof certificateRegistry.setState !== 'function'
    || typeof certificateRegistry.getCertificate !== 'function'
    || typeof certificateRegistry.listCertificates !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.getMailDomain !== 'function'
    || typeof waitForTerminalJob !== 'function' || typeof waitForActive !== 'function') {
    throw new WebsiteWebmailCertificateProvisioningError(
      'website_webmail_certificate_dependencies_invalid',
      'Website webmail certificate provisioning dependencies are invalid',
      503,
    );
  }
  const accountEmail = normalizedEmail(acmeEmail);

  async function scope(request) {
    const [domain, mailDomain] = await Promise.all([
      domainRegistry.getDomain(request.webDomainId),
      mailDomainRegistry.getMailDomain(request.mailDomainId),
    ]);
    if (!domain || domain.id !== request.webDomainId
      || domain.serverId !== request.serverId
      || domain.websiteId !== request.websiteId
      || domain.primaryDomain !== request.domainName
      || domain.httpsMode !== 'managed'
      || domain.state !== 'active'
      || domain.desiredRevision !== domain.appliedRevision
      || domain.stagedRevision !== domain.desiredRevision
      || !UUID_PATTERN.test(domain.certificateId ?? '')) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_domain_drift',
        'Webmail certificate requires the active managed-HTTPS Website Domain',
      );
    }
    if (!mailDomain || mailDomain.id !== request.mailDomainId
      || mailDomain.webDomainId !== request.webDomainId
      || mailDomain.domainName !== request.domainName
      || mailDomain.managementMode !== 'local'
      || mailDomain.status !== 'enabled'
      || mailDomain.revision !== request.expectedMailDomainRevision) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_mail_domain_drift',
        'Webmail certificate requires the operation-owned enabled local Mail Domain',
      );
    }
    const selectedWebCertificate = await certificateRegistry.getCertificate(domain.certificateId);
    if (!selectedWebCertificate
      || selectedWebCertificate.domainId !== domain.id
      || selectedWebCertificate.serverId !== domain.serverId
      || (selectedWebCertificate.purpose ?? 'web') !== 'web'
      || selectedWebCertificate.state !== 'active') {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_web_tls_missing',
        'Webmail certificate requires the active Website web certificate selection',
        503,
      );
    }
    return Object.freeze({ domain, mailDomain });
  }

  async function issueJobs(certificate) {
    const jobs = await jobRegistry.listJobs({
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    if (!Array.isArray(jobs)) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_job_state_invalid',
        'Webmail certificate child job state is invalid',
        503,
      );
    }
    return jobs.filter((job) => job.operation === OPERATIONS.SSL_ISSUE);
  }

  async function currentOwnedCertificate(request, context) {
    const certificates = await certificateRegistry.listCertificates();
    const foreignLive = certificates.filter((certificate) => (
      certificate?.domainId === request.webDomainId
      && certificate.serverId === request.serverId
      && certificate.purpose === 'webmail'
      && certificate.provisioningOperationId !== context.operationId
      && !['error', 'retired', 'superseded'].includes(certificate.state)
      && certificate.staging === false
    ));
    if (foreignLive.length > 0) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_operation_conflict',
        'Website Domain has a live webmail certificate owned by another lifecycle',
      );
    }
    const owned = operationCertificates(certificates, request, context.operationId);
    const live = owned.filter((certificate) => !['error', 'retired'].includes(certificate.state));
    if (live.length > 1) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_operation_conflict',
        'Website provisioning owns multiple live webmail certificate candidates',
      );
    }
    return live.at(-1) ?? null;
  }

  async function inspect(context = {}) {
    const request = normalizeIntent(context.intent, context.websiteId);
    const prerequisite = prerequisiteEvidence(context.operation, request);
    const { domain } = await scope(request);
    const certificate = await currentOwnedCertificate(request, context);
    if (!certificate) {
      return Object.freeze({
        satisfied: false,
        reason: accountEmail
          ? 'website_webmail_certificate_issue_required'
          : 'website_webmail_certificate_acme_email_required',
      });
    }
    const jobs = await issueJobs(certificate);
    const successful = jobs.filter((job) => job.status === 'succeeded');
    if (certificate.state === 'active') {
      if (successful.length !== 1) {
        throw new WebsiteWebmailCertificateProvisioningError(
          'website_webmail_certificate_issue_evidence_missing',
          'Active webmail certificate is missing unique durable issue evidence',
          503,
        );
      }
      return completionEvidence(certificate, domain, successful[0], request, context.operationId, prerequisite);
    }
    if (certificate.state === 'error' || jobs.some((job) => ['failed', 'cancelled'].includes(job.status))) {
      return Object.freeze({ satisfied: false, reason: 'website_webmail_certificate_issue_failed' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_webmail_certificate_issue_pending' });
  }

  async function apply(context = {}) {
    const request = normalizeIntent(context.intent, context.websiteId);
    const prerequisite = prerequisiteEvidence(context.operation, request);
    const { domain } = await scope(request);
    let certificate = await currentOwnedCertificate(request, context);

    if (certificate?.state === 'active') {
      return completionEvidence(
        certificate,
        domain,
        exactSuccessfulIssueJob(await issueJobs(certificate), certificate, request.serverId),
        request,
        context.operationId,
        prerequisite,
      );
    }
    if (!accountEmail) {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_acme_email_required',
        'Configure YUNPANEL_ACME_EMAIL before retrying webmail certificate provisioning',
        503,
      );
    }
    if (!certificate) {
      certificate = await certificateRegistry.createForDomain({
        domainId: request.webDomainId,
        serverId: request.serverId,
        domains: [request.hostname],
        certificateNames: [request.hostname],
        challenge: { type: 'http-01' },
        email: accountEmail,
        staging: false,
        replaceExisting: false,
        provisioningOperationId: context.operationId,
        purpose: 'webmail',
      });
    }

    let jobs = await issueJobs(certificate);
    let child = jobs.find((job) => ['queued', 'running'].includes(job.status))
      ?? jobs.find((job) => job.status === 'succeeded')
      ?? null;
    if (!child) {
      child = await jobRegistry.enqueue({
        serverId: request.serverId,
        type: `website.webmail.ssl.issue:${context.operationId}`,
        operation: OPERATIONS.SSL_ISSUE,
        payload: {
          domains: [...certificate.certificateNames],
          email: certificate.email,
          staging: false,
        },
        resourceType: 'certificate',
        resourceId: certificate.id,
        idempotencyKey: `website.webmail.cert.issue:${context.operationId}:${certificate.id}`,
      });
      jobs = [...jobs, child];
    }
    if (certificate.state === 'pending') {
      certificate = await certificateRegistry.setState(certificate.id, 'issuing');
    }

    const terminal = await waitForTerminalJob(child);
    if (!terminal || terminal.status !== 'succeeded') {
      throw new WebsiteWebmailCertificateProvisioningError(
        'website_webmail_certificate_issue_failed',
        'Webmail certificate child job did not complete successfully',
        503,
      );
    }
    certificate = await waitForActive(certificate.id);
    return completionEvidence(certificate, domain, terminal, request, context.operationId, prerequisite);
  }

  return Object.freeze({ apply, inspect });
}

export const websiteWebmailCertificateProvisioningInternals = Object.freeze({
  normalizeIntent,
  normalizedEmail,
  namesDigest,
  prerequisiteEvidence,
  operationCertificates,
  exactSuccessfulIssueJob,
  completionEvidence,
  defaultWaitForTerminalJob,
  defaultWaitForActive,
});
