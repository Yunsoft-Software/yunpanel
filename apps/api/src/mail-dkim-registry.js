import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  randomBytes,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  MailDkimTemplateError,
  managedDkimDnsRecord,
  mailDkimTemplatePolicy,
} from '@yunpanel/config-templates';
import { assertUuid } from '@yunpanel/shared';

const generateKeyPairAsync = promisify(generateKeyPair);
const STORE_VERSION = 1;
const PRIVATE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const ALGORITHM = 'rsa-sha256';
const RSA_BITS = 2048;
const METADATA_FILE = 'metadata.json';
const PRIVATE_KEY_FILE = 'private.pem';
const PENDING_PREFIX = '.pending-';

export class MailDkimRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDkimRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value) {
  try { return assertUuid(value, 'mailDomainId'); }
  catch { throw new MailDkimRegistryError('invalid_mail_domain_id', 'mailDomainId is invalid'); }
}

function revision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MailDkimRegistryError(
      'invalid_mail_dkim_revision',
      `expectedRevision must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailDkimRegistryError('mail_dkim_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function normalizeSelector(value) {
  if (typeof value !== 'string' || !mailDkimTemplatePolicy.selectorPattern.test(value)) {
    throw new MailDkimRegistryError(
      'invalid_mail_dkim_selector',
      'DKIM selector must contain only lowercase letters, numbers and interior hyphens',
    );
  }
  return value;
}

function dnsRecord(domainName, selector, publicKey) {
  try { return managedDkimDnsRecord({ domain: domainName, selector, publicKey }); }
  catch (error) {
    if (error instanceof MailDkimTemplateError) {
      throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM public metadata is invalid', 409);
    }
    throw error;
  }
}

function publicKeyFromPrivate(privateKeyPem) {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    throw new MailDkimRegistryError('mail_dkim_private_key_invalid', 'DKIM private key material is invalid', 409);
  }
}

function publicKeyMetadata(record) {
  return Object.freeze({
    mailDomainId: record.mailDomainId,
    domainName: record.domainName,
    selector: record.selector,
    algorithm: record.algorithm,
    publicKey: record.publicKey,
    dnsRecord: dnsRecord(record.domainName, record.selector, record.publicKey),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function validatePersisted(record) {
  const fields = new Set([
    'version', 'mailDomainId', 'domainName', 'selector', 'algorithm', 'publicKey',
    'revision', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || record.version !== STORE_VERSION || record.algorithm !== ALGORITHM
    || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key state is invalid', 409);
  }
  const id = uuid(record.mailDomainId);
  const selector = normalizeSelector(record.selector);
  dnsRecord(record.domainName, selector, record.publicKey);
  return {
    version: STORE_VERSION,
    mailDomainId: id,
    domainName: record.domainName,
    selector,
    algorithm: ALGORITHM,
    publicKey: record.publicKey,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

export function createMailDkimRegistry({
  keyRoot = null,
  now = () => Date.now(),
  getMailDomain = async () => null,
  generateKeyPairFn = generateKeyPairAsync,
} = {}) {
  if (typeof now !== 'function' || typeof getMailDomain !== 'function' || typeof generateKeyPairFn !== 'function'
    || (keyRoot !== null && (!path.isAbsolute(keyRoot) || path.normalize(keyRoot) !== keyRoot))) {
    throw new MailDkimRegistryError('mail_dkim_dependencies_invalid', 'DKIM key registry dependencies are invalid', 503);
  }

  let state = { version: STORE_VERSION, keys: [] };
  const memoryKeys = new Map();
  let initialized = false;
  let mutationChain = Promise.resolve();

  async function resolveMailDomain(mailDomainId) {
    let mailDomain;
    try { mailDomain = await getMailDomain(mailDomainId); }
    catch { throw new MailDkimRegistryError('mail_domain_unavailable', 'Mail domain could not be verified', 503); }
    if (!mailDomain || mailDomain.id !== mailDomainId) {
      throw new MailDkimRegistryError('mail_domain_not_found', 'Mail domain was not found', 404);
    }
    if (mailDomain.managementMode !== 'local') {
      throw new MailDkimRegistryError('mail_domain_not_locally_managed', 'Mail domain is not locally managed', 409);
    }
    if (typeof mailDomain.domainName !== 'string' || !mailDomain.domainName) {
      throw new MailDkimRegistryError('mail_domain_invalid', 'Mail domain identity is invalid', 409);
    }
    return mailDomain;
  }

  function finalDirectory(mailDomainId) {
    if (!keyRoot) return null;
    return path.join(keyRoot, mailDomainId);
  }

  async function assertPrivateEntry(filePath, expectedMode = PRIVATE_MODE) {
    try {
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== expectedMode) {
        throw new MailDkimRegistryError('mail_dkim_private_key_unsafe', 'DKIM private state file is unsafe', 409);
      }
      return metadata;
    } catch (error) {
      if (error instanceof MailDkimRegistryError) throw error;
      if (error?.code === 'ENOENT') {
        throw new MailDkimRegistryError('mail_dkim_private_key_missing', 'DKIM private key material is unavailable', 409);
      }
      throw new MailDkimRegistryError('mail_dkim_private_key_unavailable', 'DKIM private state could not be inspected', 503);
    }
  }

  async function readPrivateKey(record) {
    if (!keyRoot) {
      const content = memoryKeys.get(record.mailDomainId);
      if (typeof content !== 'string') {
        throw new MailDkimRegistryError('mail_dkim_private_key_missing', 'DKIM private key material is unavailable', 409);
      }
      return content;
    }
    const directory = finalDirectory(record.mailDomainId);
    try {
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()
        || (directoryMetadata.mode & 0o777) !== DIRECTORY_MODE) {
        throw new MailDkimRegistryError('mail_dkim_private_key_unsafe', 'DKIM key directory is unsafe', 409);
      }
      const keyPath = path.join(directory, PRIVATE_KEY_FILE);
      await assertPrivateEntry(keyPath);
      const content = await readFile(keyPath, 'utf8');
      if (publicKeyFromPrivate(content) !== record.publicKey) {
        throw new MailDkimRegistryError('mail_dkim_private_key_mismatch', 'DKIM private key does not match public metadata', 409);
      }
      return content;
    } catch (error) {
      if (error instanceof MailDkimRegistryError) throw error;
      if (error?.code === 'ENOENT') {
        throw new MailDkimRegistryError('mail_dkim_private_key_missing', 'DKIM private key material is unavailable', 409);
      }
      throw new MailDkimRegistryError('mail_dkim_private_key_unavailable', 'DKIM private key could not be inspected', 503);
    }
  }

  async function verifyRecord(record) {
    const mailDomain = await resolveMailDomain(record.mailDomainId);
    if (mailDomain.domainName !== record.domainName) {
      throw new MailDkimRegistryError('mail_dkim_domain_drift', 'DKIM key domain identity no longer matches mail domain state', 409);
    }
    await readPrivateKey(record);
  }

  async function cleanupPendingEntries() {
    if (!keyRoot) return;
    const entries = await readdir(keyRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(PENDING_PREFIX)) continue;
      const target = path.join(keyRoot, entry.name);
      const metadata = await lstat(target);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM pending state is unsafe', 409);
      }
      await rm(target, { recursive: true, force: true });
    }
  }

  async function loadPersistentState() {
    await mkdir(keyRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(keyRoot, DIRECTORY_MODE);
    await cleanupPendingEntries();
    const entries = await readdir(keyRoot, { withFileTypes: true });
    const keys = [];
    for (const entry of entries) {
      if (entry.name.startsWith(PENDING_PREFIX)) continue;
      const id = uuid(entry.name);
      const directory = path.join(keyRoot, entry.name);
      const directoryMetadata = await lstat(directory);
      if (!entry.isDirectory() || directoryMetadata.isSymbolicLink()
        || (directoryMetadata.mode & 0o777) !== DIRECTORY_MODE) {
        throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key directory is invalid', 409);
      }
      const metadataPath = path.join(directory, METADATA_FILE);
      await assertPrivateEntry(metadataPath);
      let parsed;
      try { parsed = JSON.parse(await readFile(metadataPath, 'utf8')); }
      catch { throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key metadata is invalid', 409); }
      const record = validatePersisted(parsed);
      if (record.mailDomainId !== id) {
        throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key directory identity does not match metadata', 409);
      }
      await verifyRecord(record);
      keys.push(record);
    }
    if (new Set(keys.map((record) => record.mailDomainId)).size !== keys.length) {
      throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key identities are not unique', 409);
    }
    state = { version: STORE_VERSION, keys: keys.sort((left, right) => left.domainName.localeCompare(right.domainName)) };
  }

  async function init() {
    if (initialized) return;
    if (keyRoot) await loadPersistentState();
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function commitPersistentRecord(record, privateKeyPem) {
    if (!keyRoot) {
      if (memoryKeys.has(record.mailDomainId)) {
        throw new MailDkimRegistryError('mail_dkim_key_exists', 'DKIM key already exists for this mail domain', 409);
      }
      memoryKeys.set(record.mailDomainId, privateKeyPem);
      return;
    }
    const target = finalDirectory(record.mailDomainId);
    try {
      await lstat(target);
      throw new MailDkimRegistryError('mail_dkim_key_exists', 'DKIM key already exists for this mail domain', 409);
    } catch (error) {
      if (error instanceof MailDkimRegistryError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new MailDkimRegistryError('mail_dkim_private_key_unavailable', 'DKIM key target could not be inspected', 503);
      }
    }
    const pending = path.join(
      keyRoot,
      `${PENDING_PREFIX}${record.mailDomainId}-${randomBytes(6).toString('hex')}`,
    );
    await mkdir(pending, { mode: DIRECTORY_MODE });
    try {
      const metadata = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(path.join(pending, METADATA_FILE), metadata, { encoding: 'utf8', mode: PRIVATE_MODE });
      await chmod(path.join(pending, METADATA_FILE), PRIVATE_MODE);
      await writeFile(path.join(pending, PRIVATE_KEY_FILE), privateKeyPem, { encoding: 'utf8', mode: PRIVATE_MODE });
      await chmod(path.join(pending, PRIVATE_KEY_FILE), PRIVATE_MODE);
      await rename(pending, target);
      await chmod(target, DIRECTORY_MODE);
    } catch (error) {
      try { await rm(pending, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  async function getKey(mailDomainId) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    await resolveMailDomain(id);
    const record = state.keys.find((candidate) => candidate.mailDomainId === id);
    return record ? publicKeyMetadata(record) : null;
  }

  async function listKeys() {
    await ensureInitialized();
    return state.keys
      .slice()
      .sort((left, right) => left.domainName.localeCompare(right.domainName))
      .map(publicKeyMetadata);
  }

  async function createKey(mailDomainId, { expectedRevision, selector: requestedSelector } = {}) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    const expected = revision(expectedRevision, { allowZero: true });
    if (expected !== 0) {
      throw new MailDkimRegistryError('stale_mail_dkim_revision', 'DKIM key state changed; refresh and retry', 409);
    }
    const dkimSelector = normalizeSelector(requestedSelector);
    const operation = mutationChain.then(async () => {
      if (state.keys.some((record) => record.mailDomainId === id)) {
        throw new MailDkimRegistryError('mail_dkim_key_exists', 'DKIM key already exists for this mail domain', 409);
      }
      const mailDomain = await resolveMailDomain(id);
      let generated;
      try {
        generated = await generateKeyPairFn('rsa', {
          modulusLength: RSA_BITS,
          publicKeyEncoding: { type: 'spki', format: 'der' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
      } catch {
        throw new MailDkimRegistryError('mail_dkim_key_generation_failed', 'DKIM key generation failed', 503);
      }
      const publicKey = Buffer.from(generated.publicKey).toString('base64');
      const privateKeyPem = String(generated.privateKey);
      if (publicKeyFromPrivate(privateKeyPem) !== publicKey) {
        throw new MailDkimRegistryError('mail_dkim_key_generation_failed', 'Generated DKIM keypair is inconsistent', 503);
      }
      dnsRecord(mailDomain.domainName, dkimSelector, publicKey);
      const current = new Date(now()).toISOString();
      const record = {
        version: STORE_VERSION,
        mailDomainId: id,
        domainName: mailDomain.domainName,
        selector: dkimSelector,
        algorithm: ALGORITHM,
        publicKey,
        revision: 1,
        createdAt: current,
        updatedAt: current,
      };
      await commitPersistentRecord(record, privateKeyPem);
      state = {
        version: STORE_VERSION,
        keys: [...state.keys, record].sort((left, right) => left.domainName.localeCompare(right.domainName)),
      };
      return publicKeyMetadata(record);
    });
    mutationChain = operation.catch(() => {});
    return operation;
  }

  async function materializePrivateKey(mailDomainId) {
    await ensureInitialized();
    const id = uuid(mailDomainId);
    const record = state.keys.find((candidate) => candidate.mailDomainId === id);
    if (!record) throw new MailDkimRegistryError('mail_dkim_key_not_found', 'DKIM key was not found', 404);
    await resolveMailDomain(id);
    const privateKey = await readPrivateKey(record);
    return Object.freeze({
      metadata: publicKeyMetadata(record),
      privateKey,
    });
  }

  return Object.freeze({
    init,
    getKey,
    listKeys,
    createKey,
    materializePrivateKey,
  });
}

export const mailDkimRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  privateMode: PRIVATE_MODE,
  directoryMode: DIRECTORY_MODE,
  algorithm: ALGORITHM,
  rsaBits: RSA_BITS,
  metadataFile: METADATA_FILE,
  privateKeyFile: PRIVATE_KEY_FILE,
  pendingPrefix: PENDING_PREFIX,
  publicKeyFromPrivate,
  validatePersisted,
});
