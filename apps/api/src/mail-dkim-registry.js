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

function keyFileName(mailDomainId, selector) {
  return `${mailDomainId}.${selector}.key`;
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
    'mailDomainId', 'domainName', 'selector', 'algorithm', 'publicKey', 'revision', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size || Object.keys(record).some((field) => !fields.has(field))
    || record.algorithm !== ALGORITHM || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key state is invalid', 409);
  }
  const id = uuid(record.mailDomainId);
  const selector = normalizeSelector(record.selector);
  dnsRecord(record.domainName, selector, record.publicKey);
  return {
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
  filePath = null,
  keyRoot = null,
  now = () => Date.now(),
  getMailDomain = async () => null,
  generateKeyPairFn = generateKeyPairAsync,
} = {}) {
  if (typeof now !== 'function' || typeof getMailDomain !== 'function' || typeof generateKeyPairFn !== 'function'
    || (filePath !== null && keyRoot === null)
    || (filePath !== null && (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath))
    || (keyRoot !== null && (!path.isAbsolute(keyRoot) || path.normalize(keyRoot) !== keyRoot))) {
    throw new MailDkimRegistryError('mail_dkim_dependencies_invalid', 'DKIM key registry dependencies are invalid', 503);
  }

  let state = { version: STORE_VERSION, keys: [] };
  const memoryKeys = new Map();
  let initialized = false;
  let mutationChain = Promise.resolve();

  async function persist(nextState) {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
    await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_MODE });
    await rename(temporary, filePath);
    await chmod(filePath, PRIVATE_MODE);
  }

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

  function privateKeyPath(record) {
    if (!keyRoot) return null;
    return path.join(keyRoot, keyFileName(record.mailDomainId, record.selector));
  }

  async function readPrivateKey(record) {
    const keyPath = privateKeyPath(record);
    if (!keyPath) {
      const content = memoryKeys.get(keyFileName(record.mailDomainId, record.selector));
      if (typeof content !== 'string') {
        throw new MailDkimRegistryError('mail_dkim_private_key_missing', 'DKIM private key material is unavailable', 409);
      }
      return content;
    }
    try {
      const metadata = await lstat(keyPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== PRIVATE_MODE) {
        throw new MailDkimRegistryError('mail_dkim_private_key_unsafe', 'DKIM private key file is unsafe', 409);
      }
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

  async function writePrivateKey(record, privateKeyPem) {
    const name = keyFileName(record.mailDomainId, record.selector);
    if (!keyRoot) {
      if (memoryKeys.has(name)) {
        throw new MailDkimRegistryError('mail_dkim_private_key_exists', 'DKIM private key material already exists', 409);
      }
      memoryKeys.set(name, privateKeyPem);
      return { name, path: null };
    }
    await mkdir(keyRoot, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(keyRoot, DIRECTORY_MODE);
    const target = path.join(keyRoot, name);
    try {
      await lstat(target);
      throw new MailDkimRegistryError(
        'mail_dkim_orphan_key_exists',
        'DKIM private key path already exists without reusable registry state',
        409,
      );
    } catch (error) {
      if (error instanceof MailDkimRegistryError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new MailDkimRegistryError('mail_dkim_private_key_unavailable', 'DKIM private key path could not be inspected', 503);
      }
    }
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, privateKeyPem, { encoding: 'utf8', mode: PRIVATE_MODE });
    await rename(temporary, target);
    await chmod(target, PRIVATE_MODE);
    return { name, path: target };
  }

  async function removeCreatedPrivateKey(created) {
    if (!created) return;
    if (created.path) {
      try { await rm(created.path, { force: true }); } catch {}
    } else {
      memoryKeys.delete(created.name);
    }
  }

  async function verifyRecord(record) {
    const mailDomain = await resolveMailDomain(record.mailDomainId);
    if (mailDomain.domainName !== record.domainName) {
      throw new MailDkimRegistryError('mail_dkim_domain_drift', 'DKIM key domain identity no longer matches mail domain state', 409);
    }
    await readPrivateKey(record);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.keys)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'keys'].includes(field))) {
          throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key store is invalid', 409);
        }
        const keys = parsed.keys.map(validatePersisted);
        if (new Set(keys.map((record) => record.mailDomainId)).size !== keys.length) {
          throw new MailDkimRegistryError('mail_dkim_state_invalid', 'DKIM key identities are not unique', 409);
        }
        for (const record of keys) await verifyRecord(record);
        state = { version: STORE_VERSION, keys };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist(state);
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function mutate(operation) {
    const result = mutationChain.then(async () => {
      const next = structuredClone(state);
      const output = await operation(next);
      await persist(next);
      state = next;
      return output;
    });
    mutationChain = result.catch(() => {});
    return result;
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
    const mailDomain = await resolveMailDomain(id);
    return mutate(async (next) => {
      if (next.keys.some((record) => record.mailDomainId === id)) {
        throw new MailDkimRegistryError('mail_dkim_key_exists', 'DKIM key already exists for this mail domain', 409);
      }
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
        mailDomainId: id,
        domainName: mailDomain.domainName,
        selector: dkimSelector,
        algorithm: ALGORITHM,
        publicKey,
        revision: 1,
        createdAt: current,
        updatedAt: current,
      };
      const created = await writePrivateKey(record, privateKeyPem);
      next.keys.push(record);
      try {
        await persist(next);
      } catch (error) {
        await removeCreatedPrivateKey(created);
        throw error;
      }
      return publicKeyMetadata(record);
    });
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
  keyFileName,
  publicKeyFromPrivate,
  validatePersisted,
});
