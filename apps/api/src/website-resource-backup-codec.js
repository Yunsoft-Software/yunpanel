import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assertUuid } from '@yunpanel/shared';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const failure = () => Object.assign(new Error('Protected website backup could not be verified'), { code: 'website_resource_backup_invalid', status: 409 });
export function createWebsiteResourceBackupCodec({ masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY } = {}) {
  const key = normalizeEnvironmentMasterKey(masterKey);
  function context({ websiteId, resourceId, kind }) {
    try { assertUuid(websiteId, 'website'); assertUuid(resourceId, 'resource'); }
    catch { throw failure(); }
    if (!['mail', 'environment', 'hosting', 'dns'].includes(kind)) throw failure();
    return Buffer.from(JSON.stringify([1, websiteId, resourceId, kind]));
  }
  function encode(identity, data) {
    if (!key) throw failure();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context(identity));
    const plaintext = Buffer.from(JSON.stringify(data));
    if (plaintext.length > 32 * 1024 * 1024) throw failure();
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({ version: 1, ...identity, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  }
  function decode(identity, source) {
    try {
      if (!key || typeof source !== 'string' || source.length > 48 * 1024 * 1024) throw failure();
      const envelope = JSON.parse(source);
      if (envelope.version !== 1 || ['websiteId', 'resourceId', 'kind'].some(field => envelope[field] !== identity[field])) throw failure();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(context(identity));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw failure(); }
  }
  return Object.freeze({ encode, decode, configured: Boolean(key) });
}
