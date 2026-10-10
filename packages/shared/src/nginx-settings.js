const COMMON_FIELDS = new Set(['clientMaxBodySizeMb', 'headers']);
const FILE_FIELDS = ['indexFiles', 'errorPages'];
const ERROR_CODES = new Set(['403', '404', '500', '502', '503', '504']);
const TARGET_FIELDS = Object.freeze({
  proxy: new Set([...COMMON_FIELDS, 'proxyTimeoutSeconds', 'websocket']),
  python: new Set([...COMMON_FIELDS, 'proxyTimeoutSeconds', 'websocket']),
  static: new Set([...COMMON_FIELDS, ...FILE_FIELDS, 'spaFallback', 'staticAssetCacheSeconds']),
  passenger: new Set([...COMMON_FIELDS]),
  php: new Set([...COMMON_FIELDS, ...FILE_FIELDS]),
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

function indexFiles(targetType, value) {
  if (value === null) return null;
  const extension = targetType === 'php' ? /\.(?:php|html|htm)$/i : /\.(?:html|htm)$/i;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || new Set(value).size !== value.length || value.some(file => typeof file !== 'string'
      || file.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)
      || file.includes('..') || !extension.test(file))) {
    throw new NginxSettingsValidationError('invalid_nginx_index_files', 'Index files must be up to eight distinct HTML files, or PHP files on a PHP site');
  }
  return Object.freeze([...value]);
}

function errorPages(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(code => !ERROR_CODES.has(code))
    || Object.values(value).some(uri => typeof uri !== 'string' || uri.length > 192
      || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html|htm)$/.test(uri)
      || uri.includes('..'))) {
    throw new NginxSettingsValidationError('invalid_nginx_error_pages', 'Error pages require a supported status and a local HTML path');
  }
  return Object.freeze({ ...value });
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
  if (targetType === 'proxy' || targetType === 'python') {
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
  if (targetType === 'passenger' || targetType === 'php') {
    return {
      clientMaxBodySizeMb: null,
      headers: Object.freeze([]),
    };
  }
  throw new NginxSettingsValidationError('invalid_nginx_target_type', 'Nginx settings require a static, proxy, passenger, php or python target');
}

export function normalizeNginxSettings(targetType, value = {}, base = null) {
  const allowed = TARGET_FIELDS[targetType];
  if (!allowed) throw new NginxSettingsValidationError('invalid_nginx_target_type', 'Nginx settings require a static, proxy, passenger, php or python target');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !allowed.has(field))) {
    throw new NginxSettingsValidationError('invalid_nginx_settings', 'Nginx settings contain unsupported fields');
  }
  const seed = base === null ? defaults(targetType) : normalizeNginxSettings(targetType, base);
  const merged = { ...seed, ...value };
  const fileSettings = {
    ...(Object.hasOwn(merged, 'indexFiles') ? { indexFiles: indexFiles(targetType, merged.indexFiles) } : {}),
    ...(Object.hasOwn(merged, 'errorPages') ? { errorPages: errorPages(merged.errorPages) } : {}),
  };
  const entryFiles = fileSettings.indexFiles ?? (targetType === 'php' ? ['index.php', 'index.html'] : ['index.html']);
  if (Object.values(fileSettings.errorPages ?? {}).some(uri => entryFiles.some(file => uri === '/' + file))) {
    throw new NginxSettingsValidationError('nginx_error_page_index_conflict', 'An internal error page cannot also be a public index file');
  }
  const common = {
    clientMaxBodySizeMb: optionalInteger(merged.clientMaxBodySizeMb, 'clientMaxBodySizeMb', 1, 1024),
    // Optional file settings leave old stored envelopes byte-for-byte canonical.
    ...fileSettings,
  };
  if (targetType === 'proxy' || targetType === 'python') {
    return Object.freeze({
      ...common,
      proxyTimeoutSeconds: optionalInteger(merged.proxyTimeoutSeconds, 'proxyTimeoutSeconds', 1, 600),
      websocket: boolean(merged.websocket, 'websocket'),
      headers: headers(merged.headers),
    });
  }
  if (targetType === 'static') {
    return Object.freeze({
      ...common,
      spaFallback: boolean(merged.spaFallback, 'spaFallback'),
      staticAssetCacheSeconds: optionalInteger(merged.staticAssetCacheSeconds, 'staticAssetCacheSeconds', 0, 31_536_000),
      headers: headers(merged.headers),
    });
  }
  return Object.freeze({
    ...common,
    headers: headers(merged.headers),
  });
}

export const nginxSettingsPolicy = Object.freeze({
  maxHeaders: 12,
  maxHeaderValueLength: 256,
  blockedHeaders: Object.freeze([...BLOCKED_HEADERS]),
});
