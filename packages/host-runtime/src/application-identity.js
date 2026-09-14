import { nodeApplicationUser } from '@yunpanel/config-templates';
import { createApplicationPathContract } from './website-path-contract.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApplicationIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationIdentityError';
    this.code = code;
  }
}

function normalizeApplicationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApplicationIdentityError('application_identity_invalid', 'Application identity is invalid');
  }
  return value.toLowerCase();
}

export function applicationUnixUser(applicationId) {
  return nodeApplicationUser(normalizeApplicationId(applicationId));
}

export function createApplicationIdentity(applicationId, pathOptions = {}) {
  const normalized = normalizeApplicationId(applicationId);
  const paths = createApplicationPathContract(normalized, pathOptions);
  return Object.freeze({
    applicationId: normalized,
    unixUser: applicationUnixUser(normalized),
    paths,
  });
}

export const applicationIdentityInternals = Object.freeze({
  uuidPattern: UUID_PATTERN,
  normalizeApplicationId,
});
