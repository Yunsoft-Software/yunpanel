const COMMON_FIELDS = new Set(['clientMaxBodySizeMb', 'headers']);
const TARGET_FIELDS = Object.freeze({
  proxy: new Set([...COMMON_FIELDS, 'proxyTimeoutSeconds', 'websocket']),
  static: new Set([...COMMON_FIELDS, 'spaFallback', 'staticAssetCacheSeconds']),
});
const BLOCKED_HEADERS = new Set([
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'date',
  'location',
  'server',
  'set-cookie',
  'transfer-encoding',
  'upgrade',
]);

export class NginxSettingsValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NginxSettingsValidationError';
    this.code = code;
  }
}

function optionalInteger(value, field, minimum, maximum) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new NginxSettingsValidationError('invalid_nginx_setting', `${field} is outside the supported range`);
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new NginxSettingsValidationError('invalid_nginx_setting', `${field} must be boolean`);
  }
  return value;
}

function headers(value) {
  if (!Array.isArray(value) || value.length > 12) {
    throw new NginxSettingsValidationError('invalid_nginx_headers', 'Nginx headers must be an array with at most 12 entries');
  }
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    const fields = new Set(['name', 'value', 'always']);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== fields.size || Object.keys(entry).some((field) => !fields.has(field))
      || typeof entry.name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(entry.name)
      || typeof entry.value !== 'string' || entry.value.length < 1 || entry.value.length > 256
      || /[\u0000-\u001f\u007f\u0085\u2028\u2029"\\$]/.test(entry.value) || typeof entry.always !== 'boolean') {
      throw new NginxSettingsValidationError('invalid_nginx_header', 'Nginx response header fields are invalid');
    }
    const identity = entry.name.toLowerCase();
    if (BLOCKED_HEADERS.has(identity)) {
      throw new NginxSettingsValidationError('blocked_nginx_header', 'Nginx response header is managed by the panel or protocol');
    }
    if (seen.has(identity)) {
      throw new NginxSettingsValidationError('duplicate_nginx_header', 'Nginx response header names must be unique');
    }
    seen.add(identity);
    return Object.freeze({ name: entry.name, value: entry.value, always: entry.always });
  }));
}

function defaults(targetType) {
  if (targetType === 'proxy') {
    return {
      clientMaxBodySizeMb: null,
      proxyTimeoutSeconds: null,
      websocket: true,
      headers: Object.freeze([]),
    };
  }
  if (targetType === 'static') {
    return {
      clientMaxBodySizeMb: null,
      spaFallback: true,
      staticAssetCacheSeconds: 604_800,
      headers: Object.freeze([]),
    };
  }
  throw new NginxSettingsValidationError('invalid_nginx_target_type', 'Nginx settings require a static or proxy target');
}

export function normalizeNginxSettings(targetType, value = {}, base = null) {
  const allowed = TARGET_FIELDS[targetType];
  if (!allowed) throw new NginxSettingsValidationError('invalid_nginx_target_type', 'Nginx settings require a static or proxy target');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !allowed.has(field))) {
    throw new NginxSettingsValidationError('invalid_nginx_settings', 'Nginx settings contain unsupported fields');
  }
  const seed = base === null ? defaults(targetType) : normalizeNginxSettings(targetType, base);
  const merged = { ...seed, ...value };
  const common = {
    clientMaxBodySizeMb: optionalInteger(merged.clientMaxBodySizeMb, 'clientMaxBodySizeMb', 1, 1024),
  };
  if (targetType === 'proxy') {
    return Object.freeze({
      ...common,
      proxyTimeoutSeconds: optionalInteger(merged.proxyTimeoutSeconds, 'proxyTimeoutSeconds', 1, 600),
      websocket: boolean(merged.websocket, 'websocket'),
      headers: headers(merged.headers),
    });
  }
  return Object.freeze({
    ...common,
    spaFallback: boolean(merged.spaFallback, 'spaFallback'),
    staticAssetCacheSeconds: optionalInteger(merged.staticAssetCacheSeconds, 'staticAssetCacheSeconds', 0, 31_536_000),
    headers: headers(merged.headers),
  });
}

export const nginxSettingsPolicy = Object.freeze({
  maxHeaders: 12,
  maxHeaderValueLength: 256,
  blockedHeaders: Object.freeze([...BLOCKED_HEADERS]),
});
