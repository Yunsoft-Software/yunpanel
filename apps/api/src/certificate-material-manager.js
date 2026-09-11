import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

// Keep the combined JSON payload below the API's 256 KiB body limit while
// leaving ample room for ordinary PEM-encoded certificate chains and keys.
const MAX_CERTIFICATE_BYTES = 64 * 1024;
const MAX_CHAIN_BYTES = 128 * 1024;
const MAX_PRIVATE_KEY_BYTES = 32 * 1024;
const CERTIFICATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_BLOCK = /^-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----\s*$/;
const KEY_TYPES = new Set(['rsa', 'rsa-pss', 'ec', 'ed25519', 'ed448']);

export class CertificateMaterialError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CertificateMaterialError';
    this.code = code;
    this.status = status;
  }
}

function boundedPem(value, maxBytes, code, message, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > maxBytes || value.includes('\u0000')) {
    throw new CertificateMaterialError(code, message);
  }
  return value;
}

function certificatePemBlocks(value, { required = true, maxBytes = required ? MAX_CERTIFICATE_BYTES : MAX_CHAIN_BYTES } = {}) {
  const pem = boundedPem(value, maxBytes, 'invalid_certificate_pem', 'Certificate PEM is invalid', { optional: !required });
  if (!pem) return [];
  const blocks = pem.match(CERTIFICATE_BLOCK) ?? [];
  const remainder = pem.replace(CERTIFICATE_BLOCK, '').trim();
  if (remainder || (required ? blocks.length !== 1 : blocks.length > 10)) {
    throw new CertificateMaterialError('invalid_certificate_pem', 'Certificate PEM is invalid');
  }
  return blocks;
}

function normalizeExpectedDomains(domains) {
  if (!Array.isArray(domains) || domains.length < 1 || domains.length > 21) {
    throw new CertificateMaterialError('invalid_certificate_domains', 'Expected certificate hostnames are invalid');
  }
  try {
    const normalized = normalizeDomainSet(domains[0], domains.slice(1));
    return [normalized.primary, ...normalized.aliases];
  } catch {
    throw new CertificateMaterialError('invalid_certificate_domains', 'Expected certificate hostnames are invalid');
  }
}

function parseCertificate(block, code = 'invalid_certificate_pem') {
  try { return new X509Certificate(block); }
  catch { throw new CertificateMaterialError(code, 'Certificate PEM is invalid'); }
}

function parsePrivateKey(value) {
  const pem = boundedPem(value, MAX_PRIVATE_KEY_BYTES, 'invalid_private_key_pem', 'Private key PEM is invalid');
  if (!PRIVATE_KEY_BLOCK.test(pem)) {
    throw new CertificateMaterialError('invalid_private_key_pem', 'Private key PEM is invalid');
  }
  let key;
  try { key = createPrivateKey({ key: pem, format: 'pem' }); }
  catch { throw new CertificateMaterialError('invalid_private_key_pem', 'Private key PEM is invalid or encrypted'); }
  if (!KEY_TYPES.has(key.asymmetricKeyType)) {
    throw new CertificateMaterialError('unsupported_private_key_type', 'Private key type is not supported');
  }
  return { key, pem: pem.trimEnd() + '\n' };
}

function publicKeyDer(key) {
  return createPublicKey(key).export({ type: 'spki', format: 'der' });
}

function certificateMetadata(certificate) {
  return Object.freeze({
    subject: certificate.subject.slice(0, 500),
    issuer: certificate.issuer.slice(0, 500),
    subjectAltName: certificate.subjectAltName?.slice(0, 2000) ?? null,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    fingerprint256: certificate.fingerprint256.toUpperCase(),
  });
}

function inspectMaterial({ certificatePem, chainPem = '', privateKeyPem, domains, now = () => Date.now() }) {
  const expectedDomains = normalizeExpectedDomains(domains);
  const [leafBlock] = certificatePemBlocks(certificatePem);
  const chainBlocks = certificatePemBlocks(chainPem, { required: false });
  const leaf = parseCertificate(leafBlock);
  for (const block of chainBlocks) parseCertificate(block, 'invalid_certificate_chain');
  const privateKey = parsePrivateKey(privateKeyPem);
  const certificateKey = leaf.publicKey.export({ type: 'spki', format: 'der' });
  const suppliedKey = publicKeyDer(privateKey.key);
  if (certificateKey.length !== suppliedKey.length || !timingSafeEqual(certificateKey, suppliedKey)) {
    throw new CertificateMaterialError('certificate_private_key_mismatch', 'Certificate and private key do not match', 409);
  }
  const uncovered = expectedDomains.find((domain) => !leaf.checkHost(domain, {
    subject: 'default', wildcards: true, partialWildcards: false, multiLabelWildcards: false, singleLabelSubdomains: false,
  }));
  if (uncovered) {
    throw new CertificateMaterialError('certificate_domain_mismatch', 'Certificate does not cover every current Domain hostname', 409);
  }
  const metadata = certificateMetadata(leaf);
  const currentTime = now();
  if (!Number.isFinite(currentTime) || Date.parse(metadata.validFrom) > currentTime || Date.parse(metadata.validTo) <= currentTime) {
    throw new CertificateMaterialError('certificate_not_currently_valid', 'Certificate is not currently valid', 409);
  }
  const normalizedCertificatePem = leafBlock.trim() + '\n';
  const normalizedChainPem = chainBlocks.length ? `${chainBlocks.map((block) => block.trim()).join('\n')}\n` : '';
  const fullchainPem = `${normalizedCertificatePem}${normalizedChainPem}`;
  const materialDigest = createHash('sha256')
    .update(leaf.raw)
    .update('\u0000')
    .update(createHash('sha256').update(fullchainPem).digest())
    .update('\u0000')
    .update(certificateKey)
    .digest('hex');
  return Object.freeze({
    domains: Object.freeze(expectedDomains),
    certificatePem: normalizedCertificatePem,
    fullchainPem,
    privateKeyPem: privateKey.pem,
    materialDigest,
    ...metadata,
  });
}

function safeInspection(material) {
  return Object.freeze({
    domains: material.domains,
    materialDigest: material.materialDigest,
    subject: material.subject,
    issuer: material.issuer,
    subjectAltName: material.subjectAltName,
    validFrom: material.validFrom,
    validTo: material.validTo,
    fingerprint256: material.fingerprint256,
  });
}

function safeRoot(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value === path.parse(value).root || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CertificateMaterialError('invalid_certificate_material_root', `${label} is invalid`, 500);
  }
  return path.resolve(value);
}

async function readBounded(filePath, maxBytes, { allowSymlink, statFn, lstatFn, readFileFn }) {
  let entry;
  try {
    const link = await lstatFn(filePath);
    if (!allowSymlink && link.isSymbolicLink()) throw new Error('symlink');
    entry = await statFn(filePath);
  } catch {
    throw new CertificateMaterialError('certificate_material_unavailable', 'Certificate material is unavailable', 409);
  }
  if (!entry.isFile() || entry.size < 1 || entry.size > maxBytes) {
    throw new CertificateMaterialError('certificate_material_unavailable', 'Certificate material is unavailable', 409);
  }
  try { return await readFileFn(filePath, 'utf8'); }
  catch { throw new CertificateMaterialError('certificate_material_unavailable', 'Certificate material is unavailable', 409); }
}

export function createCertificateMaterialManager({
  customRoot = '/var/lib/yunpanel/control-plane/custom-certificates',
  acmeLiveRoot = '/etc/letsencrypt/live',
  now = () => Date.now(),
  getUid = () => process.getuid?.(),
  chmodFn = chmod,
  lstatFn = lstat,
  mkdirFn = mkdir,
  readFileFn = readFile,
  realpathFn = realpath,
  renameFn = rename,
  rmFn = rm,
  statFn = stat,
  writeFileFn = writeFile,
} = {}) {
  const resolvedCustomRoot = safeRoot(customRoot, 'Custom certificate root');
  const resolvedAcmeRoot = safeRoot(acmeLiveRoot, 'ACME certificate root');

  function assertRoot() {
    if (getUid() !== 0) throw new CertificateMaterialError('certificate_root_required', 'Certificate material operations require the packaged root API', 503);
  }

  function customPaths(certificateId) {
    if (typeof certificateId !== 'string' || !CERTIFICATE_ID_PATTERN.test(certificateId)) {
      throw new CertificateMaterialError('invalid_certificate_id', 'Certificate ID is invalid');
    }
    const directory = path.join(resolvedCustomRoot, certificateId.toLowerCase());
    return Object.freeze({
      directory,
      certificatePath: path.join(directory, 'cert.pem'),
      fullchainPath: path.join(directory, 'fullchain.pem'),
      privateKeyPath: path.join(directory, 'privkey.pem'),
    });
  }

  function inspectInput(input) {
    assertRoot();
    return safeInspection(inspectMaterial({ ...input, now }));
  }

  async function installCustom({ certificateId = randomUUID(), ...input } = {}) {
    assertRoot();
    const material = inspectMaterial({ ...input, now });
    const paths = customPaths(certificateId);
    await mkdirFn(resolvedCustomRoot, { recursive: true, mode: 0o700 });
    await chmodFn(resolvedCustomRoot, 0o700);
    let rootEntry;
    try {
      [rootEntry] = await Promise.all([lstatFn(resolvedCustomRoot), realpathFn(resolvedCustomRoot)]);
    } catch {
      throw new CertificateMaterialError('certificate_material_root_unavailable', 'Custom certificate root is unavailable', 503);
    }
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new CertificateMaterialError('certificate_material_root_unsafe', 'Custom certificate root is unsafe', 503);
    }

    const temporaryDirectory = `${paths.directory}.tmp-${randomUUID()}`;
    try {
      await mkdirFn(temporaryDirectory, { mode: 0o700 });
      await writeFileFn(path.join(temporaryDirectory, 'cert.pem'), material.certificatePem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeFileFn(path.join(temporaryDirectory, 'fullchain.pem'), material.fullchainPem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeFileFn(path.join(temporaryDirectory, 'privkey.pem'), material.privateKeyPem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await renameFn(temporaryDirectory, paths.directory);
    } catch {
      try { await rmFn(temporaryDirectory, { recursive: true, force: true }); } catch {}
      throw new CertificateMaterialError('certificate_material_install_failed', 'Custom certificate material could not be installed', 503);
    }
    return Object.freeze({ certificateId: certificateId.toLowerCase(), ...paths, ...safeInspection(material) });
  }

  async function inspectStored({ certificate, domains } = {}) {
    assertRoot();
    if (!certificate || typeof certificate !== 'object' || certificate.staging === true) {
      throw new CertificateMaterialError('certificate_not_selectable', 'Certificate is not selectable', 409);
    }
    let expected;
    let allowSymlink;
    if (certificate.source === 'custom') {
      expected = customPaths(certificate.id);
      allowSymlink = false;
    } else if (certificate.source === 'acme') {
      let certName;
      try { certName = normalizeDomainSet(certificate.certName, []).primary; }
      catch { throw new CertificateMaterialError('certificate_material_identity_invalid', 'Certificate material identity is invalid', 409); }
      const directory = path.join(resolvedAcmeRoot, certName);
      expected = {
        certificatePath: path.join(directory, 'cert.pem'),
        fullchainPath: path.join(directory, 'fullchain.pem'),
        privateKeyPath: path.join(directory, 'privkey.pem'),
      };
      allowSymlink = true;
    } else {
      throw new CertificateMaterialError('certificate_source_invalid', 'Certificate source is invalid', 409);
    }
    if (certificate.certificatePath !== expected.certificatePath || certificate.fullchainPath !== expected.fullchainPath
      || certificate.privateKeyPath !== expected.privateKeyPath) {
      throw new CertificateMaterialError('certificate_material_identity_invalid', 'Certificate material identity is invalid', 409);
    }
    const [certificatePem, fullchainPem, privateKeyPem] = await Promise.all([
      readBounded(expected.certificatePath, MAX_CERTIFICATE_BYTES, { allowSymlink, statFn, lstatFn, readFileFn }),
      readBounded(expected.fullchainPath, MAX_CERTIFICATE_BYTES + MAX_CHAIN_BYTES, { allowSymlink, statFn, lstatFn, readFileFn }),
      readBounded(expected.privateKeyPath, MAX_PRIVATE_KEY_BYTES, { allowSymlink, statFn, lstatFn, readFileFn }),
    ]);
    const fullchainBlocks = certificatePemBlocks(fullchainPem, {
      required: false,
      maxBytes: MAX_CERTIFICATE_BYTES + MAX_CHAIN_BYTES,
    });
    if (fullchainBlocks.length < 1) throw new CertificateMaterialError('invalid_certificate_chain', 'Certificate chain is invalid');
    const leaf = parseCertificate(certificatePem);
    const firstFullchain = parseCertificate(fullchainBlocks[0]);
    if (!leaf.raw.equals(firstFullchain.raw)) {
      throw new CertificateMaterialError('certificate_chain_leaf_mismatch', 'Certificate chain does not start with the selected certificate', 409);
    }
    return safeInspection(inspectMaterial({
      certificatePem,
      chainPem: fullchainBlocks.slice(1).join('\n'),
      privateKeyPem,
      domains,
      now,
    }));
  }

  async function removeCustom(certificateId) {
    assertRoot();
    const paths = customPaths(certificateId);
    let entry;
    try { entry = await lstatFn(paths.directory); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new CertificateMaterialError('certificate_material_cleanup_failed', 'Custom certificate material could not be cleaned up', 503);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new CertificateMaterialError('certificate_material_root_unsafe', 'Custom certificate material path is unsafe', 503);
    }
    try { await rmFn(paths.directory, { recursive: true, force: false }); }
    catch { throw new CertificateMaterialError('certificate_material_cleanup_failed', 'Custom certificate material could not be cleaned up', 503); }
    return true;
  }

  return Object.freeze({ inspectInput, installCustom, inspectStored, removeCustom, customPaths });
}

export const certificateMaterialInternals = Object.freeze({
  inspectMaterial,
  safeInspection,
  certificatePemBlocks,
  normalizeExpectedDomains,
});
