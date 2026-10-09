import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';
import { createProcessStoreLock } from './process-store-lock.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const failure = code => Object.assign(new Error('İşlem parolası güvenli depodan okunamadı'), { code, status: 503 });

// Short-lived operation secrets use the existing panel key and private filesystem.
// Jobs carry only a random reference. This store is not an application environment.
export function createOperationSecretStore({ root, masterKey, now = Date.now } = {}) {
  const key = normalizeEnvironmentMasterKey(masterKey);
  if (!key || typeof root !== 'string' || !path.isAbsolute(root)) throw failure('operation_secret_store_invalid');
  function identity(id, websiteId, purpose) {
    if (!UUID.test(id ?? '') || !UUID.test(websiteId ?? '') || !['wordpress.install', 'wordpress.password'].includes(purpose)) throw failure('operation_secret_identity_invalid');
    return `${id}:${websiteId}:${purpose}`;
  }
  function file(id) {
    if (!UUID.test(id ?? '')) throw failure('operation_secret_identity_invalid');
    return path.join(root, `${id}.json`);
  }
  async function put({ id, websiteId, purpose, value, ttlMs = 24 * 60 * 60 * 1000 }) {
    const aad = identity(id, websiteId, purpose);
    if (typeof value !== 'string' || value.length < 16 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) throw failure('operation_secret_value_invalid');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw failure('operation_secret_directory_invalid');
    const lock = createProcessStoreLock({ filePath: file(id) });
    return lock.withLock(async () => {
      try { await lstat(file(id)); throw failure('operation_secret_exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const expiresAt = new Date(now() + ttlMs).toISOString();
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${aad}:${expiresAt}`));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const record = { version: 1, id, websiteId, purpose, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'), expiresAt };
      const temporary = `${file(id)}.${randomBytes(8).toString('hex')}.tmp`;
      try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); await rename(temporary, file(id)); }
      finally { await rm(temporary, { force: true }); }
      return { id, expiresAt: record.expiresAt };
    });
  }
  async function read({ id, websiteId, purpose }) {
    const aad = identity(id, websiteId, purpose);
    try {
      const metadata = await lstat(file(id));
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 4096) throw failure('operation_secret_file_invalid');
      const record = JSON.parse(await readFile(file(id), 'utf8'));
      if (record.version !== 1 || record.id !== id || record.websiteId !== websiteId || record.purpose !== purpose
        || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now()) throw failure('operation_secret_expired');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${aad}:${record.expiresAt}`)); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error.code?.startsWith('operation_secret_')) throw error;
      throw failure('operation_secret_read_failed');
    }
  }
  async function remove({ id, websiteId, purpose }) {
    identity(id, websiteId, purpose);
    const lock = createProcessStoreLock({ filePath: file(id) });
    await lock.withLock(async () => {
      // Ownership is checked before deleting an existing reference.
      try {
        const record = JSON.parse(await readFile(file(id), 'utf8'));
        if (record.websiteId !== websiteId || record.purpose !== purpose) throw failure('operation_secret_identity_invalid');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rm(file(id), { force: true });
    });
  }
  return Object.freeze({ put, read, remove });
}
