import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 3;
const SHA256_FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CERT_STATES = new Set(['pending', 'validating', 'validated', 'issuing', 'active', 'renewing', 'superseded', 'error']);
const CERTIFICATE_SOURCES = new Set(['acme', 'custom']);
const RENEWAL_MODES = new Set(['automatic', 'manual']);

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

function publicCertificate(certificate) {
  return { ...certificate };
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
  if (!CERT_STATES.has(certificate.state) || !CERTIFICATE_SOURCES.has(certificate.source) || !RENEWAL_MODES.has(certificate.renewalMode)
    || (certificate.source === 'acme' && certificate.renewalMode !== 'automatic')
    || (certificate.source === 'custom' && certificate.renewalMode !== 'manual')) {
    throw new CertificateRegistryError('invalid_certificate_state', 'Persisted certificate source policy is invalid', 409);
  }
  if (certificate.source === 'custom' && (typeof certificate.id !== 'string' || !UUID_PATTERN.test(certificate.id))) {
    throw new CertificateRegistryError('invalid_certificate_state', 'Persisted custom certificate identity is invalid', 409);
  }
  certificate.challenge = normalizeChallenge(certificate.challenge, { custom: certificate.source === 'custom' });
  certificate.certificateNames = normalizeCertificateNames(certificate.certificateNames, certificate.challenge ?? { type: 'custom' });
  if (certificate.state !== 'pending' && certificate.state !== 'validating' && certificate.state !== 'validated'
    && certificate.state !== 'issuing' && certificate.state !== 'error') {
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
} = {}) {
  const roots = Object.freeze({
    acmeLiveRoot: safeAbsoluteRoot(acmeLiveRoot, '/etc/letsencrypt/live'),
    customRoot: safeAbsoluteRoot(customRoot, '/var/lib/yunpanel/control-plane/custom-certificates'),
  });
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;

    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (![1, 2, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.certificates)) {
          throw new Error('unsupported or invalid certificate registry state');
        }
        parsed.certificates.forEach((certificate) => hydrateCertificate(certificate, parsed.version, roots));
        state = parsed;
        state.version = STORE_VERSION;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createForDomain({
    domainId,
    serverId,
    domains,
    certificateNames = domains,
    challenge: requestedChallenge,
    email,
    staging = false,
    replaceExisting = false,
  }) {
    await ensureInitialized();
    if (typeof domainId !== 'string' || !domainId) throw new CertificateRegistryError('invalid_domain', 'domainId is required');
    if (typeof serverId !== 'string' || !serverId) throw new CertificateRegistryError('invalid_server', 'serverId is required');

    const normalizedDomains = normalizeDomains(domains);
    const challenge = normalizeChallenge(requestedChallenge);
    const normalizedCertificateNames = normalizeCertificateNames(certificateNames, challenge);
    const certName = normalizedCertificateNames[0];
    const isValidation = Boolean(staging);
    if (typeof replaceExisting !== 'boolean') {
      throw new CertificateRegistryError('invalid_certificate_replacement', 'Certificate replacement policy is invalid');
    }
    const existing = state.certificates.find((certificate) => {
      if (certificate.domainId !== domainId || ['error', 'superseded'].includes(certificate.state)) return false;
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
      materialDigest: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    state.certificates.push(certificate);
    await persist();
    return publicCertificate(certificate);
  }

  async function setState(certificateId, nextState) {
    await ensureInitialized();
    const certificate = requireCertificate(state, certificateId);
    const normalizedState = certificate.staging && nextState === 'issuing' ? 'validating' : nextState;
    if (!CERT_STATES.has(normalizedState)) throw new CertificateRegistryError('invalid_certificate_state', 'Certificate state is invalid');
    certificate.state = normalizedState;
    certificate.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicCertificate(certificate);
  }

  async function markValidated(certificateId, result) {
    await ensureInitialized();
    const certificate = requireCertificate(state, certificateId);
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
    await persist();
    return publicCertificate(certificate);
  }

  async function markActive(certificateId, result, { renewal = false } = {}) {
    await ensureInitialized();
    const certificate = requireCertificate(state, certificateId);
    if (certificate.staging) {
      return markValidated(certificateId, result);
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
    await persist();
    return publicCertificate(certificate);
  }

  async function registerCustom({
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
  } = {}) {
    await ensureInitialized();
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
      materialDigest: typeof materialDigest === 'string' && /^[a-f0-9]{64}$/.test(materialDigest) ? materialDigest : null,
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
    try {
      await persist();
    } catch (error) {
      state.certificates = state.certificates.filter((candidate) => candidate.id !== certificate.id);
      throw error;
    }
    return publicCertificate(certificate);
  }

  async function prepareSelection(certificateId) {
    await ensureInitialized();
    const certificate = requireCertificate(state, certificateId);
    if (certificate.staging || !['active', 'superseded'].includes(certificate.state)
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
      await persist();
    }
    return publicCertificate(certificate);
  }

  async function commitSelection(certificateId) {
    await ensureInitialized();
    const selected = requireCertificate(state, certificateId);
    if (selected.staging || selected.state !== 'active') {
      throw new CertificateRegistryError('certificate_not_selectable', 'Certificate is not selectable', 409);
    }
    const timestamp = new Date(now()).toISOString();
    let changed = false;
    for (const certificate of state.certificates) {
      if (certificate.id === selected.id || certificate.domainId !== selected.domainId || certificate.staging || certificate.state !== 'active') continue;
      certificate.state = 'superseded';
      certificate.updatedAt = timestamp;
      changed = true;
    }
    if (changed) await persist();
    return publicCertificate(selected);
  }

  async function markFailed(certificateId, errorCode) {
    await ensureInitialized();
    const certificate = requireCertificate(state, certificateId);
    certificate.state = 'error';
    certificate.lastError = typeof errorCode === 'string' ? errorCode.slice(0, 120) : 'certificate_operation_failed';
    certificate.updatedAt = new Date(now()).toISOString();
    await persist();
    return publicCertificate(certificate);
  }

  async function getCertificate(certificateId) {
    await ensureInitialized();
    const certificate = state.certificates.find((candidate) => candidate.id === certificateId);
    return certificate ? publicCertificate(certificate) : null;
  }

  async function getForDomain(domainId) {
    await ensureInitialized();
    const certificate = [...state.certificates].reverse().find((candidate) => candidate.domainId === domainId);
    return certificate ? publicCertificate(certificate) : null;
  }

  async function listCertificates() {
    await ensureInitialized();
    return state.certificates.map(publicCertificate);
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
    getCertificate,
    getForDomain,
    listCertificates,
  };
}

export const certificateRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  hydrateCertificate,
});
