import { createSftpSiteManager } from '@yunpanel/host-runtime/sftp-site-manager';

export class WebsiteSftpProvisioningError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteSftpProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function sftpIntent(value) {
  const allowed = new Set(['adapter', 'websiteId', 'applicationId', 'unixUser']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.adapter !== 'openssh-internal-sftp'
    || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.websiteId !== 'string'
    || typeof value.applicationId !== 'string'
    || typeof value.unixUser !== 'string') {
    throw new WebsiteSftpProvisioningError(
      'website_sftp_intent_invalid',
      'Website SFTP provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    websiteId: value.websiteId,
    applicationId: value.applicationId,
    unixUser: value.unixUser,
  });
}

function keyMaterialization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteSftpProvisioningError(
      'sftp_key_reconcile_required',
      'SFTP authorized-key materialization could not be verified',
      409,
    );
  }
  if (value.satisfied !== true) {
    const reason = typeof value.reason === 'string' && /^[a-z0-9_]{1,120}$/.test(value.reason)
      ? value.reason
      : 'sftp_authorized_keys_not_satisfied';
    return Object.freeze({ satisfied: false, reason });
  }
  if (value.adapter !== 'openssh-authorized-keys'
    || !Number.isSafeInteger(value.keyCount) || value.keyCount < 0 || value.keyCount > 100
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new WebsiteSftpProvisioningError(
      'sftp_key_reconcile_required',
      'SFTP authorized-key materialization evidence is invalid',
      409,
    );
  }
  return Object.freeze({
    satisfied: true,
    adapter: value.adapter,
    keyCount: value.keyCount,
    sha256: value.sha256,
  });
}

function keyAwareEvidence(base, materialization) {
  if (base?.satisfied !== true) return base;
  if (materialization.satisfied !== true) {
    return Object.freeze({
      ...base,
      satisfied: false,
      reason: 'sftp_key_reconcile_required',
      keyReason: materialization.reason,
    });
  }
  return Object.freeze({
    ...base,
    authorizedKeysAdapter: materialization.adapter,
    authorizedKeyCount: materialization.keyCount,
    authorizedKeysSha256: materialization.sha256,
  });
}

export function createWebsiteSftpProvisioningHandler({
  sftpManager = createSftpSiteManager(),
} = {}) {
  if (!sftpManager || typeof sftpManager.apply !== 'function' || typeof sftpManager.inspect !== 'function'
    || typeof sftpManager.compensate !== 'function' || typeof sftpManager.inspectCompensation !== 'function') {
    throw new WebsiteSftpProvisioningError(
      'website_sftp_dependencies_invalid',
      'Website SFTP provisioning dependencies are invalid',
    );
  }

  return Object.freeze({
    apply: ({ intent, operationId } = {}) => sftpManager.apply(sftpIntent(intent), { operationId }),
    inspect: ({ intent, operationId } = {}) => sftpManager.inspect(sftpIntent(intent), { operationId }),
    previewMigration: ({ intent, operationId } = {}) => {
      if (typeof sftpManager.previewMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_preview_unavailable',
          'Website SFTP migration preview is unavailable',
          503,
        );
      }
      return sftpManager.previewMigration(sftpIntent(intent), { operationId });
    },
    inspectMigrationOperation: ({ intent, operationId } = {}) => {
      if (typeof sftpManager.inspectMigrationOperation !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return sftpManager.inspectMigrationOperation(sftpIntent(intent), { operationId });
    },
    applyMigration: ({ intent, operationId } = {}) => {
      if (typeof sftpManager.applyMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return sftpManager.applyMigration(sftpIntent(intent), { operationId });
    },
    compensate: ({ intent, operationId } = {}) => sftpManager.compensate(sftpIntent(intent), { operationId }),
    inspectCompensation: ({ intent, operationId } = {}) => sftpManager.inspectCompensation(sftpIntent(intent), { operationId }),
    inspectMigrationCompensation: ({ intent, operationId } = {}) => {
      if (typeof sftpManager.inspectMigrationCompensation !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return sftpManager.inspectMigrationCompensation(sftpIntent(intent), { operationId });
    },
    compensateMigration: ({ intent, operationId } = {}) => {
      if (typeof sftpManager.compensateMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return sftpManager.compensateMigration(sftpIntent(intent), { operationId });
    },
  });
}

export function createWebsiteSftpKeyAwareProvisioningHandler({ baseHandler, sftpKeyService } = {}) {
  if (!baseHandler || typeof baseHandler.apply !== 'function' || typeof baseHandler.inspect !== 'function'
    || typeof baseHandler.compensate !== 'function' || typeof baseHandler.inspectCompensation !== 'function'
    || !sftpKeyService || typeof sftpKeyService.reconcile !== 'function'
    || typeof sftpKeyService.inspectMaterialization !== 'function') {
    throw new WebsiteSftpProvisioningError(
      'website_sftp_key_dependencies_invalid',
      'Website SFTP key-aware provisioning dependencies are invalid',
    );
  }

  function websiteId(context) {
    const normalized = sftpIntent(context?.intent);
    if (context?.websiteId !== normalized.websiteId) {
      throw new WebsiteSftpProvisioningError(
        'website_sftp_operation_identity_drift',
        'Website SFTP provisioning operation identity has drifted',
        409,
      );
    }
    return normalized.websiteId;
  }

  return Object.freeze({
    async apply(context = {}) {
      const id = websiteId(context);
      const base = await baseHandler.apply(context);
      if (base?.satisfied !== true) return base;
      try {
        return keyAwareEvidence(base, keyMaterialization(await sftpKeyService.reconcile(id)));
      } catch {
        throw new WebsiteSftpProvisioningError(
          'sftp_key_reconcile_required',
          'SFTP isolation was prepared, but authorized keys require explicit reconciliation',
          503,
        );
      }
    },
    async inspect(context = {}) {
      const id = websiteId(context);
      const base = await baseHandler.inspect(context);
      if (base?.satisfied !== true) return base;
      try {
        return keyAwareEvidence(base, keyMaterialization(await sftpKeyService.inspectMaterialization(id)));
      } catch {
        return keyAwareEvidence(base, Object.freeze({
          satisfied: false,
          reason: 'sftp_key_reconcile_required',
        }));
      }
    },
    async previewMigration(context = {}) {
      const id = websiteId(context);
      if (typeof baseHandler.previewMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_preview_unavailable',
          'Website SFTP migration preview is unavailable',
          503,
        );
      }
      const base = await baseHandler.previewMigration(context);
      let authorizedKeys;
      try {
        authorizedKeys = keyMaterialization(await sftpKeyService.inspectMaterialization(id));
      } catch {
        authorizedKeys = Object.freeze({
          satisfied: false,
          reason: 'sftp_key_reconcile_required',
        });
      }
      return Object.freeze({
        ...base,
        authorizedKeys,
      });
    },
    async inspectMigrationOperation(context = {}) {
      const id = websiteId(context);
      if (typeof baseHandler.inspectMigrationOperation !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      const base = await baseHandler.inspectMigrationOperation(context);
      if (base?.satisfied !== true) return base;
      try {
        return keyAwareEvidence(base, keyMaterialization(await sftpKeyService.inspectMaterialization(id)));
      } catch {
        return keyAwareEvidence(base, Object.freeze({ satisfied: false, reason: 'sftp_key_reconcile_required' }));
      }
    },
    async applyMigration(context = {}) {
      const id = websiteId(context);
      if (typeof baseHandler.applyMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      const base = await baseHandler.applyMigration(context);
      if (base?.satisfied !== true) return base;
      try {
        return keyAwareEvidence(base, keyMaterialization(await sftpKeyService.reconcile(id)));
      } catch {
        throw new WebsiteSftpProvisioningError(
          'sftp_key_reconcile_required',
          'SFTP isolation was prepared, but authorized keys require explicit reconciliation',
          503,
        );
      }
    },
    compensate: (context = {}) => baseHandler.compensate(context),
    inspectCompensation: (context = {}) => baseHandler.inspectCompensation(context),
    inspectMigrationCompensation: (context = {}) => {
      if (typeof baseHandler.inspectMigrationCompensation !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return baseHandler.inspectMigrationCompensation(context);
    },
    compensateMigration: (context = {}) => {
      if (typeof baseHandler.compensateMigration !== 'function') {
        throw new WebsiteSftpProvisioningError(
          'website_sftp_migration_lifecycle_unavailable',
          'Website SFTP migration lifecycle is unavailable',
          503,
        );
      }
      return baseHandler.compensateMigration(context);
    },
  });
}

export const websiteSftpProvisioningInternals = Object.freeze({ sftpIntent, keyMaterialization, keyAwareEvidence });
