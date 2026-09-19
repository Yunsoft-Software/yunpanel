import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STORE_PATH = '/var/lib/yunpanel/control-plane/website-cache-policies.json';
const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class WebsiteCachePolicyRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteCachePolicyRegistryError';
    this.code = code;
    this.status = status;
  }
}

function deriveKey(masterKey) {
  if (typeof masterKey !== 'string' || masterKey.length < 32) {
    throw new WebsiteCachePolicyRegistryError(
      'master_key_invalid',
      'Master key is required and must be at least 32 characters',
      500,
    );
  }
  return Buffer.from(masterKey.slice(0, 32), 'utf8');
}

export function encryptSecret(plaintext, masterKey) {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(encryptedPayload, masterKey) {
  const key = deriveKey(masterKey);
  const parts = String(encryptedPayload ?? '').split(':');
  if (parts.length !== 3) {
    throw new WebsiteCachePolicyRegistryError('encrypted_secret_invalid', 'Encrypted secret payload is invalid', 500);
  }
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new WebsiteCachePolicyRegistryError('encrypted_secret_invalid', 'Encrypted secret payload is invalid', 500);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function createWebsiteCachePolicyRegistry({
  filePath = DEFAULT_STORE_PATH,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  mkdirFn = mkdir,
} = {}) {
  let policies = new Map();
  let initialized = false;

  async function atomicWrite(targetPath, content) {
    const dir = path.dirname(targetPath);
    await mkdirFn(dir, { recursive: true, mode: 0o700 });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFileFn(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await renameFn(tempPath, targetPath);
  }

  async function init() {
    if (initialized) return;
    try {
      const raw = await readFileFn(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === STORE_VERSION && parsed.policies) {
        policies = new Map(Object.entries(parsed.policies));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WebsiteCachePolicyRegistryError('cache_store_corrupted', 'Cache policy store could not be read', 500);
      }
      policies = new Map();
    }
    initialized = true;
  }

  async function persist() {
    const payload = {
      version: STORE_VERSION,
      policies: Object.fromEntries(policies),
    };
    await atomicWrite(filePath, JSON.stringify(payload, null, 2));
  }

  async function get(websiteId) {
    await init();
    return policies.get(websiteId) ?? null;
  }

  async function set(websiteId, policy) {
    await init();
    if (!websiteId || typeof websiteId !== 'string') {
      throw new WebsiteCachePolicyRegistryError('website_id_invalid', 'Website ID is invalid');
    }
    const record = Object.freeze({
      ...policy,
      websiteId,
      updatedAt: new Date().toISOString(),
    });
    policies.set(websiteId, record);
    await persist();
    return record;
  }

  async function remove(websiteId) {
    await init();
    if (!policies.has(websiteId)) return false;
    policies.delete(websiteId);
    await persist();
    return true;
  }

  async function list() {
    await init();
    return Array.from(policies.values());
  }

  return Object.freeze({
    init,
    get,
    set,
    delete: remove,
    list,
    encryptSecret: (plaintext) => encryptSecret(plaintext, masterKey),
    decryptSecret: (ciphertext) => decryptSecret(ciphertext, masterKey),
  });
}
