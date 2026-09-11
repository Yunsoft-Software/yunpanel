import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATIONS } from '@yunpanel/protocol';
import { normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const DEFAULT_ROOT = '/var/lib/yunpanel/recovery/certificates';
const SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const RECEIPT_KEYS = new Set([
  'version', 'recordedAt', 'serverId', 'jobId', 'certificateId', 'operation', 'certName', 'domains',
  'staging', 'dryRun', 'status', 'fingerprint256', 'validFrom', 'validTo',
]);

export class CertificateOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CertificateOperationReceiptError';
    this.code = code;
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CertificateOperationReceiptError('certificate_receipt_identity_invalid', `${label} identity is invalid`);
  }
  return value.toLowerCase();
}

function domains(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 21) {
    throw new CertificateOperationReceiptError('certificate_receipt_domains_invalid', 'Certificate receipt domains are invalid');
  }
  try {
    const normalized = value.map((domain) => {
      if (typeof domain !== 'string') throw new Error('invalid');
      if (domain.startsWith('*.')) return `*.${normalizeDomainSet(domain.slice(2), []).primary}`;
      if (domain.includes('*')) throw new Error('invalid');
      return normalizeDomainSet(domain, []).primary;
    });
    if (new Set(normalized).size !== normalized.length || normalized[0].startsWith('*.')) throw new Error('invalid');
    return normalized;
  } catch {
    throw new CertificateOperationReceiptError('certificate_receipt_domains_invalid', 'Certificate receipt domains are invalid');
  }
}

function isoDate(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CertificateOperationReceiptError('certificate_receipt_metadata_invalid', `${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function productionEvidence(value) {
  if (typeof value.fingerprint256 !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint256)) {
    throw new CertificateOperationReceiptError('certificate_receipt_metadata_invalid', 'Certificate fingerprint is invalid');
  }
  const validFrom = isoDate(value.validFrom, 'Certificate validFrom');
  const validTo = isoDate(value.validTo, 'Certificate validTo');
  if (Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new CertificateOperationReceiptError('certificate_receipt_metadata_invalid', 'Certificate validity window is invalid');
  }
  return { fingerprint256: value.fingerprint256.toUpperCase(), validFrom, validTo };
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))
    || value.version !== STORE_VERSION
    || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.serverId !== 'string' || !SERVER_ID_PATTERN.test(value.serverId)
    || ![OPERATIONS.SSL_ISSUE, OPERATIONS.SSL_RENEW].includes(value.operation)) {
    throw new CertificateOperationReceiptError('certificate_receipt_invalid', 'Certificate operation receipt metadata is invalid');
  }

  const jobId = uuid(value.jobId, 'job');
  const certificateId = uuid(value.certificateId, 'certificate');
  const certName = domains([value.certName])[0];

  if (value.operation === OPERATIONS.SSL_ISSUE) {
    const certificateDomains = domains(value.domains);
    if (certificateDomains[0] !== certName || typeof value.staging !== 'boolean' || value.dryRun !== null) {
      throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Certificate issue receipt variant is invalid');
    }
    if (value.staging) {
      if (value.status !== 'validated' || value.fingerprint256 !== null || value.validFrom !== null || value.validTo !== null) {
        throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Staging certificate receipt is invalid');
      }
      return Object.freeze({
        version: STORE_VERSION,
        recordedAt: value.recordedAt,
        serverId: value.serverId,
        jobId,
        certificateId,
        operation: value.operation,
        certName,
        domains: certificateDomains,
        staging: true,
        dryRun: null,
        status: 'validated',
        fingerprint256: null,
        validFrom: null,
        validTo: null,
      });
    }
    if (value.status !== 'issued') {
      throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Production issue receipt status is invalid');
    }
    return Object.freeze({
      version: STORE_VERSION,
      recordedAt: value.recordedAt,
      serverId: value.serverId,
      jobId,
      certificateId,
      operation: value.operation,
      certName,
      domains: certificateDomains,
      staging: false,
      dryRun: null,
      status: 'issued',
      ...productionEvidence(value),
    });
  }

  if (value.domains !== null || value.staging !== null || typeof value.dryRun !== 'boolean') {
    throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Certificate renewal receipt variant is invalid');
  }
  if (value.dryRun) {
    if (value.status !== 'validated' || value.fingerprint256 !== null || value.validFrom !== null || value.validTo !== null) {
      throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Certificate renewal dry-run receipt is invalid');
    }
    return Object.freeze({
      version: STORE_VERSION,
      recordedAt: value.recordedAt,
      serverId: value.serverId,
      jobId,
      certificateId,
      operation: value.operation,
      certName,
      domains: null,
      staging: null,
      dryRun: true,
      status: 'validated',
      fingerprint256: null,
      validFrom: null,
      validTo: null,
    });
  }
  if (value.status !== 'renewed') {
    throw new CertificateOperationReceiptError('certificate_receipt_variant_invalid', 'Certificate renewal receipt status is invalid');
  }
  return Object.freeze({
    version: STORE_VERSION,
    recordedAt: value.recordedAt,
    serverId: value.serverId,
    jobId,
    certificateId,
    operation: value.operation,
    certName,
    domains: null,
    staging: null,
    dryRun: false,
    status: 'renewed',
    ...productionEvidence(value),
  });
}

export function createCertificateOperationReceiptStore({ root = DEFAULT_ROOT, now = () => Date.now() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof now !== 'function') {
    throw new CertificateOperationReceiptError('certificate_receipt_dependencies_invalid', 'Certificate receipt store configuration is invalid');
  }

  function receiptPath(serverId, jobId) {
    if (typeof serverId !== 'string' || !SERVER_ID_PATTERN.test(serverId)) {
      throw new CertificateOperationReceiptError('certificate_receipt_identity_invalid', 'Server identity is invalid');
    }
    return path.join(root, serverId, `${uuid(jobId, 'job')}.json`);
  }

  async function write({ serverId, jobId, certificateId, operation, result }) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new CertificateOperationReceiptError('certificate_receipt_result_invalid', 'Certificate result is not safe recovery evidence');
    }
    const isIssue = operation === OPERATIONS.SSL_ISSUE;
    const isRenew = operation === OPERATIONS.SSL_RENEW;
    if (!isIssue && !isRenew) {
      throw new CertificateOperationReceiptError('certificate_receipt_operation_invalid', 'Certificate operation is not supported');
    }
    const receipt = normalize({
      version: STORE_VERSION,
      recordedAt: new Date(now()).toISOString(),
      serverId,
      jobId,
      certificateId,
      operation,
      certName: result.certName,
      domains: isIssue ? result.domains : null,
      staging: isIssue ? result.staging : null,
      dryRun: isRenew ? result.dryRun : null,
      status: result.status,
      fingerprint256: result.fingerprint256 ?? null,
      validFrom: result.validFrom ?? null,
      validTo: result.validTo ?? null,
    });

    const directory = path.join(root, receipt.serverId);
    const target = receiptPath(receipt.serverId, receipt.jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    return receipt;
  }

  async function read(serverId, jobId) {
    const target = receiptPath(serverId, jobId);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new CertificateOperationReceiptError('certificate_receipt_read_failed', 'Certificate recovery receipt could not be read');
    }
    return normalize(parsed);
  }

  return Object.freeze({ write, read, receiptPath });
}

export const certificateOperationReceiptInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  defaultRoot: DEFAULT_ROOT,
  normalize,
});
