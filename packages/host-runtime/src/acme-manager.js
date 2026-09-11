import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const CERTBOT_PATHS = Object.freeze(['/usr/bin/certbot', '/usr/local/bin/certbot']);
const DEFAULT_ACME_ROOT = '/var/lib/yunpanel/acme';
const DEFAULT_LIVE_ROOT = '/etc/letsencrypt/live';
const DEFAULT_CREDENTIAL_ROOT = '/run/yunpanel/acme-credentials';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUDFLARE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,256}$/;

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

function normalizeDomains(domains, { allowWildcard = false } = {}) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    throw new AcmeManagerError('invalid_certificate_domains', 'Certificate must contain between 1 and 21 domains');
  }

  try {
    const values = domains.map((domain) => {
      if (typeof domain !== 'string') throw new Error('invalid domain');
      if (domain.startsWith('*.')) {
        if (!allowWildcard || domain.slice(2).includes('*')) {
          throw new AcmeManagerError('wildcard_not_supported', 'Wildcard certificates require DNS-01');
        }
        return `*.${normalizeDomainSet(domain.slice(2), []).primary}`;
      }
      if (domain.includes('*')) throw new AcmeManagerError('wildcard_not_supported', 'Wildcard certificates require DNS-01');
      return normalizeDomainSet(domain, []).primary;
    });
    if (new Set(values).size !== values.length || values[0].startsWith('*.')) throw new Error('invalid certificate name');
    return values;
  } catch (error) {
    if (error instanceof AcmeManagerError) throw error;
    throw new AcmeManagerError('invalid_certificate_domains', 'Certificate domains are invalid');
  }
}

function normalizeChallenge(value) {
  if (value === undefined || value === null) return Object.freeze({ type: 'http-01' });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcmeManagerError('invalid_acme_challenge', 'ACME challenge configuration is invalid');
  }
  if (value.type === 'http-01' && Object.keys(value).length === 1) return Object.freeze({ type: 'http-01' });
  const fields = new Set(['type', 'provider', 'credentialId', 'dnsZoneId', 'propagationSeconds']);
  if (value.type !== 'dns-01' || value.provider !== 'cloudflare'
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || typeof value.credentialId !== 'string' || !UUID_PATTERN.test(value.credentialId)
    || typeof value.dnsZoneId !== 'string' || !UUID_PATTERN.test(value.dnsZoneId)
    || !Number.isInteger(value.propagationSeconds) || value.propagationSeconds < 10 || value.propagationSeconds > 120) {
    throw new AcmeManagerError('invalid_acme_challenge', 'ACME DNS challenge configuration is invalid');
  }
  return Object.freeze({
    type: 'dns-01',
    provider: 'cloudflare',
    credentialId: value.credentialId.toLowerCase(),
    dnsZoneId: value.dnsZoneId.toLowerCase(),
    propagationSeconds: value.propagationSeconds,
  });
}

function validateDnsCredential(challenge, credential) {
  const fields = new Set(['id', 'dnsZoneId', 'provider', 'token']);
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)
    || Object.keys(credential).length !== fields.size || Object.keys(credential).some((field) => !fields.has(field))
    || credential.id !== challenge.credentialId || credential.dnsZoneId !== challenge.dnsZoneId
    || credential.provider !== challenge.provider || typeof credential.token !== 'string'
    || !CLOUDFLARE_TOKEN_PATTERN.test(credential.token)) {
    throw new AcmeManagerError('invalid_dns_provider_credential', 'DNS provider credential is invalid');
  }
  return credential;
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
  credentialRoot = DEFAULT_CREDENTIAL_ROOT,
  accessFn = access,
  chmodFn = chmod,
  mkdirFn = mkdir,
  mkdtempFn = mkdtemp,
  readFileFn = readFile,
  rmFn = rm,
  writeFileFn = writeFile,
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

  async function withChallengeCredential(challenge, dnsCredential, operation) {
    if (challenge.type === 'http-01') return operation(null);
    const credential = validateDnsCredential(challenge, dnsCredential);
    if (typeof credentialRoot !== 'string' || !path.isAbsolute(credentialRoot) || credentialRoot === path.parse(credentialRoot).root) {
      throw new AcmeManagerError('invalid_acme_credential_root', 'ACME credential root is invalid');
    }
    await mkdirFn(credentialRoot, { recursive: true, mode: 0o700 });
    await chmodFn(credentialRoot, 0o700);
    const temporaryDirectory = await mkdtempFn(path.join(credentialRoot, 'cloudflare-'));
    const credentialPath = path.join(temporaryDirectory, 'credentials.ini');
    try {
      await chmodFn(temporaryDirectory, 0o700);
      await writeFileFn(credentialPath, `dns_cloudflare_api_token = ${credential.token}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      return await operation(credentialPath);
    } finally {
      await rmFn(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function issueCertificate({ domains, email, staging = false, challenge: requestedChallenge }, { dnsCredential = null } = {}) {
    const challenge = normalizeChallenge(requestedChallenge);
    const normalizedDomains = normalizeDomains(domains, { allowWildcard: challenge.type === 'dns-01' });
    const accountEmail = validateEmail(email);
    if (challenge.type === 'http-01') {
      await mkdirFn(acmeRoot, { recursive: true, mode: 0o755 });
      await chmodFn(acmeRoot, 0o755);
    }

    const certName = normalizedDomains[0];
    await withChallengeCredential(challenge, dnsCredential, async (credentialPath) => {
      const args = ['certonly'];
      if (challenge.type === 'http-01') args.push('--webroot', '--webroot-path', acmeRoot);
      else args.push(
        '--dns-cloudflare',
        '--dns-cloudflare-credentials', credentialPath,
        '--dns-cloudflare-propagation-seconds', String(challenge.propagationSeconds),
      );
      args.push('--non-interactive', '--agree-tos', '--email', accountEmail, '--cert-name', certName);
      if (staging) args.push('--dry-run');
      for (const domain of normalizedDomains) args.push('-d', domain);
      await runCertbot(args);
    });

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

  async function renewCertificate({ certName, dryRun = false, challenge: requestedChallenge }, { dnsCredential = null } = {}) {
    const normalizedName = normalizeDomainSet(certName, []).primary;
    const challenge = normalizeChallenge(requestedChallenge);
    await withChallengeCredential(challenge, dnsCredential, async (credentialPath) => {
      const args = ['renew', '--cert-name', normalizedName, '--non-interactive'];
      if (challenge.type === 'dns-01') args.push(
        '--dns-cloudflare',
        '--dns-cloudflare-credentials', credentialPath,
        '--dns-cloudflare-propagation-seconds', String(challenge.propagationSeconds),
      );
      if (dryRun) args.push('--dry-run');
      await runCertbot(args);
    });
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
  normalizeChallenge,
  validateDnsCredential,
});
