import crypto from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { AuthError } from './auth-error.js';
import { createProcessStoreLock, ProcessStoreLockError } from './process-store-lock.js';
import { assertNoDot44Host } from './production-exit-gate.js';
import {
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TOKEN_TYPE,
  FREE_BASELINE_CAPABILITIES,
  YUNPANEL_PRODUCT_CODE,
  extractHostCandidate,
  isHostAllowedForYunpanelLicense,
  normalizeLicenseDomain,
  parseTrustedPublicKeys,
  verifyYunpanelEntitlementToken,
} from './license-entitlement-verifier.js';
import {
  DEFAULT_YUNSOFT_DOCS_URL,
  DEFAULT_YUNSOFT_PREMIUM_OFFER_URL,
  resolveYunsoftPublicUrl,
} from './yunsoft-links.js';

const STORE_SCHEMA_VERSION = 1;
const REMOTE_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REMOTE_TERMINAL_REASONS = new Set([
  'LICENSE_REVOKED',
  'LICENSE_REFUNDED',
  'LICENSE_SUSPENDED',
  'LICENSE_EXPIRED',
]);
const REMOTE_TERMINAL_STATUSES = new Set([
  'revoked',
  'refunded',
  'suspended',
  'expired',
]);

const CAPABILITY_LABELS = Object.freeze({
  aiOperations: 'AI Operations',
  resellerAccounts: 'Reseller Accounts',
  perSiteIsolatedUsers: 'Customer & Site Panel Accounts',
});

export class LicenseEntitlementError extends AuthError {
  constructor(code, message, status = 400, extra = {}) {
    super(code, message, status, extra.retryAfter ?? null);
    this.name = 'LicenseEntitlementError';
    this.capability = extra.capability ?? null;
    this.reason = extra.reason ?? null;
  }
}

export const DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE = '/etc/yunpanel/control-plane/entitlement-public.pem';
export const VENDOR_ENTITLEMENT_PUBLIC_KEY_KID = '1cbcc4d3173d0c15';

export function defaultLicenseStorePath() {
  return process.env.YUNPANEL_LICENSE_STORE ?? path.resolve('.data/license/entitlement.json');
}

export function defaultVendorEntitlementPublicKeyFile() {
  return fileURLToPath(new URL('./vendor-entitlement-public.pem', import.meta.url));
}

export function defaultEntitlementPublicKeyFile() {
  if (process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE !== undefined) {
    return process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
  }
  return existsSync(DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE)
    ? DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE
    : defaultVendorEntitlementPublicKeyFile();
}

export function defaultCommerceBaseUrl() {
  return process.env.YUNPANEL_LICENSE_COMMERCE_URL ?? 'https://yunsoft.com/api/commerce';
}

export function maskLicenseKey(rawKey) {
  if (typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const suffix = compact.slice(-4) || 'XXXX';
  if (/^YUN-/i.test(trimmed)) {
    return `YUN-****-****-${suffix}`;
  }
  return `****-****-${suffix}`;
}

function normalizeLicenseKeyInput(rawKey) {
  if (typeof rawKey !== 'string') {
    throw new LicenseEntitlementError(
      'invalid_license_key',
      'Enter a valid license key.',
      400,
    );
  }
  const trimmed = rawKey.trim();
  if (trimmed.length < 8 || trimmed.length > 256 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new LicenseEntitlementError(
      'invalid_license_key',
      'Enter a valid license key.',
      400,
    );
  }
  return trimmed;
}

function deriveSecretKey(masterKey) {
  if (typeof masterKey !== 'string' || masterKey.trim().length < 16) {
    return null;
  }
  return crypto.createHash('sha256').update(`yunpanel:license-secret:v1:${masterKey}`).digest();
}

function encryptSecretValue(plainText, secretKey) {
  if (!plainText || !secretKey) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    alg: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: ciphertext.toString('base64url'),
  });
}

function decryptSecretValue(envelope, secretKey) {
  if (!envelope || typeof envelope !== 'object' || !secretKey) return null;
  if (
    envelope.alg !== 'aes-256-gcm'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.data !== 'string'
  ) {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      secretKey,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

function mapVerificationFailureToError(verification) {
  const reason = verification?.reason ?? 'INVALID_TOKEN';
  switch (reason) {
    case 'PUBLIC_KEY_NOT_CONFIGURED':
      return new LicenseEntitlementError(
        'license_public_key_not_configured',
        'Entitlement verification public key is not configured on this server.',
        503,
        { reason },
      );
    case 'PUBLIC_KEY_READ_FAILED':
      return new LicenseEntitlementError(
        'license_public_key_read_failed',
        'Unable to read entitlement verification public key file.',
        503,
        { reason },
      );
    case 'INVALID_PUBLIC_KEY_PEM':
    case 'UNSUPPORTED_PUBLIC_KEY_TYPE':
      return new LicenseEntitlementError(
        'license_public_key_invalid',
        'Configured entitlement public key is invalid.',
        503,
        { reason },
      );
    case 'PRODUCT_MISMATCH':
    case 'INVALID_PRODUCT_CODE':
      return new LicenseEntitlementError(
        'license_product_mismatch',
        'This license belongs to another product and cannot be used on YunPanel.',
        422,
        { reason },
      );
    case 'DOMAIN_MISMATCH':
    case 'INVALID_TOKEN_DOMAIN':
      return new LicenseEntitlementError(
        'license_domain_mismatch',
        'License domain does not match this panel address.',
        422,
        { reason },
      );
    case 'INSTANCE_MISMATCH':
      return new LicenseEntitlementError(
        'license_instance_mismatch',
        'License token is bound to another YunPanel instance.',
        422,
        { reason },
      );
    case 'LICENSE_EXPIRED':
      return new LicenseEntitlementError(
        'license_expired',
        'This license token has expired. Renew your license to activate Premium features.',
        422,
        { reason },
      );
    case 'LICENSE_REVOKED':
    case 'LICENSE_REFUNDED':
    case 'LICENSE_SUSPENDED':
    case 'LICENSE_NOT_ACTIVE':
      return new LicenseEntitlementError(
        'license_inactive',
        'This license is no longer active.',
        422,
        { reason },
      );
    case 'TOKEN_NOT_YET_VALID':
      return new LicenseEntitlementError(
        'license_not_yet_valid',
        'This license token is not yet valid. Check system clock synchronization.',
        422,
        { reason },
      );
    default:
      return new LicenseEntitlementError(
        'invalid_license_token',
        'License entitlement token failed cryptographic or contract verification.',
        422,
        { reason },
      );
  }
}

function sanitizeWatermarks(rawWatermarks) {
  if (!rawWatermarks || typeof rawWatermarks !== 'object' || Array.isArray(rawWatermarks)) {
    return {};
  }
  const clean = {};
  for (const [rawId, entry] of Object.entries(rawWatermarks)) {
    const id = String(rawId || '').trim();
    if (!id || id.length > 256 || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const maxEntitlementVersion = Number.isSafeInteger(entry.maxEntitlementVersion) && entry.maxEntitlementVersion >= 1
      ? entry.maxEntitlementVersion
      : 1;
    const maxIat = Number.isSafeInteger(entry.maxIat) && entry.maxIat > 0 ? entry.maxIat : 0;
    const maxExp = Number.isSafeInteger(entry.maxExp) && entry.maxExp > 0 ? entry.maxExp : 0;
    clean[id] = { maxEntitlementVersion, maxIat, maxExp };
  }
  return clean;
}

function resolveLicenseIdentity(claims) {
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.licenseId === 'string' && claims.licenseId.trim()) {
    return claims.licenseId.trim();
  }
  if (typeof claims.sub === 'string' && claims.sub.trim()) {
    return claims.sub.trim();
  }
  return null;
}

function recordLicenseWatermark(existingWatermarks, claims) {
  const next = { ...sanitizeWatermarks(existingWatermarks) };
  const identity = resolveLicenseIdentity(claims);
  if (!identity) return next;
  const incomingVersion = Number.isSafeInteger(claims.entitlementVersion) && claims.entitlementVersion >= 1
    ? claims.entitlementVersion
    : 1;
  const incomingIat = Number.isSafeInteger(claims.iat) ? claims.iat : 0;
  const incomingExp = Number.isSafeInteger(claims.exp) ? claims.exp : 0;
  const current = next[identity];
  if (!current) {
    next[identity] = {
      maxEntitlementVersion: incomingVersion,
      maxIat: incomingIat,
      maxExp: incomingExp,
    };
    return next;
  }
  if (incomingVersion > current.maxEntitlementVersion) {
    next[identity] = {
      maxEntitlementVersion: incomingVersion,
      maxIat: incomingIat,
      maxExp: incomingExp,
    };
  } else if (incomingVersion === current.maxEntitlementVersion) {
    next[identity] = {
      maxEntitlementVersion: current.maxEntitlementVersion,
      maxIat: Math.max(current.maxIat, incomingIat),
      maxExp: Math.max(current.maxExp, incomingExp),
    };
  }
  return next;
}

function ensurePrivateStoreDirectory(filePath) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory()) {
    throw new Error('License store directory is not a valid directory');
  }
  if (!existsSync(resolved)) {
    const fd = openSync(resolved, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } else {
    const meta = lstatSync(resolved);
    if (!meta.isFile()) {
      throw new Error('License store path must be a regular file');
    }
  }
  return resolved;
}

function isMissingFileError(filePath) {
  try {
    statSync(filePath);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function createLicenseEntitlementService(rawOptions = {}) {
  const {
    filePath = defaultLicenseStorePath(),
    commerceBaseUrl = defaultCommerceBaseUrl(),
    publicOrigin = process.env.YUNPANEL_PUBLIC_ORIGIN ?? 'http://localhost:4000',
    instanceId: explicitInstanceId = process.env.YUNPANEL_LOCAL_SERVER_ID ?? null,
    masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
    development = process.env.NODE_ENV !== 'production',
    now = () => Date.now(),
    fetchImpl = globalThis.fetch,
    storeLockFactory = createProcessStoreLock,
    vendorPublicKeyFile = defaultVendorEntitlementPublicKeyFile(),
    systemPublicKeyFile = DEFAULT_SYSTEM_ENTITLEMENT_PUBLIC_KEY_FILE,
    offerUrl = undefined,
    docsUrl = undefined,
  } = rawOptions;

  const hasExplicitPemOption = Object.hasOwn(rawOptions, 'publicKeyPem');
  const hasExplicitFileOption = Object.hasOwn(rawOptions, 'publicKeyFile');

  const resolvedFilePath = filePath === ':memory:' ? null : ensurePrivateStoreDirectory(filePath);
  const processLock = resolvedFilePath
    ? storeLockFactory({ filePath: resolvedFilePath, waitMs: 10_000, retryMs: 10 })
    : null;
  const secretKey = deriveSecretKey(masterKey);

  let cachedKeySignature = null;
  let cachedTrustedKeys = new Map();

  function resolveEffectiveKeySources() {
    const effectivePem = hasExplicitPemOption
      ? (rawOptions.publicKeyPem ?? '')
      : (process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_PEM ?? '');

    if (hasExplicitFileOption) {
      return {
        publicKeyPem: effectivePem,
        publicKeyFile: rawOptions.publicKeyFile ?? '',
      };
    }

    if (hasExplicitPemOption) {
      return {
        publicKeyPem: effectivePem,
        publicKeyFile: '',
      };
    }

    const envFile = process.env.YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE;
    if (typeof envFile === 'string') {
      const trimmedEnvFile = envFile.trim();
      if (!trimmedEnvFile) {
        return { publicKeyPem: effectivePem, publicKeyFile: '' };
      }
      if (trimmedEnvFile === systemPublicKeyFile && isMissingFileError(trimmedEnvFile)) {
        return {
          publicKeyPem: effectivePem,
          publicKeyFile: effectivePem.trim() ? '' : (vendorPublicKeyFile ?? ''),
        };
      }
      return { publicKeyPem: effectivePem, publicKeyFile: trimmedEnvFile };
    }

    if (effectivePem.trim()) {
      return { publicKeyPem: effectivePem, publicKeyFile: '' };
    }
    if (systemPublicKeyFile && existsSync(systemPublicKeyFile)) {
      return { publicKeyPem: '', publicKeyFile: systemPublicKeyFile };
    }
    return { publicKeyPem: '', publicKeyFile: vendorPublicKeyFile ?? '' };
  }

  function loadTrustedKeysStrict() {
    const { publicKeyPem, publicKeyFile } = resolveEffectiveKeySources();
    let fileSignature = 'none';
    if (typeof publicKeyFile === 'string' && publicKeyFile.trim()) {
      try {
        const stat = statSync(publicKeyFile.trim());
        fileSignature = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new LicenseEntitlementError(
            'license_public_key_read_failed',
            'Unable to read entitlement verification public key file.',
            503,
            { reason: 'PUBLIC_KEY_READ_FAILED' },
          );
        }
      }
    }
    const nextSignature = `${publicKeyPem || ''}::${publicKeyFile || ''}::${fileSignature}`;
    if (nextSignature === cachedKeySignature) {
      return cachedTrustedKeys;
    }
    try {
      cachedTrustedKeys = parseTrustedPublicKeys({ publicKeyPem, publicKeyFile });
      cachedKeySignature = nextSignature;
      return cachedTrustedKeys;
    } catch (error) {
      cachedKeySignature = null;
      cachedTrustedKeys = new Map();
      if (error?.code === 'PRIVATE_KEY_FORBIDDEN') {
        throw new LicenseEntitlementError(
          'license_private_key_forbidden',
          'Private signing keys are strictly forbidden in YunPanel configuration.',
          500,
          { reason: 'PRIVATE_KEY_FORBIDDEN' },
        );
      }
      if (error?.code === 'PUBLIC_KEY_READ_FAILED') {
        throw new LicenseEntitlementError(
          'license_public_key_read_failed',
          'Unable to read entitlement verification public key file.',
          503,
          { reason: 'PUBLIC_KEY_READ_FAILED' },
        );
      }
      throw new LicenseEntitlementError(
        'license_public_key_invalid',
        error?.message || 'Configured entitlement public key is invalid.',
        503,
        { reason: error?.code ?? 'INVALID_PUBLIC_KEY_PEM' },
      );
    }
  }

  function loadTrustedKeysSafe() {
    try {
      const trustedKeys = loadTrustedKeysStrict();
      return { trustedKeys, errorReason: null };
    } catch (error) {
      if (error?.reason === 'PRIVATE_KEY_FORBIDDEN') {
        throw error;
      }
      return {
        trustedKeys: new Map(),
        errorReason: error?.reason ?? 'PUBLIC_KEY_UNAVAILABLE',
      };
    }
  }

  // Reject private signing keys eagerly at construction; tolerate unreadable/missing public key files by degrading to Free baseline.
  loadTrustedKeysSafe();

  function resolvePanelBinding() {
    const rawHost = extractHostCandidate(publicOrigin);
    const isLoopback = LOOPBACK_HOSTS.has(rawHost);
    const allowStaging = Boolean(development && isLoopback);
    const normalized = normalizeLicenseDomain(rawHost, { allowLoopback: allowStaging });
    return Object.freeze({
      panelHost: rawHost || null,
      panelDomain: normalized.ok ? normalized.normalizedDomain : null,
      panelDomainValid: normalized.ok,
      panelDomainReason: normalized.ok ? null : normalized.code,
      isLoopback,
      allowStaging,
    });
  }

  function resolveCommerceUrl(pathname) {
    if (typeof commerceBaseUrl !== 'string' || !commerceBaseUrl.trim()) {
      throw new LicenseEntitlementError(
        'commerce_url_not_configured',
        'License activation service URL is not configured.',
        503,
      );
    }
    try {
      assertNoDot44Host(commerceBaseUrl, 'commerceBaseUrl');
    } catch (error) {
      throw new LicenseEntitlementError(
        'forbidden_host_dot44',
        error.message,
        403,
      );
    }

    let parsedBase;
    try {
      const normalizedBase = commerceBaseUrl.trim().replace(/\/+$/, '');
      parsedBase = new URL(`${normalizedBase}${pathname}`);
    } catch {
      throw new LicenseEntitlementError(
        'invalid_commerce_url',
        'License activation service URL is invalid.',
        400,
      );
    }

    try {
      assertNoDot44Host(parsedBase.host, 'commerceBaseUrl.host');
    } catch (error) {
      throw new LicenseEntitlementError(
        'forbidden_host_dot44',
        error.message,
        403,
      );
    }

    const hostLower = parsedBase.hostname.toLowerCase();
    const allowHttpLoopback = Boolean(development && LOOPBACK_HOSTS.has(hostLower));
    if (parsedBase.protocol !== 'https:' && !(allowHttpLoopback && parsedBase.protocol === 'http:')) {
      throw new LicenseEntitlementError(
        'insecure_commerce_url',
        'License activation service URL must use HTTPS.',
        400,
      );
    }

    return parsedBase.toString();
  }

  function createEmptyState(seedInstanceId = null, seedWatermarks = {}) {
    const resolvedInstance = (typeof explicitInstanceId === 'string' && explicitInstanceId.trim())
      ? explicitInstanceId.trim()
      : (typeof seedInstanceId === 'string' && seedInstanceId.trim() ? seedInstanceId.trim() : crypto.randomUUID());
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      instanceId: resolvedInstance,
      entitlementToken: null,
      maskedLicenseKey: null,
      encryptedLicenseKey: null,
      plainLicenseKey: null,
      activatedAt: null,
      refreshedAt: null,
      remoteInvalidation: null,
      licenseWatermarks: sanitizeWatermarks(seedWatermarks),
      corruptedRecovery: false,
    };
  }

  let lastSyncedRaw = null;
  let state = createEmptyState();

  function parsePersistedJson(raw, fallbackInstanceId = null) {
    if (!raw || !raw.trim()) {
      return createEmptyState(fallbackInstanceId);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const empty = createEmptyState(fallbackInstanceId);
        empty.corruptedRecovery = true;
        return empty;
      }
      const base = createEmptyState(parsed.instanceId ?? fallbackInstanceId, parsed.licenseWatermarks);
      return {
        ...base,
        entitlementToken: typeof parsed.entitlementToken === 'string' && parsed.entitlementToken.trim()
          ? parsed.entitlementToken.trim()
          : null,
        maskedLicenseKey: typeof parsed.maskedLicenseKey === 'string' ? parsed.maskedLicenseKey : null,
        encryptedLicenseKey: parsed.encryptedLicenseKey && typeof parsed.encryptedLicenseKey === 'object'
          ? parsed.encryptedLicenseKey
          : null,
        plainLicenseKey: typeof parsed.plainLicenseKey === 'string' && parsed.plainLicenseKey.trim()
          ? parsed.plainLicenseKey.trim()
          : null,
        activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : null,
        refreshedAt: typeof parsed.refreshedAt === 'string' ? parsed.refreshedAt : null,
        remoteInvalidation: parsed.remoteInvalidation && typeof parsed.remoteInvalidation === 'object'
          ? {
              status: String(parsed.remoteInvalidation.status || 'revoked'),
              reason: String(parsed.remoteInvalidation.reason || 'LICENSE_REVOKED'),
              recordedAt: String(parsed.remoteInvalidation.recordedAt || ''),
            }
          : null,
        corruptedRecovery: false,
      };
    } catch {
      const recovered = createEmptyState(fallbackInstanceId);
      recovered.corruptedRecovery = true;
      return recovered;
    }
  }

  function syncStateFromDisk() {
    if (!resolvedFilePath) {
      return state;
    }
    let raw = '';
    try {
      raw = readFileSync(resolvedFilePath, 'utf8');
    } catch (error) {
      lastSyncedRaw = null;
      state = createEmptyState(state?.instanceId, state?.licenseWatermarks);
      if (error?.code !== 'ENOENT') {
        state.corruptedRecovery = true;
      }
      return state;
    }
    if (raw === lastSyncedRaw) {
      return state;
    }
    lastSyncedRaw = raw;
    state = parsePersistedJson(raw, state?.instanceId);
    return state;
  }

  function writePersistedState(nextState) {
    const cleanState = {
      schemaVersion: STORE_SCHEMA_VERSION,
      instanceId: nextState.instanceId,
      entitlementToken: nextState.entitlementToken ?? null,
      maskedLicenseKey: nextState.maskedLicenseKey ?? null,
      encryptedLicenseKey: nextState.encryptedLicenseKey ?? null,
      plainLicenseKey: secretKey ? null : (nextState.plainLicenseKey ?? null),
      activatedAt: nextState.activatedAt ?? null,
      refreshedAt: nextState.refreshedAt ?? null,
      remoteInvalidation: nextState.remoteInvalidation ?? null,
      licenseWatermarks: sanitizeWatermarks(nextState.licenseWatermarks),
    };
    const serialized = `${JSON.stringify(cleanState, null, 2)}\n`;
    if (resolvedFilePath) {
      mkdirSync(path.dirname(resolvedFilePath), { recursive: true, mode: 0o700 });
      const tempPath = `${resolvedFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(tempPath, serialized, { mode: 0o600 });
        renameSync(tempPath, resolvedFilePath);
      } catch (error) {
        try { rmSync(tempPath, { force: true }); } catch {}
        throw error;
      }
      lastSyncedRaw = serialized;
    }
    state = {
      ...cleanState,
      corruptedRecovery: false,
    };
  }

  // Initial sync; persist stable instanceId if file was newly created and empty.
  syncStateFromDisk();
  if (resolvedFilePath && !state.corruptedRecovery && (!lastSyncedRaw || !lastSyncedRaw.trim())) {
    try {
      writePersistedState(state);
    } catch {}
  }

  function readStoredLicenseKey(targetState = state) {
    if (targetState.encryptedLicenseKey && secretKey) {
      const decrypted = decryptSecretValue(targetState.encryptedLicenseKey, secretKey);
      if (decrypted) return decrypted;
    }
    if (typeof targetState.plainLicenseKey === 'string' && targetState.plainLicenseKey.trim()) {
      return targetState.plainLicenseKey.trim();
    }
    return null;
  }

  function buildLicenseKeyPersistence(rawKey, currentState = state) {
    if (!rawKey) {
      return {
        maskedLicenseKey: currentState.maskedLicenseKey ?? null,
        encryptedLicenseKey: currentState.encryptedLicenseKey ?? null,
        plainLicenseKey: currentState.plainLicenseKey ?? null,
      };
    }
    return {
      maskedLicenseKey: maskLicenseKey(rawKey),
      encryptedLicenseKey: secretKey ? encryptSecretValue(rawKey, secretKey) : null,
      plainLicenseKey: secretKey ? null : rawKey,
    };
  }

  let writeChain = Promise.resolve();
  function withStoreLock(task) {
    const runLocked = async () => {
      if (!processLock) {
        return task();
      }
      try {
        return await processLock.withLock(task);
      } catch (error) {
        if (error instanceof ProcessStoreLockError) {
          throw new LicenseEntitlementError(
            error.code,
            error.message,
            error.status ?? 503,
          );
        }
        throw error;
      }
    };
    const next = writeChain.then(runLocked, runLocked);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  function currentNowMs() {
    const value = typeof now === 'function' ? now() : Date.now();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  function assertNotSupersededEntitlement(candidateVerification, currentState, trustedKeys, binding, nowMs) {
    const candidateClaims = candidateVerification?.claims;
    const candidateIdentity = resolveLicenseIdentity(candidateClaims);
    if (!candidateClaims || !candidateIdentity) return;

    const candidateVersion = candidateClaims.entitlementVersion ?? 1;
    const candidateIat = candidateClaims.iat ?? 0;
    const candidateExp = candidateClaims.exp ?? 0;

    if (currentState.entitlementToken) {
      let currentVerification = null;
      try {
        currentVerification = verifyYunpanelEntitlementToken(currentState.entitlementToken, {
          trustedKeys,
          expectedDomain: binding.panelHost,
          expectedInstanceId: currentState.instanceId,
          allowStaging: binding.allowStaging,
          now: nowMs,
        });
      } catch {
        currentVerification = null;
      }
      const currentClaims = currentVerification?.claims;
      const currentIdentity = resolveLicenseIdentity(currentClaims);
      if (currentClaims && currentIdentity === candidateIdentity) {
        const currentVersion = currentClaims.entitlementVersion ?? 1;
        if (candidateVersion < currentVersion) {
          throw new LicenseEntitlementError(
            'stale_license_token',
            'Superseded license entitlement version cannot replace a newer entitlement.',
            409,
            { reason: 'SUPERSEDED_ENTITLEMENT_VERSION' },
          );
        }
        if (
          candidateVersion === currentVersion
          && candidateVerification.status === 'active'
          && (candidateExp < (currentClaims.exp ?? 0) || candidateIat < (currentClaims.iat ?? 0))
        ) {
          throw new LicenseEntitlementError(
            'stale_license_token',
            'Older license entitlement token cannot roll back the active entitlement.',
            409,
            { reason: 'SUPERSEDED_ENTITLEMENT_TOKEN' },
          );
        }
      }
    }

    const watermark = currentState.licenseWatermarks?.[candidateIdentity];
    if (watermark) {
      if (candidateVersion < watermark.maxEntitlementVersion) {
        throw new LicenseEntitlementError(
          'stale_license_token',
          'Superseded license entitlement version cannot be replayed.',
          409,
          { reason: 'SUPERSEDED_ENTITLEMENT_VERSION' },
        );
      }
      if (
        candidateVersion === watermark.maxEntitlementVersion
        && candidateVerification.status === 'active'
        && candidateExp < watermark.maxExp
      ) {
        throw new LicenseEntitlementError(
          'stale_license_token',
          'Superseded license entitlement token cannot roll back expiration.',
          409,
          { reason: 'SUPERSEDED_ENTITLEMENT_TOKEN' },
        );
      }
    }
  }

  function assertPaidOrPermanentEntitlementProtected(candidateVerification, currentState, trustedKeys, binding, nowMs) {
    if (!currentState.entitlementToken || currentState.remoteInvalidation) {
      return;
    }
    let currentVerification = null;
    try {
      currentVerification = verifyYunpanelEntitlementToken(currentState.entitlementToken, {
        trustedKeys,
        expectedDomain: binding.panelHost,
        expectedInstanceId: currentState.instanceId,
        allowStaging: binding.allowStaging,
        now: nowMs,
      });
    } catch {
      return;
    }
    if (!currentVerification?.valid) {
      return;
    }

    const currentKind = currentVerification.grantKind ?? currentVerification.claims?.grantKind ?? 'paid';
    const candidateKind = candidateVerification?.grantKind ?? candidateVerification?.claims?.grantKind ?? 'paid';
    const currentIdentity = resolveLicenseIdentity(currentVerification.claims);
    const candidateIdentity = resolveLicenseIdentity(candidateVerification?.claims);

    if (currentKind === 'permanent' && candidateKind !== 'permanent') {
      if (candidateIdentity !== currentIdentity || candidateVerification?.status === 'active') {
        throw new LicenseEntitlementError(
          'paid_or_permanent_entitlement_protected',
          'Active permanent license cannot be replaced by a temporary or promotional entitlement.',
          409,
          { reason: 'PERMANENT_ENTITLEMENT_PROTECTED' },
        );
      }
    }

    if (currentKind === 'paid' && candidateKind === 'promotional') {
      throw new LicenseEntitlementError(
        'paid_or_permanent_entitlement_protected',
        'Active paid license cannot be replaced by a promotional campaign entitlement.',
        409,
        { reason: 'PAID_ENTITLEMENT_PROTECTED' },
      );
    }
  }

  function evaluateCurrentEntitlement() {
    const currentState = syncStateFromDisk();
    const binding = resolvePanelBinding();
    const { trustedKeys, errorReason: keyErrorReason } = loadTrustedKeysSafe();
    const trustedKeyIds = Object.freeze([...trustedKeys.keys()]);
    const nowMs = currentNowMs();

    if (currentState.corruptedRecovery && !currentState.entitlementToken) {
      return {
        valid: false,
        tier: 'free',
        status: 'invalid',
        reason: 'CORRUPTED_LICENSE_STORE',
        keyId: null,
        claims: null,
        billingPeriod: null,
        periodMonths: null,
        startsAt: null,
        expiresAt: null,
        daysRemaining: 0,
        renewalRequired: false,
        capabilities: FREE_BASELINE_CAPABILITIES,
        trustedKeysConfigured: trustedKeys.size > 0,
        trustedKeyIds,
        binding,
        currentState,
      };
    }

    if (!currentState.entitlementToken) {
      return {
        valid: false,
        tier: 'free',
        status: keyErrorReason ? 'unverified' : 'free',
        reason: keyErrorReason,
        keyId: null,
        claims: null,
        billingPeriod: null,
        periodMonths: null,
        startsAt: null,
        expiresAt: null,
        daysRemaining: 0,
        renewalRequired: false,
        capabilities: FREE_BASELINE_CAPABILITIES,
        trustedKeysConfigured: trustedKeys.size > 0,
        trustedKeyIds,
        binding,
        currentState,
      };
    }

    if (keyErrorReason || trustedKeys.size === 0) {
      return {
        valid: false,
        tier: 'free',
        status: 'unverified',
        reason: keyErrorReason ?? 'PUBLIC_KEY_NOT_CONFIGURED',
        keyId: null,
        claims: null,
        billingPeriod: null,
        periodMonths: null,
        startsAt: null,
        expiresAt: null,
        daysRemaining: 0,
        renewalRequired: false,
        capabilities: FREE_BASELINE_CAPABILITIES,
        trustedKeysConfigured: false,
        trustedKeyIds,
        binding,
        currentState,
      };
    }

    let verification;
    try {
      verification = verifyYunpanelEntitlementToken(currentState.entitlementToken, {
        trustedKeys,
        expectedDomain: binding.panelHost,
        expectedInstanceId: currentState.instanceId,
        allowStaging: binding.allowStaging,
        now: nowMs,
      });
    } catch {
      return {
        valid: false,
        tier: 'free',
        status: 'invalid',
        reason: 'MALFORMED_TOKEN',
        keyId: null,
        claims: null,
        billingPeriod: null,
        periodMonths: null,
        startsAt: null,
        expiresAt: null,
        daysRemaining: 0,
        renewalRequired: false,
        capabilities: FREE_BASELINE_CAPABILITIES,
        trustedKeysConfigured: trustedKeys.size > 0,
        trustedKeyIds,
        binding,
        currentState,
      };
    }

    if (currentState.remoteInvalidation) {
      return {
        ...verification,
        valid: false,
        tier: 'free',
        status: currentState.remoteInvalidation.status,
        reason: currentState.remoteInvalidation.reason,
        daysRemaining: 0,
        renewalRequired: currentState.remoteInvalidation.status === 'expired',
        capabilities: FREE_BASELINE_CAPABILITIES,
        trustedKeysConfigured: trustedKeys.size > 0,
        trustedKeyIds,
        binding,
        currentState,
      };
    }

    return {
      ...verification,
      trustedKeysConfigured: trustedKeys.size > 0,
      trustedKeyIds,
      binding,
      currentState,
    };
  }

  function getStatus({ includeManagementDetails = false } = {}) {
    const evaluation = evaluateCurrentEntitlement();
    const { claims, currentState } = evaluation;

    const base = {
      tier: evaluation.tier,
      valid: evaluation.valid,
      status: evaluation.status,
      capabilities: evaluation.capabilities,
      productCode: claims?.productCode ?? YUNPANEL_PRODUCT_CODE,
      edition: evaluation.valid ? (claims?.edition ?? 'premium') : 'free',
      billingModel: claims?.billingModel ?? null,
      grantKind: claims?.grantKind ?? null,
      isPermanent: Boolean(evaluation.valid && (evaluation.isPermanent || claims?.grantKind === 'permanent')),
      isPromotional: Boolean(evaluation.valid && (evaluation.isPromotional || claims?.grantKind === 'promotional')),
      billingPeriod: evaluation.billingPeriod ?? null,
      periodMonths: evaluation.periodMonths ?? null,
      startsAt: evaluation.startsAt ?? null,
      expiresAt: evaluation.expiresAt ?? null,
      daysRemaining: evaluation.daysRemaining === null
        ? null
        : (evaluation.daysRemaining ?? 0),
      renewalRequired: Boolean(evaluation.renewalRequired),
    };

    if (!includeManagementDetails) {
      return Object.freeze(base);
    }

    const resolvedOfferUrl = resolveYunsoftPublicUrl(
      offerUrl !== undefined ? offerUrl : process.env.YUNPANEL_PREMIUM_OFFER_URL,
      { fallbackUrl: DEFAULT_YUNSOFT_PREMIUM_OFFER_URL, development },
    );
    const resolvedDocsUrl = resolveYunsoftPublicUrl(
      docsUrl !== undefined ? docsUrl : process.env.YUNPANEL_DOCS_URL,
      { fallbackUrl: DEFAULT_YUNSOFT_DOCS_URL, development },
    );
    const hasActivePremium = Boolean(evaluation.valid && evaluation.tier === 'premium');

    return Object.freeze({
      ...base,
      reason: evaluation.reason ?? null,
      keyId: evaluation.keyId ?? null,
      entitlementVersion: claims?.entitlementVersion ?? null,
      licenseId: claims?.licenseId ?? null,
      campaignCode: claims?.campaignCode ?? null,
      tokenType: ENTITLEMENT_TOKEN_TYPE,
      issuer: ENTITLEMENT_ISSUER,
      domain: claims?.domain ?? null,
      allowedHosts: claims?.allowedHosts ?? Object.freeze([]),
      panelHost: evaluation.binding.panelHost,
      panelDomain: evaluation.binding.panelDomain,
      panelDomainValid: evaluation.binding.panelDomainValid,
      panelDomainReason: evaluation.binding.panelDomainReason,
      instanceId: currentState.instanceId,
      maskedLicenseKey: currentState.maskedLicenseKey ?? null,
      hasStoredLicenseKey: Boolean(readStoredLicenseKey(currentState)),
      activatedAt: currentState.activatedAt ?? null,
      refreshedAt: currentState.refreshedAt ?? null,
      verificationKeyConfigured: evaluation.trustedKeysConfigured,
      trustedKeyIds: evaluation.trustedKeyIds,
      premiumOffer: Object.freeze({
        available: Boolean(resolvedOfferUrl && !hasActivePremium),
        durationMonths: 3,
        creditCardRequired: false,
        managedBy: 'yunsoft-website',
        products: Object.freeze(['yunpanel', 'yuncms']),
        offerUrl: resolvedOfferUrl,
      }),
      docsUrl: resolvedDocsUrl,
    });
  }

  function hasCapability(capabilityName) {
    if (!Object.hasOwn(FREE_BASELINE_CAPABILITIES, capabilityName)) {
      return false;
    }
    const evaluation = evaluateCurrentEntitlement();
    return evaluation.capabilities[capabilityName] === true;
  }

  function requireCapability(capabilityName, customMessage = null) {
    if (hasCapability(capabilityName)) {
      return true;
    }
    const evaluation = evaluateCurrentEntitlement();
    const label = CAPABILITY_LABELS[capabilityName] ?? capabilityName;
    const message = customMessage
      || `${label} requires an active YunPanel Premium license.`;
    throw new LicenseEntitlementError(
      'premium_license_required',
      message,
      403,
      {
        capability: capabilityName,
        reason: evaluation.reason ?? (evaluation.status === 'free' ? 'FREE_TIER' : 'LICENSE_INACTIVE'),
      },
    );
  }

  function resolveTargetExchangeDomain(requestedDomain, binding) {
    if (!binding.panelDomainValid) {
      throw new LicenseEntitlementError(
        'panel_domain_unconfigured',
        'Panel public origin must be configured with a valid domain name before activating a license.',
        400,
        { reason: binding.panelDomainReason ?? 'INVALID_PANEL_DOMAIN' },
      );
    }

    if (binding.isLoopback) {
      const candidate = typeof requestedDomain === 'string' && requestedDomain.trim()
        ? requestedDomain.trim()
        : (evaluateCurrentEntitlement().claims?.domain ?? '');
      const normalized = normalizeLicenseDomain(candidate, { allowLoopback: false });
      if (!normalized.ok) {
        throw new LicenseEntitlementError(
          'invalid_license_domain',
          'Provide the licensed domain name to activate in local development mode.',
          400,
          { reason: normalized.code },
        );
      }
      return normalized.normalizedDomain;
    }

    if (typeof requestedDomain === 'string' && requestedDomain.trim()) {
      const normalizedReq = normalizeLicenseDomain(requestedDomain.trim(), { allowLoopback: false });
      if (!normalizedReq.ok) {
        throw new LicenseEntitlementError(
          'invalid_license_domain',
          'Enter a valid licensed domain name.',
          400,
          { reason: normalizedReq.code },
        );
      }
      const matchesPanel = isHostAllowedForYunpanelLicense(
        binding.panelHost,
        { normalizedDomain: normalizedReq.normalizedDomain },
        { allowStaging: false },
      );
      if (!matchesPanel) {
        throw new LicenseEntitlementError(
          'license_domain_mismatch',
          'Requested domain does not match this panel address.',
          422,
          { reason: 'DOMAIN_MISMATCH' },
        );
      }
      return normalizedReq.normalizedDomain;
    }

    return binding.panelDomain;
  }

  async function postCommerceJson(pathname, body) {
    if (typeof fetchImpl !== 'function') {
      throw new LicenseEntitlementError(
        'license_exchange_unavailable',
        'HTTP client is unavailable for license exchange.',
        503,
      );
    }
    const endpoint = resolveCommerceUrl(pathname);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      });
    } catch {
      throw new LicenseEntitlementError(
        'license_exchange_unreachable',
        'Unable to reach Yunsoft license verification service.',
        502,
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  }

  function unwrapCommercePayload(payload) {
    if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  }

  function extractRemoteErrorDetails(payload, fallbackMessage) {
    const unwrapped = unwrapCommercePayload(payload);
    const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
    const rawError = unwrapped?.error ?? payload?.error;
    const code = (typeof firstError?.code === 'string' && firstError.code)
      || (typeof rawError?.code === 'string' && rawError.code)
      || (typeof unwrapped?.code === 'string' && unwrapped.code)
      || (typeof payload?.code === 'string' && payload.code)
      || (typeof unwrapped?.reason === 'string' && unwrapped.reason)
      || (typeof payload?.reason === 'string' && payload.reason)
      || null;
    const message = (typeof firstError?.message === 'string' && firstError.message)
      || (typeof rawError?.message === 'string' && rawError.message)
      || (typeof rawError === 'string' && rawError)
      || (typeof unwrapped?.message === 'string' && unwrapped.message)
      || (typeof payload?.message === 'string' && payload.message)
      || fallbackMessage;
    return { code, message };
  }

  async function activate({
    token = null,
    licenseKey = null,
    domain = null,
  } = {}) {
    const hasToken = typeof token === 'string' && token.trim().length > 0;
    const hasKey = typeof licenseKey === 'string' && licenseKey.trim().length > 0;
    if (!hasToken && !hasKey) {
      throw new LicenseEntitlementError(
        'missing_license_credentials',
        'Provide either a license key or a signed entitlement token.',
        400,
      );
    }

    const initialTrustedKeys = loadTrustedKeysStrict();
    if (initialTrustedKeys.size === 0) {
      throw new LicenseEntitlementError(
        'license_public_key_not_configured',
        'Entitlement verification public key is not configured on this server.',
        503,
        { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
      );
    }

    const binding = resolvePanelBinding();
    if (!binding.panelDomainValid) {
      throw new LicenseEntitlementError(
        'panel_domain_unconfigured',
        'Panel public origin must be configured with a valid domain name before activating a license.',
        400,
        { reason: binding.panelDomainReason ?? 'INVALID_PANEL_DOMAIN' },
      );
    }

    if (hasToken && !hasKey) {
      if (typeof domain === 'string' && domain.trim() && !binding.isLoopback) {
        resolveTargetExchangeDomain(domain, binding);
      }
      const trimmedToken = token.trim();
      return withStoreLock(async () => {
        const latestState = syncStateFromDisk();
        const trustedKeys = loadTrustedKeysStrict();
        if (trustedKeys.size === 0) {
          throw new LicenseEntitlementError(
            'license_public_key_not_configured',
            'Entitlement verification public key is not configured on this server.',
            503,
            { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
          );
        }
        const nowMs = currentNowMs();
        const verification = verifyYunpanelEntitlementToken(trimmedToken, {
          trustedKeys,
          expectedDomain: binding.panelHost,
          expectedInstanceId: latestState.instanceId,
          allowStaging: binding.allowStaging,
          now: nowMs,
        });
        if (!verification.valid) {
          throw mapVerificationFailureToError(verification);
        }

        assertNotSupersededEntitlement(verification, latestState, trustedKeys, binding, nowMs);
        assertPaidOrPermanentEntitlementProtected(verification, latestState, trustedKeys, binding, nowMs);

        const nowIso = new Date(nowMs).toISOString();
        writePersistedState({
          ...latestState,
          entitlementToken: trimmedToken,
          activatedAt: latestState.activatedAt ?? nowIso,
          refreshedAt: nowIso,
          remoteInvalidation: null,
          licenseWatermarks: recordLicenseWatermark(latestState.licenseWatermarks, verification.claims),
        });
        return getStatus({ includeManagementDetails: true });
      });
    }

    const normalizedKey = normalizeLicenseKeyInput(licenseKey);
    const preExchangeState = syncStateFromDisk();
    const targetDomain = resolveTargetExchangeDomain(domain, binding);

    const remote = await postCommerceJson('/v1/entitlements/activate', {
      licenseKey: normalizedKey,
      domain: targetDomain,
      instanceId: preExchangeState.instanceId,
      productCode: YUNPANEL_PRODUCT_CODE,
    });

    if (!remote.ok) {
      if (remote.status >= 500) {
        throw new LicenseEntitlementError(
          'license_exchange_unreachable',
          'Yunsoft license activation service returned a temporary error.',
          502,
        );
      }
      const details = extractRemoteErrorDetails(
        remote.payload,
        'License key activation was rejected.',
      );
      throw new LicenseEntitlementError(
        'license_activation_rejected',
        details.message,
        remote.status === 404 ? 404 : 422,
        { reason: details.code ?? 'REMOTE_ACTIVATION_REJECTED' },
      );
    }

    // Never trust any publicKey returned in the HTTP response body.
    const activatePayload = unwrapCommercePayload(remote.payload);
    const exchangedToken = typeof activatePayload?.entitlementToken === 'string'
      ? activatePayload.entitlementToken.trim()
      : '';
    if (!exchangedToken) {
      throw new LicenseEntitlementError(
        'invalid_exchange_response',
        'License activation response did not include a signed entitlement token.',
        502,
      );
    }

    return withStoreLock(async () => {
      const latestState = syncStateFromDisk();
      const trustedKeys = loadTrustedKeysStrict();
      if (trustedKeys.size === 0) {
        throw new LicenseEntitlementError(
          'license_public_key_not_configured',
          'Entitlement verification public key is not configured on this server.',
          503,
          { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
        );
      }
      const nowMs = currentNowMs();
      const verification = verifyYunpanelEntitlementToken(exchangedToken, {
        trustedKeys,
        expectedDomain: binding.panelHost,
        expectedInstanceId: latestState.instanceId,
        allowStaging: binding.allowStaging,
        now: nowMs,
      });
      if (!verification.valid) {
        throw mapVerificationFailureToError(verification);
      }

      assertNotSupersededEntitlement(verification, latestState, trustedKeys, binding, nowMs);
      assertPaidOrPermanentEntitlementProtected(verification, latestState, trustedKeys, binding, nowMs);

      const nowIso = new Date(nowMs).toISOString();
      const keyPersistence = buildLicenseKeyPersistence(normalizedKey, latestState);
      writePersistedState({
        ...latestState,
        ...keyPersistence,
        entitlementToken: exchangedToken,
        activatedAt: latestState.activatedAt ?? nowIso,
        refreshedAt: nowIso,
        remoteInvalidation: null,
        licenseWatermarks: recordLicenseWatermark(latestState.licenseWatermarks, verification.claims),
      });

      return getStatus({ includeManagementDetails: true });
    });
  }

  async function refresh({
    token = null,
    licenseKey = null,
    domain = null,
  } = {}) {
    const initialTrustedKeys = loadTrustedKeysStrict();
    if (initialTrustedKeys.size === 0) {
      throw new LicenseEntitlementError(
        'license_public_key_not_configured',
        'Entitlement verification public key is not configured on this server.',
        503,
        { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
      );
    }

    const binding = resolvePanelBinding();
    if (!binding.panelDomainValid) {
      throw new LicenseEntitlementError(
        'panel_domain_unconfigured',
        'Panel public origin must be configured with a valid domain name before refreshing a license.',
        400,
        { reason: binding.panelDomainReason ?? 'INVALID_PANEL_DOMAIN' },
      );
    }

    if (typeof token === 'string' && token.trim()) {
      const trimmedToken = token.trim();
      return withStoreLock(async () => {
        const latestState = syncStateFromDisk();
        const trustedKeys = loadTrustedKeysStrict();
        if (trustedKeys.size === 0) {
          throw new LicenseEntitlementError(
            'license_public_key_not_configured',
            'Entitlement verification public key is not configured on this server.',
            503,
            { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
          );
        }
        const nowMs = currentNowMs();
        const verification = verifyYunpanelEntitlementToken(trimmedToken, {
          trustedKeys,
          expectedDomain: binding.panelHost,
          expectedInstanceId: latestState.instanceId,
          allowStaging: binding.allowStaging,
          now: nowMs,
        });
        if (!verification.valid) {
          throw mapVerificationFailureToError(verification);
        }

        assertNotSupersededEntitlement(verification, latestState, trustedKeys, binding, nowMs);
        assertPaidOrPermanentEntitlementProtected(verification, latestState, trustedKeys, binding, nowMs);

        const nowIso = new Date(nowMs).toISOString();
        writePersistedState({
          ...latestState,
          entitlementToken: trimmedToken,
          activatedAt: latestState.activatedAt ?? nowIso,
          refreshedAt: nowIso,
          remoteInvalidation: null,
          licenseWatermarks: recordLicenseWatermark(latestState.licenseWatermarks, verification.claims),
        });
        return getStatus({ includeManagementDetails: true });
      });
    }

    const preRefreshState = syncStateFromDisk();
    const resolvedKey = typeof licenseKey === 'string' && licenseKey.trim()
      ? normalizeLicenseKeyInput(licenseKey)
      : readStoredLicenseKey(preRefreshState);

    if (!resolvedKey) {
      throw new LicenseEntitlementError(
        'license_refresh_credentials_required',
        'Paste a renewed signed entitlement token or enter your license key to refresh.',
        400,
      );
    }

    const targetDomain = resolveTargetExchangeDomain(domain, binding);
    const remote = await postCommerceJson('/v1/entitlements/verify', {
      licenseKey: resolvedKey,
      domain: targetDomain,
      instanceId: preRefreshState.instanceId,
      productCode: YUNPANEL_PRODUCT_CODE,
    });

    if (remote.status >= 500) {
      throw new LicenseEntitlementError(
        'license_exchange_unreachable',
        'Yunsoft license verification service returned a temporary error.',
        502,
      );
    }

    const refreshPayload = unwrapCommercePayload(remote.payload);
    const remoteToken = typeof refreshPayload?.entitlementToken === 'string'
      ? refreshPayload.entitlementToken.trim()
      : '';

    return withStoreLock(async () => {
      const latestState = syncStateFromDisk();
      const trustedKeys = loadTrustedKeysStrict();
      if (trustedKeys.size === 0) {
        throw new LicenseEntitlementError(
          'license_public_key_not_configured',
          'Entitlement verification public key is not configured on this server.',
          503,
          { reason: 'PUBLIC_KEY_NOT_CONFIGURED' },
        );
      }
      const nowMs = currentNowMs();
      const nowIso = new Date(nowMs).toISOString();

      if (remoteToken) {
        const verification = verifyYunpanelEntitlementToken(remoteToken, {
          trustedKeys,
          expectedDomain: binding.panelHost,
          expectedInstanceId: latestState.instanceId,
          allowStaging: binding.allowStaging,
          now: nowMs,
        });

        if (verification.valid) {
          assertNotSupersededEntitlement(verification, latestState, trustedKeys, binding, nowMs);
          assertPaidOrPermanentEntitlementProtected(verification, latestState, trustedKeys, binding, nowMs);
          const keyPersistence = buildLicenseKeyPersistence(resolvedKey, latestState);
          writePersistedState({
            ...latestState,
            ...keyPersistence,
            entitlementToken: remoteToken,
            activatedAt: latestState.activatedAt ?? nowIso,
            refreshedAt: nowIso,
            remoteInvalidation: null,
            licenseWatermarks: recordLicenseWatermark(latestState.licenseWatermarks, verification.claims),
          });
          return getStatus({ includeManagementDetails: true });
        }

        if (REMOTE_TERMINAL_STATUSES.has(verification.status)) {
          assertNotSupersededEntitlement(verification, latestState, trustedKeys, binding, nowMs);
          const keyPersistence = buildLicenseKeyPersistence(resolvedKey, latestState);
          writePersistedState({
            ...latestState,
            ...keyPersistence,
            entitlementToken: remoteToken,
            refreshedAt: nowIso,
            remoteInvalidation: {
              status: verification.status,
              reason: verification.reason ?? 'LICENSE_INACTIVE',
              recordedAt: nowIso,
            },
            licenseWatermarks: recordLicenseWatermark(latestState.licenseWatermarks, verification.claims),
          });
          return getStatus({ includeManagementDetails: true });
        }

        throw mapVerificationFailureToError(verification);
      }

      const remoteStatusRaw = String(
        refreshPayload?.license?.status ?? refreshPayload?.status ?? '',
      ).trim().toLowerCase();
      const remoteReasonRaw = String(
        refreshPayload?.reason ?? refreshPayload?.error?.code ?? refreshPayload?.code ?? '',
      ).trim().toUpperCase();

      if (
        REMOTE_TERMINAL_STATUSES.has(remoteStatusRaw)
        || REMOTE_TERMINAL_REASONS.has(remoteReasonRaw)
      ) {
        const terminalStatus = REMOTE_TERMINAL_STATUSES.has(remoteStatusRaw)
          ? remoteStatusRaw
          : (remoteReasonRaw === 'LICENSE_EXPIRED'
              ? 'expired'
              : remoteReasonRaw === 'LICENSE_REFUNDED'
                ? 'refunded'
                : remoteReasonRaw === 'LICENSE_SUSPENDED'
                  ? 'suspended'
                  : 'revoked');
        const terminalReason = REMOTE_TERMINAL_REASONS.has(remoteReasonRaw)
          ? remoteReasonRaw
          : `LICENSE_${terminalStatus.toUpperCase()}`;

        writePersistedState({
          ...latestState,
          refreshedAt: nowIso,
          remoteInvalidation: {
            status: terminalStatus,
            reason: terminalReason,
            recordedAt: nowIso,
          },
        });
        return getStatus({ includeManagementDetails: true });
      }

      if (['PRODUCT_MISMATCH', 'DOMAIN_MISMATCH', 'INSTANCE_MISMATCH'].includes(remoteReasonRaw)) {
        throw mapVerificationFailureToError({ reason: remoteReasonRaw });
      }

      const details = extractRemoteErrorDetails(
        remote.payload,
        'License verification could not renew this entitlement.',
      );
      throw new LicenseEntitlementError(
        'license_refresh_rejected',
        details.message,
        remote.ok ? 422 : (remote.status === 404 ? 404 : 422),
        { reason: details.code ?? 'REMOTE_VERIFY_REJECTED' },
      );
    });
  }

  async function deactivate({ notifyRemote = true } = {}) {
    const snapshotBefore = evaluateCurrentEntitlement();
    const storedKey = readStoredLicenseKey(snapshotBefore.currentState);
    const domainForRemote = snapshotBefore.claims?.domain ?? snapshotBefore.binding.panelDomain;

    let remoteDeactivated = false;
    if (notifyRemote && storedKey && domainForRemote) {
      try {
        const remote = await postCommerceJson('/v1/entitlements/deactivate', {
          licenseKey: storedKey,
          domain: domainForRemote,
          instanceId: snapshotBefore.currentState.instanceId,
          productCode: YUNPANEL_PRODUCT_CODE,
        });
        const deactivatePayload = unwrapCommercePayload(remote.payload);
        remoteDeactivated = Boolean(remote.ok && deactivatePayload?.deactivated !== false);
      } catch {
        remoteDeactivated = false;
      }
    }

    return withStoreLock(async () => {
      const latestState = syncStateFromDisk();
      writePersistedState({
        schemaVersion: STORE_SCHEMA_VERSION,
        instanceId: latestState.instanceId,
        entitlementToken: null,
        maskedLicenseKey: null,
        encryptedLicenseKey: null,
        plainLicenseKey: null,
        activatedAt: null,
        refreshedAt: null,
        remoteInvalidation: null,
        licenseWatermarks: latestState.licenseWatermarks,
      });

      return Object.freeze({
        ...getStatus({ includeManagementDetails: true }),
        remoteDeactivated,
      });
    });
  }

  return Object.freeze({
    getStatus,
    hasCapability,
    requireCapability,
    activate,
    refresh,
    deactivate,
  });
}
