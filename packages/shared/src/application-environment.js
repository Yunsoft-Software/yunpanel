import { ApplicationValidationError } from './application.js';

const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESERVED_KEYS = new Set([
  'NODE_ENV',
  'HOST',
  'PORT',
  'YUNPANEL_APPLICATION_ID',
]);
const MAX_ENVIRONMENT_VARIABLES = 100;
const MAX_ENVIRONMENT_VALUE_LENGTH = 8192;

export function normalizeEnvironmentKey(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_KEY_PATTERN.test(value)) {
    throw new ApplicationValidationError('invalid_environment_key', 'Environment variable name is invalid');
  }
  if (RESERVED_KEYS.has(value)) {
    throw new ApplicationValidationError('reserved_environment_key', 'Environment variable name is managed by YunPanel');
  }
  return value;
}

export function normalizeEnvironmentValue(value) {
  if (
    typeof value !== 'string'
    || value.length > MAX_ENVIRONMENT_VALUE_LENGTH
    || value.includes('\u0000')
    || value.includes('\n')
    || value.includes('\r')
  ) {
    throw new ApplicationValidationError('invalid_environment_value', 'Environment variable value is invalid');
  }
  return value;
}

export function normalizeApplicationEnvironmentBundle(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_environment_bundle', 'Application environment bundle must be an object');
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_ENVIRONMENT_VARIABLES) {
    throw new ApplicationValidationError('environment_limit_exceeded', `Application environment supports at most ${MAX_ENVIRONMENT_VARIABLES} variables`);
  }

  const normalized = {};
  for (const [key, rawValue] of entries) {
    const normalizedKey = normalizeEnvironmentKey(key);
    normalized[normalizedKey] = normalizeEnvironmentValue(rawValue);
  }
  return normalized;
}

export const applicationEnvironmentPolicy = Object.freeze({
  maxVariables: MAX_ENVIRONMENT_VARIABLES,
  maxValueLength: MAX_ENVIRONMENT_VALUE_LENGTH,
  reservedKeys: Object.freeze([...RESERVED_KEYS]),
});
