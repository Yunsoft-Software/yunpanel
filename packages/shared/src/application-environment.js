import { ApplicationValidationError } from './application.js';

const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESERVED_KEYS = new Set([
  'NODE_ENV',
  'HOST',
  'PORT',
  'YUNPANEL_APPLICATION_ID',
  'YUNPANEL_GIT_CREDENTIAL',
]);
const MAX_ENVIRONMENT_VARIABLES = 100;
const MAX_ENVIRONMENT_VALUE_LENGTH = 8192;
const MAX_ENVIRONMENT_IMPORT_LENGTH = 12 * 1024;

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

function importLineValue(fragment, lineNumber) {
  const trimmed = fragment.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith("'")) {
    const match = trimmed.match(/^'([^']*)'(?:[ \t]+#.*)?$/);
    if (!match) throw new ApplicationValidationError('invalid_environment_import', `Environment import line ${lineNumber} has an invalid single-quoted value`);
    return normalizeEnvironmentValue(match[1]);
  }
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"((?:[^"\\]|\\["\\])*)"(?:[ \t]+#.*)?$/);
    if (!match) throw new ApplicationValidationError('invalid_environment_import', `Environment import line ${lineNumber} has an invalid double-quoted value`);
    return normalizeEnvironmentValue(match[1].replace(/\\(["\\])/g, '$1'));
  }
  const comment = trimmed.search(/[ \t]+#/);
  return normalizeEnvironmentValue((comment < 0 ? trimmed : trimmed.slice(0, comment)).trimEnd());
}

export function parseApplicationEnvironmentImport(value) {
  if (typeof value !== 'string' || value.length > MAX_ENVIRONMENT_IMPORT_LENGTH || value.includes('\u0000')) {
    throw new ApplicationValidationError('invalid_environment_import', 'Environment import must be bounded UTF-8 text');
  }
  const normalized = {};
  const source = value.startsWith('\ufeff') ? value.slice(1) : value;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line.includes('\r')) throw new ApplicationValidationError('invalid_environment_import', `Environment import line ${lineNumber} has an invalid line ending`);
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/);
    if (!match) throw new ApplicationValidationError('invalid_environment_import', `Environment import line ${lineNumber} must use KEY=value syntax`);
    const key = normalizeEnvironmentKey(match[1]);
    if (Object.hasOwn(normalized, key)) throw new ApplicationValidationError('duplicate_environment_key', `Environment import contains duplicate key ${key}`);
    normalized[key] = importLineValue(match[2], lineNumber);
    if (Object.keys(normalized).length > MAX_ENVIRONMENT_VARIABLES) {
      throw new ApplicationValidationError('environment_limit_exceeded', `Application environment supports at most ${MAX_ENVIRONMENT_VARIABLES} variables`);
    }
  }
  return normalized;
}

export const applicationEnvironmentPolicy = Object.freeze({
  maxVariables: MAX_ENVIRONMENT_VARIABLES,
  maxValueLength: MAX_ENVIRONMENT_VALUE_LENGTH,
  maxImportLength: MAX_ENVIRONMENT_IMPORT_LENGTH,
  reservedKeys: Object.freeze([...RESERVED_KEYS]),
});
