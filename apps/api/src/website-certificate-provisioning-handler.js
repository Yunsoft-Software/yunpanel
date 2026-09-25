import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { websiteProvisioningJobAuthorization } from './website-provisioning-job-authorization.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const INTENT_FIELDS = new Set([
  'websiteId',
  'primaryDomainId',
  'primaryDomain',
  'aliases',
  'wwwDomainId',
  'wwwDomain',
]);

export class WebsiteCertificateProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteCertificateProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function normalizeIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.websiteId ?? '')
    || !UUID_PATTERN.test(value.primaryDomainId ?? '')
    || typeof value.primaryDomain !== 'string' || !value.primaryDomain
    || !Array.isArray(value.aliases)
    || value.aliases.some((alias) => typeof alias !== 'string' || !alias)
    || (value.wwwDomainId !== null && !UUID_PATTERN.test(value.wwwDomainId ?? ''))
    || (value.wwwDomain !== null && (typeof value.wwwDomain !== 'string' || !value.wwwDomain))) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_intent_invalid',
      'Website certificate provisioning intent is invalid',
      400,
    );
  }
  const routeNames = [value.primaryDomain, ...value.aliases];
  if (new Set(routeNames).size !== routeNames.length) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_intent_invalid',
      'Website certificate route names are not unique',
      400,
    );
  }
  if ((value.wwwDomainId === null) !== (value.wwwDomain === null)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_intent_invalid',
      'Website certificate www identity is incomplete',
      400,
    );
  }
  if (value.wwwDomain !== null && !routeNames.includes(value.wwwDomain)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_intent_invalid',
      'Website certificate www hostname is outside the routed certificate names',
      400,
    );
  }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    primaryDomainId: value.primaryDomainId.toLowerCase(),
    primaryDomain: value.primaryDomain,
    aliases: Object.freeze([...value.aliases]),
    wwwDomainId: value.wwwDomainId === null ? null : value.wwwDomainId.toLowerCase(),
    wwwDomain: value.wwwDomain,
    routeNames: Object.freeze(routeNames),
  });
}

function normalizedEmail(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_acme_email_invalid',
      'Website certificate ACME account email is invalid',
      503,
    );
  }
  return value.toLowerCase();
}

function certificateNamesDigest(names) {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex');
}

function operationCertificates(certificates, request, operationId, serverId) {
  if (!Array.isArray(certificates)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_state_invalid',
      'Website certificate registry state is invalid',
      503,
    );
  }
  return certificates
    .filter((certificate) => (
      certificate?.domainId === request.primaryDomainId
      && certificate.serverId === serverId
      && certificate.provisioningOperationId === operationId
      && certificate.source === 'acme'
      && (certificate.purpose ?? 'web') === 'web'
      && certificate.staging === false
    ))
    .sort((left, right) => {
      const byTime = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
      return byTime !== 0 ? byTime : String(left.id ?? '').localeCompare(String(right.id ?? ''));
    });
}

function exactSuccessfulIssueJob(jobs, certificate, serverId) {
  if (!Array.isArray(jobs)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_job_state_invalid',
      'Website certificate child job state is invalid',
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
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_issue_evidence_missing',
      'Website certificate has no unique durable issue-job evidence',
      503,
    );
  }
  return succeeded[0];
}

function completionEvidence(certificate, domain, job, request, operationId) {
  if (!certificate || certificate.id !== domain.certificateId
    || certificate.domainId !== request.primaryDomainId
    || certificate.serverId !== domain.serverId
    || certificate.provisioningOperationId !== operationId
    || certificate.source !== 'acme'
    || (certificate.purpose ?? 'web') !== 'web'
    || certificate.renewalMode !== 'automatic'
    || certificate.state !== 'active'
    || certificate.staging !== false
    || JSON.stringify(certificate.domains) !== JSON.stringify(request.routeNames)
    || JSON.stringify(certificate.certificateNames) !== JSON.stringify(request.routeNames)
    || typeof certificate.fingerprint256 !== 'string'
    || !FINGERPRINT_PATTERN.test(certificate.fingerprint256)
    || typeof certificate.validTo !== 'string'
    || !Number.isFinite(Date.parse(certificate.validTo))
    || !job || job.resourceId !== certificate.id || job.status !== 'succeeded') {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_evidence_invalid',
      'Website certificate completion evidence is invalid',
      503,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: 'acme-certificate',
    certificateId: certificate.id,
    issueJobId: job.id,
    provisioningOperationId: operationId,
    certificateNamesSha256: certificateNamesDigest(request.routeNames),
    fingerprint256: certificate.fingerprint256,
    validTo: certificate.validTo,
    attachedDomainRevision: domain.desiredRevision,
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
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_issue_job_missing',
        'Website certificate child job disappeared before completion',
        503,
      );
    }
  }
  if (!['succeeded', 'failed', 'cancelled'].includes(current.status)) {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_issue_job_pending',
      'Website certificate child job is still running',
      503,
    );
  }
  return current;
}

async function defaultWaitForAttachment({
  certificateRegistry,
  domainRegistry,
  certificateId,
  domainId,
  timeoutMs = 30_000,
  pollMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let certificate = await certificateRegistry.getCertificate(certificateId);
  let domain = await domainRegistry.getDomain(domainId);
  while ((certificate?.state !== 'active' || domain?.certificateId !== certificateId) && Date.now() < deadline) {
    if (certificate?.state === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    [certificate, domain] = await Promise.all([
      certificateRegistry.getCertificate(certificateId),
      domainRegistry.getDomain(domainId),
    ]);
  }
  return Object.freeze({ certificate, domain });
}

export function createWebsiteCertificateProvisioningHandler({
  jobRegistry,
  certificateRegistry,
  domainRegistry,
  acmeEmail = null,
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
  waitForAttachment = (input) => defaultWaitForAttachment({
    certificateRegistry,
    domainRegistry,
    ...input,
  }),
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function'
    || typeof jobRegistry.getJob !== 'function'
    || typeof jobRegistry.listJobs !== 'function'
    || !certificateRegistry || typeof certificateRegistry.createForDomain !== 'function'
    || typeof certificateRegistry.setState !== 'function'
    || typeof certificateRegistry.getCertificate !== 'function'
    || typeof certificateRegistry.listCertificates !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || typeof waitForTerminalJob !== 'function' || typeof waitForAttachment !== 'function') {
    throw new WebsiteCertificateProvisioningError(
      'website_certificate_dependencies_invalid',
      'Website certificate provisioning dependencies are invalid',
      503,
    );
  }
  const accountEmail = normalizedEmail(acmeEmail);

  async function scope(request) {
    const domain = await domainRegistry.getDomain(request.primaryDomainId);
    if (!domain
      || domain.id !== request.primaryDomainId
      || domain.websiteId !== request.websiteId
      || domain.primaryDomain !== request.primaryDomain
      || JSON.stringify(domain.aliases) !== JSON.stringify(request.aliases)
      || domain.httpsMode !== 'managed') {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_domain_drift',
        'Website certificate Domain ownership or routed names changed after provisioning planning',
      );
    }
    return domain;
  }

  async function issueJobs(certificate) {
    const jobs = await jobRegistry.listJobs({
      resourceType: 'certificate',
      resourceId: certificate.id,
    });
    if (!Array.isArray(jobs)) {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_job_state_invalid',
        'Website certificate child job state is invalid',
        503,
      );
    }
    return jobs.filter((job) => job.operation === OPERATIONS.SSL_ISSUE);
  }

  async function currentOwnedCertificate(request, context, domain) {
    const certificates = await certificateRegistry.listCertificates();
    const foreignLive = certificates.filter((certificate) => (
      certificate?.domainId === request.primaryDomainId
      && certificate.serverId === domain.serverId
      && certificate.provisioningOperationId !== context.operationId
      && (certificate.purpose ?? 'web') === 'web'
      && !['error', 'retired', 'superseded'].includes(certificate.state)
      && certificate.staging === false
    ));
    if (foreignLive.length > 0) {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_operation_conflict',
        'Website Domain has a live certificate owned by another lifecycle',
      );
    }
    const owned = operationCertificates(
      certificates,
      request,
      context.operationId,
      domain.serverId,
    );
    const live = owned.filter((certificate) => certificate.state !== 'error' && certificate.state !== 'retired');
    if (live.length > 1) {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_operation_conflict',
        'Website provisioning owns multiple live certificate candidates',
      );
    }
    return Object.freeze({ certificate: live.at(-1) ?? null, all: owned });
  }

  async function inspect(context = {}) {
    const request = normalizeIntent(context.intent, context.websiteId);
    const domain = await scope(request);
    const { certificate } = await currentOwnedCertificate(request, context, domain);
    if (!certificate) {
      return Object.freeze({
        satisfied: false,
        reason: accountEmail
          ? 'website_certificate_issue_required'
          : 'website_certificate_acme_email_required',
      });
    }

    const jobs = await issueJobs(certificate);
    const successful = jobs.filter((job) => job.status === 'succeeded');
    if (certificate.state === 'active' && domain.certificateId === certificate.id) {
      if (successful.length !== 1) {
        throw new WebsiteCertificateProvisioningError(
          'website_certificate_issue_evidence_missing',
          'Active Website certificate is missing unique durable issue evidence',
          503,
        );
      }
      return completionEvidence(certificate, domain, successful[0], request, context.operationId);
    }
    if (certificate.state === 'error' || jobs.some((job) => ['failed', 'cancelled'].includes(job.status))) {
      return Object.freeze({ satisfied: false, reason: 'website_certificate_issue_failed' });
    }
    return Object.freeze({ satisfied: false, reason: 'website_certificate_issue_pending' });
  }

  async function apply(context = {}) {
    const request = normalizeIntent(context.intent, context.websiteId);
    let domain = await scope(request);
    let { certificate } = await currentOwnedCertificate(request, context, domain);

    if (certificate?.state === 'active' && domain.certificateId === certificate.id) {
      return completionEvidence(
        certificate,
        domain,
        exactSuccessfulIssueJob(await issueJobs(certificate), certificate, domain.serverId),
        request,
        context.operationId,
      );
    }
    if (!accountEmail) {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_acme_email_required',
        'Configure YUNPANEL_ACME_EMAIL before retrying managed Website certificate provisioning',
        503,
      );
    }
    if (domain.certificateId !== null && domain.certificateId !== certificate?.id) {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_binding_conflict',
        'Website Domain already has a certificate owned by another lifecycle',
      );
    }
    if (!certificate) {
      if (domain.state !== 'active'
        || domain.desiredRevision !== domain.appliedRevision
        || domain.stagedRevision !== domain.desiredRevision) {
        throw new WebsiteCertificateProvisioningError(
          'website_certificate_http01_routing_not_ready',
          'Website HTTP routing must be active before HTTP-01 certificate issuance',
          503,
        );
      }
      certificate = await certificateRegistry.createForDomain({
        domainId: domain.id,
        serverId: domain.serverId,
        domains: request.routeNames,
        certificateNames: request.routeNames,
        challenge: { type: 'http-01' },
        email: accountEmail,
        staging: false,
        replaceExisting: domain.certificateId === null,
        provisioningOperationId: context.operationId,
        purpose: 'web',
      });
    }

    let jobs = await issueJobs(certificate);
    let child = jobs.find((job) => ['queued', 'running'].includes(job.status))
      ?? jobs.find((job) => job.status === 'succeeded')
      ?? null;
    if (!child) {
      child = await jobRegistry.enqueue({
        serverId: domain.serverId,
        type: `website.ssl.issue:${context.operationId}`,
        operation: OPERATIONS.SSL_ISSUE,
        payload: {
          domains: [...certificate.certificateNames],
          email: certificate.email,
          staging: false,
        },
        resourceType: 'certificate',
        resourceId: certificate.id,
        idempotencyKey: `website.cert.issue:${context.operationId}:${certificate.id}`,
        authorization: websiteProvisioningJobAuthorization(context),
      });
      jobs = [...jobs, child];
    }
    if (certificate.state === 'pending') {
      certificate = await certificateRegistry.setState(certificate.id, 'issuing');
    }

    const terminal = await waitForTerminalJob(child);
    if (!terminal || terminal.status !== 'succeeded') {
      throw new WebsiteCertificateProvisioningError(
        'website_certificate_issue_failed',
        'Website certificate child job did not complete successfully',
        503,
      );
    }
    const attached = await waitForAttachment({
      certificateId: certificate.id,
      domainId: domain.id,
    });
    certificate = attached?.certificate ?? await certificateRegistry.getCertificate(certificate.id);
    domain = attached?.domain ?? await domainRegistry.getDomain(domain.id);
    return completionEvidence(certificate, domain, terminal, request, context.operationId);
  }

  async function inspectCompensation() {
    return Object.freeze({ satisfied: true, retained: true });
  }

  async function compensate() {
    return Object.freeze({ satisfied: true, retained: true });
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteCertificateProvisioningInternals = Object.freeze({
  normalizeIntent,
  normalizedEmail,
  certificateNamesDigest,
  operationCertificates,
  exactSuccessfulIssueJob,
  completionEvidence,
  defaultWaitForTerminalJob,
  defaultWaitForAttachment,
});
