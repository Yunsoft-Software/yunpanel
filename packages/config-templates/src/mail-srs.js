import { createHash } from 'node:crypto';
import { normalizeDomainSet } from '@yunpanel/shared';
import { normalizeMailboxAddress } from './mail.js';

const POSTSRSD_DEFAULTS_PATH = '/etc/default/postsrsd';
const POSTSRSD_SECRET_PATH = '/etc/postsrsd.secret';
const POSTSRSD_SERVICE_UNIT = 'postsrsd.service';
const POSTSRSD_PACKAGE = 'postsrsd';
const POSTSRSD_USER = 'postsrsd';
const POSTSRSD_CHROOT = '/var/lib/postsrsd';
const LISTEN_ADDRESS = '127.0.0.1';
const FORWARD_PORT = 10001;
const REVERSE_PORT = 10002;
const SRS_REQUIREMENT = 'postsrsd_srs';
const POSTFIX_PARAMETERS = Object.freeze([
  Object.freeze({ name: 'recipient_canonical_classes', value: 'envelope_recipient,header_recipient' }),
  Object.freeze({ name: 'recipient_canonical_maps', value: `tcp:${LISTEN_ADDRESS}:${REVERSE_PORT}` }),
  Object.freeze({ name: 'sender_canonical_classes', value: 'envelope_sender' }),
  Object.freeze({ name: 'sender_canonical_maps', value: `tcp:${LISTEN_ADDRESS}:${FORWARD_PORT}` }),
]);

export class MailSrsTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSrsTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDomain(value, field) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new MailSrsTemplateError('invalid_mail_srs_domain', `${field} is invalid`); }
}

function canonicalDomains(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 10_000) {
    throw new MailSrsTemplateError('invalid_mail_srs_domains', 'Managed SRS domains are invalid');
  }
  const domains = [...new Set(values.map((value) => canonicalDomain(value, 'Managed mail domain')))].sort();
  if (domains.length !== values.length) {
    throw new MailSrsTemplateError('invalid_mail_srs_domains', 'Managed SRS domains must be unique');
  }
  return Object.freeze(domains);
}

function externalForwardingDestinations({ domains, forwardings = [] } = {}) {
  const localDomains = new Set(canonicalDomains(domains));
  if (!Array.isArray(forwardings) || forwardings.length > 10_000) {
    throw new MailSrsTemplateError('invalid_mail_srs_forwardings', 'Managed forwarding state is invalid');
  }
  const external = new Set();
  for (const policy of forwardings) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || !Array.isArray(policy.destinations) || policy.destinations.length < 1 || policy.destinations.length > 4) {
      throw new MailSrsTemplateError('invalid_mail_srs_forwarding', 'Managed forwarding policy is invalid');
    }
    for (const destination of policy.destinations) {
      let normalized;
      try { normalized = normalizeMailboxAddress(destination); }
      catch { throw new MailSrsTemplateError('invalid_mail_srs_forwarding_destination', 'Forwarding destination is invalid'); }
      if (!localDomains.has(normalized.domain)) external.add(normalized.address);
    }
  }
  return Object.freeze([...external].sort());
}

function renderPostSrsdDefaults({ srsDomain, domains } = {}) {
  const rewriteDomain = canonicalDomain(srsDomain, 'SRS rewrite domain');
  const localDomains = canonicalDomains(domains);
  return `SRS_DOMAIN=${rewriteDomain}\nSRS_SECRET=${POSTSRSD_SECRET_PATH}\nSRS_FORWARD_PORT=${FORWARD_PORT}\nSRS_REVERSE_PORT=${REVERSE_PORT}\nSRS_SEPARATOR==\nSRS_HASHLENGTH=4\nSRS_HASHMIN=4\nRUN_AS=${POSTSRSD_USER}\nSRS_LISTEN_ADDR=${LISTEN_ADDRESS}\nCHROOT=${POSTSRSD_CHROOT}\nSRS_EXCLUDE_DOMAINS=${localDomains.join(',')}\n`;
}

function mergePostfixParameters(parameters) {
  if (!Array.isArray(parameters)) {
    throw new MailSrsTemplateError('mail_srs_postfix_parameters_invalid', 'Managed Postfix parameters are invalid');
  }
  const byName = new Map();
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.value !== 'string'
      || byName.has(parameter.name)) {
      throw new MailSrsTemplateError('mail_srs_postfix_parameters_invalid', 'Managed Postfix parameters are invalid');
    }
    byName.set(parameter.name, Object.freeze({ ...parameter }));
  }
  for (const parameter of POSTFIX_PARAMETERS) {
    const existing = byName.get(parameter.name);
    if (existing && existing.value !== parameter.value) {
      throw new MailSrsTemplateError(
        'mail_srs_postfix_parameter_conflict',
        `Managed Postfix parameter ${parameter.name} conflicts with the SRS policy`,
      );
    }
    byName.set(parameter.name, parameter);
  }
  return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
}

export function enableManagedMailSrs(preview, { domains, forwardings = [], srsDomain } = {}) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || typeof preview.sha256 !== 'string'
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.postfixParameters)
    || !Array.isArray(preview.requirements)) {
    throw new MailSrsTemplateError('mail_srs_preview_invalid', 'Managed mail preview is invalid');
  }
  const externalDestinations = externalForwardingDestinations({ domains, forwardings });
  if (externalDestinations.length === 0) return preview;

  const defaultsContent = renderPostSrsdDefaults({ srsDomain, domains });
  const defaultsArtifact = Object.freeze({
    version: 1,
    path: POSTSRSD_DEFAULTS_PATH,
    sha256: sha256(defaultsContent),
    bytes: Buffer.byteLength(defaultsContent),
    content: defaultsContent,
    sensitive: false,
    sideEffects: false,
  });
  if (preview.artifacts.some((artifact) => artifact?.path === POSTSRSD_DEFAULTS_PATH)) {
    throw new MailSrsTemplateError('mail_srs_artifact_conflict', 'Managed mail preview already contains PostSRSd configuration');
  }
  const requirements = preview.requirements.includes(SRS_REQUIREMENT)
    ? Object.freeze([...preview.requirements])
    : Object.freeze([...preview.requirements, SRS_REQUIREMENT]);
  const artifacts = Object.freeze([...preview.artifacts, defaultsArtifact]);
  const postfixParameters = mergePostfixParameters(preview.postfixParameters);
  const srs = Object.freeze({
    required: true,
    rewriteDomain: canonicalDomain(srsDomain, 'SRS rewrite domain'),
    externalDestinationCount: externalDestinations.length,
    defaultsSha256: defaultsArtifact.sha256,
    secretPath: POSTSRSD_SECRET_PATH,
    serviceUnit: POSTSRSD_SERVICE_UNIT,
    packageName: POSTSRSD_PACKAGE,
    forwardEndpoint: `tcp:${LISTEN_ADDRESS}:${FORWARD_PORT}`,
    reverseEndpoint: `tcp:${LISTEN_ADDRESS}:${REVERSE_PORT}`,
  });
  const identity = {
    version: 1,
    baseSha256: preview.sha256,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    postfixParameters,
    requirements,
    srs,
  };
  return Object.freeze({
    ...preview,
    sha256: sha256(JSON.stringify(identity)),
    artifacts,
    postfixParameters,
    requirements,
    srs,
    readyToApply: false,
    sideEffects: false,
  });
}

export const mailSrsTemplatePolicy = Object.freeze({
  defaultsPath: POSTSRSD_DEFAULTS_PATH,
  secretPath: POSTSRSD_SECRET_PATH,
  serviceUnit: POSTSRSD_SERVICE_UNIT,
  packageName: POSTSRSD_PACKAGE,
  runtimeUser: POSTSRSD_USER,
  chroot: POSTSRSD_CHROOT,
  listenAddress: LISTEN_ADDRESS,
  forwardPort: FORWARD_PORT,
  reversePort: REVERSE_PORT,
  requirement: SRS_REQUIREMENT,
  postfixParameters: POSTFIX_PARAMETERS,
});

export const mailSrsTemplateInternals = Object.freeze({
  canonicalDomains,
  externalForwardingDestinations,
  renderPostSrsdDefaults,
  mergePostfixParameters,
});
