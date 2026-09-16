import { assertUuid } from '@yunpanel/shared';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);

export class WebsiteSftpKeyServiceError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteSftpKeyServiceError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new WebsiteSftpKeyServiceError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
      400,
    );
  }
}

function materializationFailure(error, fallbackCode, fallbackMessage) {
  if (error instanceof WebsiteSftpKeyServiceError) return error;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : fallbackMessage;
  const conflict = /(?:drift|conflict|mismatch|invalid|duplicate|escape)/.test(code);
  return new WebsiteSftpKeyServiceError(code, message, conflict ? 409 : 503);
}

function publicMaterialization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ satisfied: false, reason: 'sftp_authorized_keys_inspection_unavailable' });
  }
  if (value.satisfied === true) {
    return Object.freeze({
      satisfied: true,
      adapter: value.adapter === 'openssh-authorized-keys' ? value.adapter : null,
      keyCount: Number.isSafeInteger(value.keyCount) ? value.keyCount : null,
      sha256: typeof value.sha256 === 'string' ? value.sha256 : null,
    });
  }
  return Object.freeze({
    satisfied: false,
    reason: typeof value.reason === 'string' ? value.reason : 'sftp_authorized_keys_not_satisfied',
    ...(typeof value.currentSha256 === 'string' ? { currentSha256: value.currentSha256 } : {}),
    ...(typeof value.desiredSha256 === 'string' ? { desiredSha256: value.desiredSha256 } : {}),
  });
}

export function createWebsiteSftpKeyService({
  keyRegistry,
  websiteRegistry,
  authorizedKeyManager,
} = {}) {
  if (!keyRegistry
    || typeof keyRegistry.addKey !== 'function'
    || typeof keyRegistry.listKeys !== 'function'
    || typeof keyRegistry.revokeKey !== 'function'
    || typeof keyRegistry.rotateKey !== 'function'
    || typeof keyRegistry.listActiveMaterial !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !authorizedKeyManager
    || typeof authorizedKeyManager.inspect !== 'function'
    || typeof authorizedKeyManager.apply !== 'function') {
    throw new WebsiteSftpKeyServiceError(
      'sftp_key_service_dependencies_invalid',
      'SFTP key service dependencies are unavailable',
      503,
    );
  }

  async function websiteIdentity(rawWebsiteId) {
    const websiteId = uuid(rawWebsiteId, 'websiteId');
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) throw new WebsiteSftpKeyServiceError('website_not_found', 'Website not found', 404);
    if (!HOSTED_RUNTIME_TYPES.has(website.runtimeType)
      || typeof website.applicationId !== 'string'
      || typeof website.unixUser !== 'string') {
      throw new WebsiteSftpKeyServiceError(
        'sftp_key_website_unsupported',
        'Website does not have a managed SFTP Unix identity',
        409,
      );
    }
    return Object.freeze({
      websiteId,
      applicationId: uuid(website.applicationId, 'applicationId'),
      unixUser: website.unixUser,
    });
  }

  async function desiredIntent(rawWebsiteId) {
    const identity = await websiteIdentity(rawWebsiteId);
    const material = await keyRegistry.listActiveMaterial(identity.websiteId);
    for (const entry of material) {
      if (entry.websiteId !== identity.websiteId
        || entry.applicationId !== identity.applicationId
        || entry.unixUser !== identity.unixUser) {
        throw new WebsiteSftpKeyServiceError(
          'sftp_key_website_drift',
          'SFTP key material does not match the current Website identity',
          409,
        );
      }
    }
    return Object.freeze({
      websiteId: identity.websiteId,
      applicationId: identity.applicationId,
      unixUser: identity.unixUser,
      keys: Object.freeze(material.map((entry) => Object.freeze({
        id: entry.id,
        publicKey: entry.publicKey,
        fingerprint: entry.fingerprint,
        revision: entry.revision,
      }))),
    });
  }

  async function inspectMaterialization(rawWebsiteId) {
    let intent;
    try { intent = await desiredIntent(rawWebsiteId); }
    catch (error) { throw materializationFailure(error, 'sftp_key_inspection_failed', 'SFTP key desired state could not be resolved'); }
    try {
      return publicMaterialization(await authorizedKeyManager.inspect(intent));
    } catch (error) {
      const mapped = materializationFailure(error, 'sftp_key_inspection_failed', 'SFTP key host state could not be inspected');
      return Object.freeze({ satisfied: false, reason: mapped.code });
    }
  }

  async function reconcile(rawWebsiteId) {
    let intent;
    try { intent = await desiredIntent(rawWebsiteId); }
    catch (error) { throw materializationFailure(error, 'sftp_key_reconcile_failed', 'SFTP key desired state could not be resolved'); }
    try {
      return publicMaterialization(await authorizedKeyManager.apply(intent));
    } catch (error) {
      throw materializationFailure(error, 'sftp_key_reconcile_failed', 'SFTP authorized keys could not be materialized');
    }
  }

  async function list(rawWebsiteId) {
    const identity = await websiteIdentity(rawWebsiteId);
    const [keys, materialization] = await Promise.all([
      keyRegistry.listKeys({ websiteId: identity.websiteId }),
      inspectMaterialization(identity.websiteId),
    ]);
    return Object.freeze({
      websiteId: identity.websiteId,
      keys: Object.freeze([...keys]),
      materialization,
    });
  }

  async function reconcileAfterMutation(websiteId, result) {
    try {
      const materialization = await reconcile(websiteId);
      return Object.freeze({ ...result, materialization });
    } catch (error) {
      throw new WebsiteSftpKeyServiceError(
        'sftp_key_reconcile_required',
        'SFTP key state was saved, but authorized_keys materialization requires reconciliation',
        503,
      );
    }
  }

  async function add(input = {}) {
    const identity = await websiteIdentity(input.websiteId);
    const key = await keyRegistry.addKey({
      websiteId: identity.websiteId,
      label: input.label,
      publicKey: input.publicKey,
    });
    return reconcileAfterMutation(identity.websiteId, { key });
  }

  async function revoke(input = {}) {
    const identity = await websiteIdentity(input.websiteId);
    const key = await keyRegistry.revokeKey({
      websiteId: identity.websiteId,
      keyId: uuid(input.keyId, 'sftpKeyId'),
      expectedRevision: input.expectedRevision,
    });
    return reconcileAfterMutation(identity.websiteId, { key });
  }

  async function rotate(input = {}) {
    const identity = await websiteIdentity(input.websiteId);
    const rotation = await keyRegistry.rotateKey({
      websiteId: identity.websiteId,
      keyId: uuid(input.keyId, 'sftpKeyId'),
      expectedRevision: input.expectedRevision,
      label: input.label,
      publicKey: input.publicKey,
    });
    return reconcileAfterMutation(identity.websiteId, { rotation });
  }

  return Object.freeze({
    list,
    add,
    revoke,
    rotate,
    reconcile,
    inspectMaterialization,
  });
}

export const websiteSftpKeyServiceInternals = Object.freeze({
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  uuid,
  publicMaterialization,
  materializationFailure,
});
