import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
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

async function inspectCertificateFile({ liveRoot, certName, readFileFn = readFile }) {
  const paths = certificatePaths(liveRoot, certName);
  let pem;
  let privateKeyPem;
  try {
    [pem, privateKeyPem] = await Promise.all([
      readFileFn(paths.certificatePath, 'utf8'),
      readFileFn(paths.privateKeyPath, 'utf8'),
    ]);
  } catch {
    throw new AcmeManagerError('certificate_not_found', 'Issued certificate metadata could not be read');
  }

  let certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new AcmeManagerError('invalid_certificate_file', 'Issued certificate file is invalid');
  }

  let privateKey;
  try {
    privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    throw new AcmeManagerError('invalid_private_key_file', 'Issued certificate private key file is invalid');
  }
  const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const privateKeyPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (certificateKey.length !== privateKeyPublic.length || !timingSafeEqual(certificateKey, privateKeyPublic)) {
    throw new AcmeManagerError('certificate_private_key_mismatch', 'Issued certificate and private key do not match');
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
  chmodFn = chmod,
  mkdirFn = mkdir,
  readFileFn = readFile,
  inspectCertificateFn = (certName) => inspectCertificateFile({ liveRoot, certName, readFileFn }),
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
    await chmodFn(acmeRoot, 0o755);

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

    if (staging) args.push('--dry-run');
    for (const domain of normalizedDomains) args.push('-d', domain);

    await runCertbot(args);

    if (staging) {
      return {
        certName,
        domains: normalizedDomains,
        staging: true,
        status: 'validated',
      };
    }

    return {
      ...(await inspectCertificateFn(certName)),
      domains: normalizedDomains,
      staging: false,
      status: 'issued',
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
      ...(await inspectCertificateFn(normalizedName)),
      dryRun: false,
      status: 'renewed',
    };
  }

  return {
    issueCertificate,
    renewCertificate,
    inspectCertificate: inspectCertificateFn,
  };
}

export const acmeManager = createAcmeManager();

export const acmeManagerInternals = Object.freeze({
  certificatePaths,
  inspectCertificateFile,
  normalizeDomains,
});
