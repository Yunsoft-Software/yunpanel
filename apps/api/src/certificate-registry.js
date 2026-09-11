import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const SHA256_FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const CERT_STATES = new Set(['pending', 'validating', 'validated', 'issuing', 'active', 'renewing', 'superseded', 'error']);

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

function validateCertificatePath(certName, value, expectedFile) {
  if (typeof value !== 'string') {
    throw new CertificateRegistryError('invalid_certificate_path', 'Certificate path metadata is invalid');
  }
  const expected = `/etc/letsencrypt/live/${certName}/${expectedFile}`;
  if (value !== expected) {
    throw new CertificateRegistryError('invalid_certificate_path', 'Certificate path is outside the managed Certbot directory');
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

  const returnedDomains = normalizeDomains(result.domains ?? certificate.domains);
  if (returnedDomains.join('\n') !== certificate.domains.join('\n')) {
    throw new CertificateRegistryError('certificate_domain_mismatch', 'Certificate domains do not match desired state', 409);
  }
}

export function createCertificateRegistry({ filePath = null, now = () => Date.now() } = {}) {
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
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.certificates)) {
          throw new Error('unsupported or invalid certificate registry state');
        }
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function createForDomain({ domainId, serverId, domains, email, staging = false, replaceExisting = false }) {
    await ensureInitialized();
    if (typeof domainId !== 'string' || !domainId) throw new CertificateRegistryError('invalid_domain', 'domainId is required');
    if (typeof serverId !== 'string' || !serverId) throw new CertificateRegistryError('invalid_server', 'serverId is required');

    const normalizedDomains = normalizeDomains(domains);
    const certName = normalizedDomains[0];
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
      email: validateEmail(email),
      staging: isValidation,
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
    assertResultIdentity(certificate, result);

    const validFrom = validateDate(result.validFrom, 'validFrom');
    const validTo = validateDate(result.validTo, 'validTo');
    if (Date.parse(validTo) <= Date.parse(validFrom)) {
      throw new CertificateRegistryError('invalid_certificate_metadata', 'Certificate validity window is invalid');
    }
    if (typeof result.fingerprint256 !== 'string' || !SHA256_FINGERPRINT.test(result.fingerprint256)) {
      throw new CertificateRegistryError('invalid_certificate_metadata', 'Certificate fingerprint is invalid');
    }

    const certificatePath = validateCertificatePath(certificate.certName, result.certificatePath, 'cert.pem');
    const fullchainPath = validateCertificatePath(certificate.certName, result.fullchainPath, 'fullchain.pem');
    const privateKeyPath = validateCertificatePath(certificate.certName, result.privateKeyPath, 'privkey.pem');
    const timestamp = new Date(now()).toISOString();
    for (const previous of state.certificates) {
      if (previous.id === certificate.id || previous.domainId !== certificate.domainId || previous.staging || previous.state !== 'active') continue;
      previous.state = 'superseded';
      previous.updatedAt = timestamp;
    }
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
    setState,
    markValidated,
    markActive,
    markFailed,
    getCertificate,
    getForDomain,
    listCertificates,
  };
}
