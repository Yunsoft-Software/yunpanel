import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const CERTBOT_PATHS = Object.freeze(['/usr/bin/certbot', '/usr/local/bin/certbot']);
const DEFAULT_ACME_ROOT = '/var/lib/yunpanel/acme';
const DEFAULT_LIVE_ROOT = '/etc/letsencrypt/live';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AcmeManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AcmeManagerError';
    this.code = code;
  }
}

async function findExecutable(paths, accessFn = access) {
  for (const candidate of paths) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue through the fixed allowlist.
    }
  }
  return null;
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    throw new AcmeManagerError('invalid_certificate_domains', 'Certificate must contain between 1 and 21 domains');
  }

  try {
    const normalized = normalizeDomainSet(domains[0], domains.slice(1));
    const values = [normalized.primary, ...normalized.aliases];
    if (values.some((domain) => domain.includes('*'))) {
      throw new AcmeManagerError('wildcard_not_supported', 'Wildcard certificates require DNS-01 and are not supported in V1');
    }
    return values;
  } catch (error) {
    if (error instanceof AcmeManagerError) throw error;
    throw new AcmeManagerError('invalid_certificate_domains', 'Certificate domains are invalid');
  }
}

function validateEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AcmeManagerError('invalid_acme_email', 'ACME account email is invalid');
  }
  return email;
}

function certificatePaths(liveRoot, certName) {
  const safeName = normalizeDomainSet(certName, []).primary;
  const directory = path.join(liveRoot, safeName);
  return {
    certName: safeName,
    certificatePath: path.join(directory, 'cert.pem'),
    fullchainPath: path.join(directory, 'fullchain.pem'),
    privateKeyPath: path.join(directory, 'privkey.pem'),
  };
}

async function inspectCertificate({ liveRoot, certName, readFileFn = readFile }) {
  const paths = certificatePaths(liveRoot, certName);
  let pem;
  try {
    pem = await readFileFn(paths.certificatePath, 'utf8');
  } catch {
    throw new AcmeManagerError('certificate_not_found', 'Issued certificate metadata could not be read');
  }

  let certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new AcmeManagerError('invalid_certificate_file', 'Issued certificate file is invalid');
  }

  return {
    ...paths,
    subject: certificate.subject,
    issuer: certificate.issuer,
    subjectAltName: certificate.subjectAltName,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256,
  };
}

export function createAcmeManager({
  certbotPaths = CERTBOT_PATHS,
  acmeRoot = DEFAULT_ACME_ROOT,
  liveRoot = DEFAULT_LIVE_ROOT,
  accessFn = access,
  mkdirFn = mkdir,
  readFileFn = readFile,
  run = (file, args) => execFileAsync(file, args, {
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  }),
} = {}) {
  async function requireCertbot() {
    const executable = await findExecutable(certbotPaths, accessFn);
    if (!executable) {
      throw new AcmeManagerError('certbot_not_installed', 'Certbot is not installed on the managed server');
    }
    return executable;
  }

  async function runCertbot(args) {
    const executable = await requireCertbot();
    try {
      await run(executable, args);
    } catch (error) {
      const wrapped = new AcmeManagerError('certbot_failed', 'Certbot operation failed');
      wrapped.exitCode = Number.isInteger(error?.code) ? error.code : null;
      throw wrapped;
    }
  }

  async function issueCertificate({ domains, email, staging = false }) {
    const normalizedDomains = normalizeDomains(domains);
    const accountEmail = validateEmail(email);
    await mkdirFn(acmeRoot, { recursive: true, mode: 0o755 });

    const certName = normalizedDomains[0];
    const args = [
      'certonly',
      '--webroot',
      '--webroot-path', acmeRoot,
      '--non-interactive',
      '--agree-tos',
      '--email', accountEmail,
      '--cert-name', certName,
    ];

    if (staging) args.push('--test-cert');
    for (const domain of normalizedDomains) args.push('-d', domain);

    await runCertbot(args);
    const metadata = await inspectCertificate({ liveRoot, certName, readFileFn });
    return {
      ...metadata,
      domains: normalizedDomains,
      staging: Boolean(staging),
    };
  }

  async function renewCertificate({ certName, dryRun = false }) {
    const normalizedName = normalizeDomainSet(certName, []).primary;
    const args = ['renew', '--cert-name', normalizedName, '--non-interactive'];
    if (dryRun) args.push('--dry-run');

    await runCertbot(args);
    if (dryRun) {
      return { certName: normalizedName, dryRun: true, status: 'validated' };
    }

    return {
      ...(await inspectCertificate({ liveRoot, certName: normalizedName, readFileFn })),
      dryRun: false,
      status: 'renewed',
    };
  }

  return {
    issueCertificate,
    renewCertificate,
    inspectCertificate: (certName) => inspectCertificate({ liveRoot, certName, readFileFn }),
  };
}

export const acmeManager = createAcmeManager();
