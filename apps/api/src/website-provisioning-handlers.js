import { createWebsiteIdentityManager } from '@yunpanel/host-runtime';

export class WebsiteProvisioningHandlerError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'WebsiteProvisioningHandlerError';
    this.code = code;
    this.status = status;
  }
}

function identityIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || typeof intent.unixUser !== 'string'
    || typeof intent.homeDirectory !== 'string') {
    throw new WebsiteProvisioningHandlerError(
      'website_identity_intent_invalid',
      'Website Unix identity provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    user: intent.unixUser,
    homeDirectory: intent.homeDirectory,
  });
}

export function createWebsiteProvisioningHandlers({
  identityManager = createWebsiteIdentityManager(),
} = {}) {
  if (!identityManager
    || typeof identityManager.apply !== 'function'
    || typeof identityManager.inspect !== 'function') {
    throw new WebsiteProvisioningHandlerError(
      'website_provisioning_handler_dependencies_invalid',
      'Website provisioning handler dependencies are invalid',
    );
  }

  return Object.freeze({
    unix_identity: Object.freeze({
      apply: ({ intent } = {}) => identityManager.apply(identityIntent(intent)),
      inspect: ({ intent } = {}) => identityManager.inspect(identityIntent(intent)),
    }),
  });
}

export const websiteProvisioningHandlerInternals = Object.freeze({
  identityIntent,
});
