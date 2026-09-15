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
    compensate: ({ intent, operationId } = {}) => sftpManager.compensate(sftpIntent(intent), { operationId }),
    inspectCompensation: ({ intent, operationId } = {}) => sftpManager.inspectCompensation(sftpIntent(intent), { operationId }),
  });
}

export const websiteSftpProvisioningInternals = Object.freeze({ sftpIntent });
