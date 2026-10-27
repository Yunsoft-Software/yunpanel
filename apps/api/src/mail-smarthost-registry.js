import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

// One outbound relay per local server. The password is sealed with the panel master
// key (AES-256-GCM, bound to the record identity) and is never returned publicly.
const ALGORITHM = 'aes-256-gcm';

export class MailSmarthostRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailSmarthostRegistryError';
    this.code = code;
    this.status = status;
  }
}

function masterKey(value) {
  let key = null;
  try { key = normalizeEnvironmentMasterKey(value); } catch { key = null; }
  if (!key) throw new MailSmarthostRegistryError('secret_store_unavailable', 'Panel secret master key is required to store relay credentials', 503);
  return key;
}

function aad(serverId, revision) {
  return Buffer.from(`yunpanel:mail-smarthost:v1:${serverId}:${revision}`);
}

export function createMailSmarthostRegistry({ filePath = null, masterKey: rawKey = process.env.YUNPANEL_SECRET_MASTER_KEY, now = () => Date.now() } = {}) {
  let state = { version: 1, servers: {} };
  let loaded = !filePath;

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !parsed.servers || typeof parsed.servers !== 'object') throw new Error('invalid');
      state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new MailSmarthostRegistryError('smarthost_store_invalid', 'Relay settings store is unreadable', 500);
    }
    loaded = true;
  }

  async function persist() {
    if (!filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  }

  function publicView(record) {
    if (!record) return { configured: false };
    return { configured: true, host: record.host, port: record.port, username: record.username, revision: record.revision, updatedAt: record.updatedAt };
  }

  async function get(serverId) {
    await load();
    return publicView(state.servers[serverId]);
  }

  async function password(serverId) {
    await load();
    const record = state.servers[serverId];
    if (!record) return null;
    try {
      const decipher = createDecipheriv(ALGORITHM, masterKey(rawKey), Buffer.from(record.secret.iv, 'base64'));
      decipher.setAAD(aad(serverId, record.revision));
      decipher.setAuthTag(Buffer.from(record.secret.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.secret.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof MailSmarthostRegistryError) throw error;
      throw new MailSmarthostRegistryError('smarthost_secret_unreadable', 'Stored relay credential could not be decrypted', 500);
    }
  }

  async function save(serverId, { host, port, username, password: secret }) {
    await load();
    const revision = (state.servers[serverId]?.revision ?? 0) + 1;
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, masterKey(rawKey), iv);
    cipher.setAAD(aad(serverId, revision));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    state.servers[serverId] = { host, port, username, revision, updatedAt: new Date(now()).toISOString(),
      secret: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } };
    await persist();
    return publicView(state.servers[serverId]);
  }

  async function remove(serverId) {
    await load();
    const existed = Boolean(state.servers[serverId]);
    delete state.servers[serverId];
    await persist();
    return existed;
  }

  return Object.freeze({ get, password, save, remove });
}
