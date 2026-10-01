import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet, sanitizeLogMessage } from '@yunpanel/shared';
import { operationErrorDiagnosis } from './operation-diagnosis.js';
import { createProcessStoreLock } from './process-store-lock.js';

const STORE_VERSION = 8;
const SHA256_FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CERT_STATES = new Set([
  'pending', 'validating', 'validated', 'issuing', 'active', 'renewing', 'superseded',
  'retired', 'error',
]);
const CERTIFICATE_SOURCES = new Set(['acme', 'custom']);
const RENEWAL_MODES = new Set(['automatic', 'manual']);
const CERTIFICATE_PURPOSES = new Set(['web', 'webmail']);
const SAFE_OPERATION_ID = /^[A-Za-z0-9._:@-]{1,160}$/;

export class CertificateRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CertificateRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, certificates: [] };
}

function publicCertificate(certificate, { now = Date.now } = {}) {
  if (!certificate || typeof certificate !== 'object') return null;
  return {
    ...certificate,
    domains: [...certificate.domains],
    certificateNames: [...certificate.certificateNames],
    challenge: certificate.challenge ? { ...certificate.challenge } : null,
    lastReloadOutcome: certificate.lastReloadOutcome ? { ...certificate.lastReloadOutcome } : null,
    diagnosis: certificateDiagnosis(certificate, { now }),
  };
}

export function compareTlsPresentation(certificate, liveTls) {
  if (!certificate || typeof certificate !== 'object') {
    return Object.freeze({ matches: false, reason: 'certificate_record_required' });
  }
  if (!liveTls || typeof liveTls !== 'object') {
    return Object.freeze({ matches: false, reason: 'live_tls_presentation_required' });
  }

  const certFingerprint = typeof certificate.fingerprint256 === 'string'
    ? certificate.fingerprint256.toUpperCase()
    : null;
  const liveFingerprint = typeof liveTls.fingerprint256 === 'string'
    ? liveTls.fingerprint256.toUpperCase()
    : null;

  if (!certFingerprint || !SHA256_FINGERPRINT.test(certFingerprint)) {
    return Object.freeze({ matches: false, reason: 'stored_fingerprint_invalid' });
  }
  if (!liveFingerprint || !SHA256_FINGERPRINT.test(liveFingerprint)) {
    return Object.freeze({ matches: false, reason: 'live_fingerprint_invalid' });
  }

  if (certFingerprint !== liveFingerprint) {
    return Object.freeze({
      matches: false,
      reason: 'fingerprint_mismatch',
      expected: certFingerprint,
      actual: liveFingerprint,
    });
  }

  const certValidFrom = Date.parse(certificate.validFrom);
  const liveValidFrom = Date.parse(liveTls.validFrom);
  if (!Number.isFinite(certValidFrom) || !Number.isFinite(liveValidFrom) || certValidFrom !== liveValidFrom) {
    return Object.freeze({
      matches: false,
      reason: 'valid_from_mismatch',
      expected: certificate.validFrom ?? null,
      actual: liveTls.validFrom ?? null,
    });
  }

  const certValidTo = Date.parse(certificate.validTo);
  const liveValidTo = Date.parse(liveTls.validTo);
  if (!Number.isFinite(certValidTo) || !Number.isFinite(liveValidTo) || certValidTo !== liveValidTo) {
    return Object.freeze({
      matches: false,
      reason: 'valid_to_mismatch',
      expected: certificate.validTo ?? null,
      actual: liveTls.validTo ?? null,
    });
  }

  return Object.freeze({
    matches: true,
    fingerprint256: certFingerprint,
    validFrom: new Date(certValidFrom).toISOString(),
    validTo: new Date(certValidTo).toISOString(),
  });
}

export function certificateDiagnosis(certificate, { now = Date.now() } = {}) {
  if (!certificate || typeof certificate !== 'object') return null;
  if (certificate.state === 'error') return operationErrorDiagnosis('certificate', certificate.lastError);
  if (certificate.lastReloadOutcome && certificate.lastReloadOutcome.status !== 'succeeded') {
    const isPartial = certificate.lastReloadOutcome.status === 'partial';
    return Object.freeze({
      severity: 'warning',
      code: isPartial ? 'certificate_reload_partial' : 'certificate_reload_failed',
      message: isPartial
        ? `Certificate is valid, but ${certificate.lastReloadOutcome.service} reload completed partially.`
        : `Certificate is valid, but ${certificate.lastReloadOutcome.service} reload failed.`,
      action: 'Inspect service configuration logs and retry reload without regenerating certificate.',
    });
  }
  if (certificate.state === 'pending') {
    return Object.freeze({
      severity: 'action_required', code: 'certificate_queue_required',
      message: 'The certificate request has not entered host execution.',
      action: 'Retry queueing the certificate operation or inspect the protected job state.',
    });
  }
  if (certificate.state === 'validating' || certificate.state === 'issuing' || certificate.state === 'renewing') {
    return Object.freeze({
      severity: 'in_progress', code: `certificate_${certificate.state}`,
      message: `The certificate is ${certificate.state}.`,
      action: 'Wait for the durable certificate job to finish.',
    });
  }
  if (certificate.state === 'validated') {
    return Object.freeze({
      severity: 'info', code: 'certificate_validation_complete',
      message: 'The staging certificate challenge completed successfully.',
      action: 'Request a production certificate when DNS and routing are ready.',
    });
  }
  if (certificate.state === 'superseded') {
    return Object.freeze({
      severity: 'info', code: 'certificate_superseded',
      message: 'A newer certificate is selected for this Domain.',
      action: 'No action is required unless this certificate should be selected again.',
    });
  }
  if (certificate.state === 'retired') {
    return Object.freeze({
      severity: 'info', code: 'certificate_retired',
      message: 'The certificate was retired by Domain removal.',
      action: 'Retained certificate material follows the separate cleanup retention policy.',
    });
  }
  if (certificate.state === 'active' && certificate.validTo) {
    const expiresAt = Date.parse(certificate.validTo);
    const currentTime = typeof now === 'function' ? now() : now;
    if (!Number.isFinite(expiresAt) || !Number.isFinite(currentTime)) {
      return operationErrorDiagnosis('certificate', 'certificate_metadata_mismatch');
    }
    if (expiresAt <= currentTime) {
      return Object.freeze({
        severity: 'error', code: 'certificate_expired',
        message: 'The active certificate has expired.',
        action: certificate.renewalMode === 'automatic'
          ? 'Inspect renewal jobs and issue or select a valid replacement.'
          : 'Import or select a valid replacement certificate.',
      });
    }
    if (expiresAt - currentTime <= 30 * 24 * 60 * 60 * 1000) {
      return Object.freeze({
        severity: 'warning', code: 'certificate_expiring',
        message: 'The active certificate expires within 30 days.',
        action: certificate.renewalMode === 'automatic'
          ? 'Verify automatic renewal readiness and recent renewal jobs.'
          : 'Import or select a replacement certificate before expiry.',
      });
    }
  }
  return null;
}

export function certificatePublicView(certificate, { now = Date.now } = {}) {
  if (!certificate || typeof certificate !== 'object') return null;
  const challenge = certificate.challenge?.type === 'dns-01'
    ? Object.freeze({
      type: 'dns-01', provider: certificate.challenge.provider,
      credentialId: certificate.challenge.credentialId,
      dnsZoneId: certificate.challenge.dnsZoneId,
      propagationSeconds: certificate.challenge.propagationSeconds,
    })
    : certificate.challenge?.type === 'http-01' ? Object.freeze({ type: 'http-01' }) : null;
  return Object.freeze({
    id: certificate.id,
    domainId: certificate.domainId,
    serverId: certificate.serverId,
    source: certificate.source,
    purpose: certificate.purpose,
    renewalMode: certificate.renewalMode,
    state: certificate.state,
    certName: certificate.certName,
    domains: Object.freeze([...(certificate.domains ?? [])]),
    certificateNames: Object.freeze([...(certificate.certificateNames ?? certificate.domains ?? [])]),
    challenge,
    staging: certificate.staging === true,
    email: certificate.email ?? null,
    subject: typeof certificate.subject === 'string' ? sanitizeLogMessage(certificate.subject).message.slice(0, 500) : null,
    issuer: typeof certificate.issuer === 'string' ? sanitizeLogMessage(certificate.issuer).message.slice(0, 500) : null,
    subjectAltName: typeof certificate.subjectAltName === 'string'
      ? sanitizeLogMessage(certificate.subjectAltName).message.slice(0, 2000) : null,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint256: certificate.fingerprint256,
    lastValidatedAt: certificate.lastValidatedAt,
    lastIssuedAt: certificate.lastIssuedAt,
    lastRenewedAt: certificate.lastRenewedAt,
    lastImportedAt: certificate.lastImportedAt,
    retiredAt: certificate.retiredAt,
    materialPurgedAt: certificate.materialPurgedAt ?? null,
    lastReloadOutcome: certificate.lastReloadOutcome ? Object.freeze({ ...certificate.lastReloadOutcome }) : null,
    provisioningOperationId: certificate.provisioningOperationId ?? null,
    createdAt: certificate.createdAt,
    updatedAt: certificate.updatedAt,
    diagnosis: certificateDiagnosis(certificate, { now }),
  });
}

function safeAbsoluteRoot(value, fallback) {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate === path.parse(candidate).root || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new CertificateRegistryError('invalid_certificate_root', 'Certificate material root is invalid', 500);
  }
  return path.resolve(candidate);
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate domains are invalid');
  }

  try {
    const normalized = normalizeDomainSet(domains[0], domains.slice(1));
    return [normalized.primary, ...normalized.aliases];
  } catch {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate domains are invalid');
  }
}

function normalizeCertificateNames(domains, challenge) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate names are invalid');
  }
  let values;
  try {
    values = domains.map((domain) => {
      if (typeof domain !== 'string') throw new Error('invalid');
      if (domain.startsWith('*.')) return `*.${normalizeDomainSet(domain.slice(2), []).primary}`;
      if (domain.includes('*')) throw new Error('invalid');
      return normalizeDomainSet(domain, []).primary;
    });
  } catch {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate names are invalid');
  }
  if (new Set(values).size !== values.length || values[0].startsWith('*.')) {
    throw new CertificateRegistryError('invalid_certificate_domains', 'Certificate names are invalid');
  }
  if (values.some((domain) => domain.startsWith('*.')) && challenge.type !== 'dns-01') {
    throw new CertificateRegistryError('wildcard_not_supported', 'Wildcard certificates require DNS-01', 409);
  }
  return values;
}

function normalizeChallenge(value, { custom = false } = {}) {
  if (custom) {
    if (value !== null && value !== undefined) throw new CertificateRegistryError('invalid_certificate_challenge', 'Custom certificate challenge must be null');
    return null;
  }
  if (value === undefined || value === null) return Object.freeze({ type: 'http-01' });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CertificateRegistryError('invalid_certificate_challenge', 'Certificate challenge is invalid');
  }
  if (value.type === 'http-01' && Object.keys(value).length === 1) return Object.freeze({ type: 'http-01' });
  const fields = new Set(['type', 'provider', 'credentialId', 'dnsZoneId', 'propagationSeconds']);
  if (value.type !== 'dns-01' || value.provider !== 'cloudflare'
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.credentialId !== 'string' || !UUID_PATTERN.test(value.credentialId)
    || typeof value.dnsZoneId !== 'string' || !UUID_PATTERN.test(value.dnsZoneId)
    || !Number.isInteger(value.propagationSeconds) || value.propagationSeconds < 10 || value.propagationSeconds > 120) {
    throw new CertificateRegistryError('invalid_certificate_challenge', 'DNS certificate challenge is invalid');
  }
  return Object.freeze({
    type: 'dns-01', provider: 'cloudflare', credentialId: value.credentialId.toLowerCase(),
    dnsZoneId: value.dnsZoneId.toLowerCase(), propagationSeconds: value.propagationSeconds,
  });
}

function validateEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CertificateRegistryError('invalid_acme_email', 'ACME account email is invalid');
  }
  return email.toLowerCase();
}

function requireCertificate(state, certificateId) {
  const certificate = state.certificates.find((candidate) => candidate.id === certificateId);
  if (!certificate) throw new CertificateRegistryError('certificate_not_found', 'Certificate not found', 404);
  return certificate;
}

function validateCertificatePath(certificate, value, expectedFile, { acmeLiveRoot, customRoot }) {
  if (typeof value !== 'string') {
    throw new CertificateRegistryError('invalid_certificate_path', 'Certificate path metadata is invalid');
  }
  const directory = certificate.source === 'custom'
    ? path.join(customRoot, certificate.id)
    : path.join(acmeLiveRoot, certificate.certName);
  const expected = path.join(directory, expectedFile);
  if (value !== expected) {
    throw new CertificateRegistryError('invalid_certificate_path', 'Certificate path is outside its managed material directory');
  }
  return value;
}

function validateDate(value, fieldName) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CertificateRegistryError('invalid_certificate_metadata', `${fieldName} is invalid`);
  }
  return new Date(value).toISOString();
}

function assertResultIdentity(certificate, result) {
  if (!result || typeof result !== 'object') {
    throw new CertificateRegistryError('invalid_certificate_result', 'Certificate result is invalid');
  }
  if (result.certName !== certificate.certName) {
    throw new CertificateRegistryError('certificate_name_mismatch', 'Certificate name does not match desired state', 409);
  }

  const returnedDomains = normalizeCertificateNames(result.domains ?? certificate.certificateNames, certificate.challenge);
  if (returnedDomains.join('\n') !== certificate.certificateNames.join('\n')) {
    throw new CertificateRegistryError('certificate_domain_mismatch', 'Certificate domains do not match desired state', 409);
  }
}

function hydrateCertificate(certificate, sourceVersion, roots) {
  if (sourceVersion < 2) {
    certificate.source = 'acme';
    certificate.renewalMode = 'automatic';
    certificate.materialDigest = null;
    certificate.lastImportedAt = null;
  }
  if (sourceVersion < 3) {
    certificate.certificateNames = [...certificate.domains];
    certificate.challenge = certificate.source === 'acme' ? { type: 'http-01' } : null;
  }
  if (sourceVersion < 4) {
    certificate.retirementOperationId = null;
    certificate.retiredAt = null;
    certificate.retiredFromState = null;
    certificate.retiredFromUpdatedAt = null;
  }
  if (sourceVersion < 5) {
    certificate.provisioningOperationId = null;
  }
  if (sourceVersion < 6) {
    certificate.purpose = 'web';
  }
  if (sourceVersion < 7) {
    certificate.materialPurgedAt = null;
  }
  if (sourceVersion < 8) {
    certificate.lastReloadOutcome = null;
  }
  if (certificate.email === undefined) {
    certificate.email = null;
  }
  if (certificate.lastReloadOutcome !== null && certificate.lastReloadOutcome !== undefined && (
    typeof certificate.lastReloadOutcome !== 'object'
    || Array.isArray(certificate.lastReloadOutcome)
    || typeof certificate.lastReloadOutcome.service !== 'string'
    || !['succeeded', 'partial', 'failed'].includes(certificate.lastReloadOutcome.status)
    || typeof certificate.lastReloadOutcome.recordedAt !== 'string'
    || !Number.isFinite(Date.parse(certificate.lastReloadOutcome.recordedAt))
  )) {
    throw new CertificateRegistryError(
      'invalid_certificate_state',
      'Persisted certificate reload outcome evidence is invalid',
      409,
    );
  }
  if (certificate.materialPurgedAt !== null && (
    typeof certificate.materialPurgedAt !== 'string'
    || !Number.isFinite(Date.parse(certificate.materialPurgedAt))
    || new Date(certificate.materialPurgedAt).toISOString() !== certificate.materialPurgedAt
    || certificate.state !== 'retired'
  )) {
    throw new CertificateRegistryError(
      'invalid_certificate_state',
      'Persisted certificate material purge evidence is invalid',
      409,
    );
  }
  if (certificate.provisioningOperationId !== null
    && (typeof certificate.provisioningOperationId !== 'string'
      || !SAFE_OPERATION_ID.test(certificate.provisioningOperationId))) {
    throw new CertificateRegistryError(
      'invalid_certificate_state',
      'Persisted certificate provisioning ownership is invalid',
      409,
    );
  }
  if (!CERT_STATES.has(certificate.state) || !CERTIFICATE_SOURCES.has(certificate.source)
    || !CERTIFICATE_PURPOSES.has(certificate.purpose) || !RENEWAL_MODES.has(certificate.renewalMode)
    || (certificate.source === 'acme' && certificate.renewalMode !== 'automatic')
    || (certificate.source === 'custom' && certificate.renewalMode !== 'manual')) {
    throw new CertificateRegistryError('invalid_certificate_state', 'Persisted certificate source policy is invalid', 409);
  }
  if ((certificate.state === 'retired') !== (
    typeof certificate.retirementOperationId === 'string'
    && SAFE_OPERATION_ID.test(certificate.retirementOperationId)
    && typeof certificate.retiredAt === 'string'
    && Number.isFinite(Date.parse(certificate.retiredAt))
    && new Date(certificate.retiredAt).toISOString() === certificate.retiredAt
    && typeof certificate.retiredFromState === 'string'
    && CERT_STATES.has(certificate.retiredFromState)
    && certificate.retiredFromState !== 'retired'
    && typeof certificate.retiredFromUpdatedAt === 'string'
    && Number.isFinite(Date.parse(certificate.retiredFromUpdatedAt))
    && new Date(certificate.retiredFromUpdatedAt).toISOString() === certificate.retiredFromUpdatedAt
  ) || (certificate.state !== 'retired' && (
    certificate.retirementOperationId !== null || certificate.retiredAt !== null
    || certificate.retiredFromState !== null || certificate.retiredFromUpdatedAt !== null
  ))) {
    throw new CertificateRegistryError(
      'invalid_certificate_state',
      'Persisted certificate retirement evidence is invalid',
      409,
    );
  }
  if (certificate.source === 'custom' && (typeof certificate.id !== 'string' || !UUID_PATTERN.test(certificate.id))) {
    throw new CertificateRegistryError('invalid_certificate_state', 'Persisted custom certificate identity is invalid', 409);
  }
  certificate.challenge = normalizeChallenge(certificate.challenge, { custom: certificate.source === 'custom' });
  certificate.certificateNames = normalizeCertificateNames(certificate.certificateNames, certificate.challenge ?? { type: 'custom' });
  const materialState = certificate.state === 'retired'
    ? certificate.retiredFromState
    : certificate.state;
  if (materialState !== 'pending' && materialState !== 'validating' && materialState !== 'validated'
    && materialState !== 'issuing' && materialState !== 'error') {
    validateCertificatePath(certificate, certificate.certificatePath, 'cert.pem', roots);
    validateCertificatePath(certificate, certificate.fullchainPath, 'fullchain.pem', roots);
    validateCertificatePath(certificate, certificate.privateKeyPath, 'privkey.pem', roots);
  }
  return certificate;
}

export function createCertificateRegistry({
  filePath = null,
  now = () => Date.now(),
  acmeLiveRoot = '/etc/letsencrypt/live',
  customRoot = filePath ? path.join(path.dirname(filePath), 'custom-certificates') : '/var/lib/yunpanel/control-plane/custom-certificates',
  storeLockFactory = createProcessStoreLock,
} = {}) {
  const roots = Object.freeze({
    acmeLiveRoot: safeAbsoluteRoot(acmeLiveRoot, '/etc/letsencrypt/live'),
    customRoot: safeAbsoluteRoot(customRoot, '/var/lib/yunpanel/control-plane/custom-certificates'),
  });
  let state = emptyState();
  let initialized = false;
  let mutationTail = Promise.resolve();
  const toPublic = (certificate) => publicCertificate(certificate, { now });
  const storeLock = filePath ? storeLockFactory({
    filePath: path.resolve(filePath),
    now: typeof now === 'function' ? now : () => Date.now(),
  }) : null;

  async function persistDirect() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  async function reloadFromDisk() {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (![1, 2, 3, 4, 5, 6, 7, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.certificates)) {
        throw new Error('unsupported or invalid certificate registry state');
      }
      parsed.certificates.forEach((certificate) => hydrateCertificate(certificate, parsed.version, roots));
      state = parsed;
      state.version = STORE_VERSION;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function withStoreLock(action) {
    if (!storeLock) {
      const result = await action();
      if (filePath) await persistDirect();
      return result;
    }
    const operation = mutationTail.then(() => storeLock.withLock(async () => {
      await reloadFromDisk();
      const result = await action();
      await persistDirect();
      return result;
    }));
    mutationTail = operation.catch(() => {});
    return operation;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      await reloadFromDisk();
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function _createForDomain({
    domainId,
    serverId,
    domains,
    certificateNames = domains,
    challenge: requestedChallenge,
    email,
    staging = false,
    replaceExisting = false,
    provisioningOperationId = null,
    purpose = 'web',
  }) {
    if (typeof domainId !== 'string' || !domainId) throw new CertificateRegistryError('invalid_domain', 'domainId is required');
    if (typeof serverId !== 'string' || !serverId) throw new CertificateRegistryError('invalid_server', 'serverId is required');

    const normalizedDomains = normalizeDomains(domains);
    if (!CERTIFICATE_PURPOSES.has(purpose)) {
      throw new CertificateRegistryError('invalid_certificate_purpose', 'Certificate purpose is invalid');
    }
    const challenge = normalizeChallenge(requestedChallenge);
    const normalizedCertificateNames = normalizeCertificateNames(certificateNames, challenge);
    const certName = normalizedCertificateNames[0];
    const isValidation = Boolean(staging);
    if (typeof replaceExisting !== 'boolean') {
      throw new CertificateRegistryError('invalid_certificate_replacement', 'Certificate replacement policy is invalid');
    }
    if (provisioningOperationId !== null
      && (typeof provisioningOperationId !== 'string' || !SAFE_OPERATION_ID.test(provisioningOperationId))) {
      throw new CertificateRegistryError(
        'invalid_certificate_provisioning_operation',
        'Certificate provisioning operation identity is invalid',
      );
    }
    const existing = state.certificates.find((certificate) => {
      if (certificate.domainId !== domainId || certificate.purpose !== purpose
        || ['error', 'superseded', 'retired'].includes(certificate.state)) return false;
      if (!isValidation) {
        if (certificate.staging) return false;
        if (['pending', 'issuing', 'renewing'].includes(certificate.state)) return true;
        return !replaceExisting;
      }
      return certificate.staging === true && ['pending', 'validating'].includes(certificate.state);
    });
    if (existing) {
      throw new CertificateRegistryError(
        isValidation ? 'certificate_validation_in_progress' : 'certificate_exists',
        isValidation ? 'A certificate validation is already in progress' : 'Domain already has a managed production certificate record',
        409,
      );
    }

    const timestamp = new Date(now()).toISOString();
    const certificate = {
      id: randomUUID(),
      domainId,
      serverId,
      certName,
      domains: normalizedDomains,
      certificateNames: normalizedCertificateNames,
      challenge,
      email: validateEmail(email),
      staging: isValidation,
      source: 'acme',
      purpose,
      renewalMode: 'automatic',
      state: 'pending',
      certificatePath: null,
      fullchainPath: null,
      privateKeyPath: null,
      subject: null,
      issuer: null,
      subjectAltName: null,
      validFrom: null,
      validTo: null,
      fingerprint256: null,
      lastValidatedAt: null,
      lastIssuedAt: null,
      lastRenewedAt: null,
      lastImportedAt: null,
      provisioningOperationId,
      retirementOperationId: null,
      retiredAt: null,
      retiredFromState: null,
      retiredFromUpdatedAt: null,
      materialPurgedAt: null,
      materialDigest: null,
      lastReloadOutcome: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.certificates.push(certificate);
    return toPublic(certificate);
  }

  function _setState(certificateId, nextState) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state === 'retired') {
      throw new CertificateRegistryError('certificate_retired', 'Retired certificate state is immutable', 409);
    }
    const normalizedState = certificate.staging && nextState === 'issuing' ? 'validating' : nextState;
    if (!CERT_STATES.has(normalizedState) || normalizedState === 'retired') {
      throw new CertificateRegistryError('invalid_certificate_state', 'Certificate state is invalid');
    }
    certificate.state = normalizedState;
    certificate.updatedAt = new Date(now()).toISOString();
    return toPublic(certificate);
  }

  function _markValidated(certificateId, result) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state === 'retired') {
      throw new CertificateRegistryError('certificate_retired', 'Retired certificate state is immutable', 409);
    }
    if (!certificate.staging) {
      throw new CertificateRegistryError('validation_record_required', 'Only validation records can be marked validated', 409);
    }
    assertResultIdentity(certificate, result);
    if (result.status !== 'validated' || result.staging !== true) {
      throw new CertificateRegistryError('invalid_validation_result', 'ACME validation result is invalid');
    }

    const timestamp = new Date(now()).toISOString();
    certificate.state = 'validated';
    certificate.lastValidatedAt = timestamp;
    certificate.lastError = null;
    certificate.updatedAt = timestamp;
    return toPublic(certificate);
  }

  function _markActive(certificateId, result, { renewal = false } = {}) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state === 'retired') {
      throw new CertificateRegistryError('certificate_retired', 'Retired certificate state is immutable', 409);
    }
    if (certificate.staging) {
      return _markValidated(certificateId, result);
    }
    if (certificate.source !== 'acme') {
      throw new CertificateRegistryError('managed_certificate_required', 'Only managed ACME certificates can reconcile issue or renewal results', 409);
    }
    assertResultIdentity(certificate, result);

    const validFrom = validateDate(result.validFrom, 'validFrom');
    const validTo = validateDate(result.validTo, 'validTo');
    if (Date.parse(validTo) <= Date.parse(validFrom)) {
      throw new CertificateRegistryError('invalid_certificate_metadata', 'Certificate validity window is invalid');
    }
    if (typeof result.fingerprint256 !== 'string' || !SHA256_FINGERPRINT.test(result.fingerprint256)) {
      throw new CertificateRegistryError('invalid_certificate_metadata', 'Certificate fingerprint is invalid');
    }

    const certificatePath = validateCertificatePath(certificate, result.certificatePath, 'cert.pem', roots);
    const fullchainPath = validateCertificatePath(certificate, result.fullchainPath, 'fullchain.pem', roots);
    const privateKeyPath = validateCertificatePath(certificate, result.privateKeyPath, 'privkey.pem', roots);
    const timestamp = new Date(now()).toISOString();
    certificate.state = 'active';
    certificate.certificatePath = certificatePath;
    certificate.fullchainPath = fullchainPath;
    certificate.privateKeyPath = privateKeyPath;
    certificate.subject = typeof result.subject === 'string' ? result.subject.slice(0, 500) : null;
    certificate.issuer = typeof result.issuer === 'string' ? result.issuer.slice(0, 500) : null;
    certificate.subjectAltName = typeof result.subjectAltName === 'string' ? result.subjectAltName.slice(0, 2000) : null;
    certificate.validFrom = validFrom;
    certificate.validTo = validTo;
    certificate.fingerprint256 = result.fingerprint256.toUpperCase();
    certificate.lastError = null;
    certificate.updatedAt = timestamp;
    if (renewal) certificate.lastRenewedAt = timestamp;
    else certificate.lastIssuedAt = timestamp;
    return toPublic(certificate);
  }

  function _registerCustom({
    certificateId,
    domainId,
    serverId,
    domains,
    certificatePath,
    fullchainPath,
    privateKeyPath,
    subject,
    issuer,
    subjectAltName,
    validFrom,
    validTo,
    fingerprint256,
    materialDigest,
    purpose = 'web',
  } = {}) {
    if (typeof certificateId !== 'string' || !UUID_PATTERN.test(certificateId)) {
      throw new CertificateRegistryError('invalid_certificate_id', 'Custom certificate ID is invalid');
    }
    const id = certificateId.toLowerCase();
    if (state.certificates.some((candidate) => candidate.id === id)) {
      throw new CertificateRegistryError('certificate_identity_conflict', 'Certificate ID already exists', 409);
    }
    if (typeof domainId !== 'string' || !domainId) throw new CertificateRegistryError('invalid_domain', 'domainId is required');
    if (typeof serverId !== 'string' || !serverId) throw new CertificateRegistryError('invalid_server', 'serverId is required');
    const normalizedDomains = normalizeDomains(domains);
    if (!CERTIFICATE_PURPOSES.has(purpose)) {
      throw new CertificateRegistryError('invalid_certificate_purpose', 'Certificate purpose is invalid');
    }
    const timestamp = new Date(now()).toISOString();
    const certificate = {
      id,
      domainId,
      serverId,
      certName: normalizedDomains[0],
      domains: normalizedDomains,
      certificateNames: normalizedDomains,
      challenge: null,
      email: null,
      staging: false,
      source: 'custom',
      purpose,
      renewalMode: 'manual',
      state: 'active',
      certificatePath: null,
      fullchainPath: null,
      privateKeyPath: null,
      subject: typeof subject === 'string' ? subject.slice(0, 500) : null,
      issuer: typeof issuer === 'string' ? issuer.slice(0, 500) : null,
      subjectAltName: typeof subjectAltName === 'string' ? subjectAltName.slice(0, 2000) : null,
      validFrom: validateDate(validFrom, 'validFrom'),
      validTo: validateDate(validTo, 'validTo'),
      fingerprint256: typeof fingerprint256 === 'string' && SHA256_FINGERPRINT.test(fingerprint256)
        ? fingerprint256.toUpperCase()
        : null,
      lastValidatedAt: null,
      lastIssuedAt: null,
      lastRenewedAt: null,
      lastImportedAt: timestamp,
      provisioningOperationId: null,
      retirementOperationId: null,
      retiredAt: null,
      retiredFromState: null,
      retiredFromUpdatedAt: null,
      materialPurgedAt: null,
      materialDigest: typeof materialDigest === 'string' && /^[a-f0-9]{64}$/.test(materialDigest) ? materialDigest : null,
      lastReloadOutcome: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!certificate.fingerprint256 || !certificate.materialDigest
      || Date.parse(certificate.validTo) <= Date.parse(certificate.validFrom)) {
      throw new CertificateRegistryError('invalid_certificate_metadata', 'Custom certificate metadata is invalid');
    }
    certificate.certificatePath = validateCertificatePath(certificate, certificatePath, 'cert.pem', roots);
    certificate.fullchainPath = validateCertificatePath(certificate, fullchainPath, 'fullchain.pem', roots);
    certificate.privateKeyPath = validateCertificatePath(certificate, privateKeyPath, 'privkey.pem', roots);
    state.certificates.push(certificate);
    return toPublic(certificate);
  }

  function _prepareSelection(certificateId) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.purpose !== 'web' || certificate.staging || !['active', 'superseded'].includes(certificate.state)
      || !certificate.validTo || Date.parse(certificate.validTo) <= now()) {
      throw new CertificateRegistryError('certificate_not_selectable', 'Certificate is not selectable', 409);
    }
    validateCertificatePath(certificate, certificate.certificatePath, 'cert.pem', roots);
    validateCertificatePath(certificate, certificate.fullchainPath, 'fullchain.pem', roots);
    validateCertificatePath(certificate, certificate.privateKeyPath, 'privkey.pem', roots);
    if (certificate.state === 'superseded') {
      certificate.state = 'active';
      certificate.lastError = null;
      certificate.updatedAt = new Date(now()).toISOString();
    }
    return toPublic(certificate);
  }

  function _commitSelection(certificateId) {
    const selected = requireCertificate(state, certificateId);
    if (selected.purpose !== 'web' || selected.staging || selected.state !== 'active') {
      throw new CertificateRegistryError('certificate_not_selectable', 'Certificate is not selectable', 409);
    }
    const timestamp = new Date(now()).toISOString();
    for (const certificate of state.certificates) {
      if (certificate.id === selected.id || certificate.domainId !== selected.domainId
        || certificate.purpose !== 'web' || certificate.staging || certificate.state !== 'active') continue;
      certificate.state = 'superseded';
      certificate.updatedAt = timestamp;
    }
    return toPublic(selected);
  }

  function _markFailed(certificateId, errorCode) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state === 'retired') {
      throw new CertificateRegistryError('certificate_retired', 'Retired certificate state is immutable', 409);
    }
    certificate.state = 'error';
    certificate.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 120) : 'certificate_operation_failed';
    certificate.updatedAt = new Date(now()).toISOString();
    return toPublic(certificate);
  }

  function _retireForDomainRemoval(certificateId, {
    expectedDomainId,
    expectedServerId,
    expectedState,
    expectedSource,
    expectedRenewalMode,
    expectedStaging,
    expectedValidTo,
    expectedUpdatedAt,
    operationId,
  } = {}) {
    const certificate = requireCertificate(state, certificateId);
    if (typeof operationId !== 'string' || !SAFE_OPERATION_ID.test(operationId)) {
      throw new CertificateRegistryError(
        'certificate_retirement_operation_invalid',
        'Certificate retirement requires an exact Domain removal operation identity',
      );
    }
    if (certificate.state === 'retired') {
      if (certificate.domainId !== expectedDomainId
        || certificate.serverId !== expectedServerId
        || certificate.retirementOperationId !== operationId
        || certificate.retiredFromState !== expectedState
        || certificate.source !== expectedSource
        || certificate.renewalMode !== expectedRenewalMode
        || certificate.staging !== expectedStaging
        || (certificate.validTo ?? null) !== expectedValidTo
        || certificate.retiredFromUpdatedAt !== expectedUpdatedAt) {
        throw new CertificateRegistryError(
          'certificate_retirement_ownership_drift',
          'Certificate retirement is owned by different Domain removal evidence',
          409,
        );
      }
      return Object.freeze({ changed: false, certificate: toPublic(certificate) });
    }
    if (certificate.domainId !== expectedDomainId
      || certificate.serverId !== expectedServerId
      || certificate.state !== expectedState
      || certificate.source !== expectedSource
      || certificate.renewalMode !== expectedRenewalMode
      || certificate.staging !== expectedStaging
      || (certificate.validTo ?? null) !== expectedValidTo
      || certificate.updatedAt !== expectedUpdatedAt) {
      throw new CertificateRegistryError(
        'certificate_retirement_intent_drift',
        'Certificate state changed after Domain removal planning',
        409,
      );
    }
    const retiredAt = new Date(now()).toISOString();
    certificate.retiredFromState = certificate.state;
    certificate.retiredFromUpdatedAt = certificate.updatedAt;
    certificate.state = 'retired';
    certificate.retirementOperationId = operationId;
    certificate.retiredAt = retiredAt;
    certificate.lastError = null;
    certificate.updatedAt = retiredAt;
    return Object.freeze({ changed: true, certificate: toPublic(certificate) });
  }

  function _markMaterialPurged(certificateId, { purgedAt = new Date(now()).toISOString() } = {}) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state !== 'retired') {
      throw new CertificateRegistryError(
        'certificate_not_retired',
        'Only retired certificates can have material purged',
        409,
      );
    }
    const normalizedPurgedAt = validateDate(purgedAt, 'purgedAt');
    if (certificate.materialPurgedAt !== null) {
      return Object.freeze({ changed: false, certificate: toPublic(certificate) });
    }
    certificate.materialPurgedAt = normalizedPurgedAt;
    certificate.updatedAt = normalizedPurgedAt;
    return Object.freeze({ changed: true, certificate: toPublic(certificate) });
  }

  function _recordReloadOutcome(certificateId, outcome = {}) {
    const certificate = requireCertificate(state, certificateId);
    if (certificate.state === 'retired') {
      throw new CertificateRegistryError('certificate_retired', 'Retired certificate state is immutable', 409);
    }
    if (!outcome || typeof outcome !== 'object') {
      throw new CertificateRegistryError('invalid_reload_outcome', 'Reload outcome payload is invalid');
    }
    const { service, status, error = null, stage = 'reload' } = outcome;
    if (typeof service !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(service)) {
      throw new CertificateRegistryError('invalid_reload_outcome_service', 'Reload outcome service is invalid');
    }
    if (!['succeeded', 'partial', 'failed'].includes(status)) {
      throw new CertificateRegistryError('invalid_reload_outcome_status', 'Reload outcome status must be succeeded, partial, or failed');
    }
    if (typeof stage !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(stage)) {
      throw new CertificateRegistryError('invalid_reload_outcome_stage', 'Reload outcome stage is invalid');
    }
    const recordedAt = new Date(now()).toISOString();
    certificate.lastReloadOutcome = Object.freeze({
      service: service.toLowerCase(),
      status,
      stage: stage.toLowerCase(),
      error: typeof error === 'string' ? sanitizeLogMessage(error).message.slice(0, 200) : null,
      recordedAt,
    });
    certificate.updatedAt = recordedAt;
    return toPublic(certificate);
  }

  async function createForDomain(params) {
    await ensureInitialized();
    return withStoreLock(async () => _createForDomain(params));
  }

  async function setState(certificateId, nextState) {
    await ensureInitialized();
    return withStoreLock(async () => _setState(certificateId, nextState));
  }

  async function markValidated(certificateId, result) {
    await ensureInitialized();
    return withStoreLock(async () => _markValidated(certificateId, result));
  }

  async function markActive(certificateId, result, options) {
    await ensureInitialized();
    return withStoreLock(async () => _markActive(certificateId, result, options));
  }

  async function registerCustom(params) {
    await ensureInitialized();
    return withStoreLock(async () => _registerCustom(params));
  }

  async function prepareSelection(certificateId) {
    await ensureInitialized();
    return withStoreLock(async () => _prepareSelection(certificateId));
  }

  async function commitSelection(certificateId) {
    await ensureInitialized();
    return withStoreLock(async () => _commitSelection(certificateId));
  }

  async function markFailed(certificateId, errorCode) {
    await ensureInitialized();
    return withStoreLock(async () => _markFailed(certificateId, errorCode));
  }

  async function retireForDomainRemoval(certificateId, options) {
    await ensureInitialized();
    return withStoreLock(async () => _retireForDomainRemoval(certificateId, options));
  }

  async function markMaterialPurged(certificateId, options) {
    await ensureInitialized();
    return withStoreLock(async () => _markMaterialPurged(certificateId, options));
  }

  async function recordReloadOutcome(certificateId, outcome) {
    await ensureInitialized();
    return withStoreLock(async () => _recordReloadOutcome(certificateId, outcome));
  }

  async function verifyLiveTls(certificateId, liveTls) {
    await ensureInitialized();
    if (filePath) await reloadFromDisk();
    const certificate = requireCertificate(state, certificateId);
    return compareTlsPresentation(certificate, liveTls);
  }

  async function getCertificate(certificateId) {
    await ensureInitialized();
    if (filePath) await reloadFromDisk();
    const certificate = state.certificates.find((candidate) => candidate.id === certificateId);
    return certificate ? toPublic(certificate) : null;
  }

  async function getForDomain(domainId) {
    await ensureInitialized();
    if (filePath) await reloadFromDisk();
    const certificate = [...state.certificates].reverse().find((candidate) => (
      candidate.domainId === domainId && candidate.purpose === 'web'
    ));
    return certificate ? toPublic(certificate) : null;
  }

  async function listCertificates() {
    await ensureInitialized();
    if (filePath) await reloadFromDisk();
    return state.certificates.map(toPublic);
  }

  return {
    init,
    createForDomain,
    registerCustom,
    prepareSelection,
    commitSelection,
    setState,
    markValidated,
    markActive,
    markFailed,
    retireForDomainRemoval,
    markMaterialPurged,
    recordReloadOutcome,
    verifyLiveTls,
    getCertificate,
    getForDomain,
    listCertificates,
  };
}

export const certificateRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  certificatePurposes: Object.freeze([...CERTIFICATE_PURPOSES]),
  hydrateCertificate,
  compareTlsPresentation,
});
