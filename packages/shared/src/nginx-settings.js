const COMMON_FIELDS = new Set(['clientMaxBodySizeMb', 'headers', 'preferredDomain', 'redirectRules', 'gzip', 'protectedPaths']);
const FILE_FIELDS = ['indexFiles', 'errorPages', 'documentRoot'];
const ERROR_CODES = new Set(['403', '404', '500', '502', '503', '504']);
const TARGET_FIELDS = Object.freeze({
  proxy: new Set([...COMMON_FIELDS, 'proxyTimeoutSeconds', 'websocket']),
  python: new Set([...COMMON_FIELDS, 'proxyTimeoutSeconds', 'websocket']),
  static: new Set([...COMMON_FIELDS, ...FILE_FIELDS, 'spaFallback', 'staticAssetCacheSeconds']),
  passenger: new Set([...COMMON_FIELDS]),
  php: new Set([...COMMON_FIELDS, ...FILE_FIELDS, 'staticAssetCacheSeconds']),
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

function documentRoot(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 192
    || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) {
    throw new NginxSettingsValidationError('invalid_nginx_document_root', 'Document root must be a relative directory inside this Website');
  }
  return value;
}
function preferredDomain(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 253 || value.split('.').length < 2
    || value.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new NginxSettingsValidationError('invalid_nginx_preferred_domain', 'Preferred Domain must be an existing canonical hostname');
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

// Redirect paths and targets are written into nginx verbatim, so only a closed
// character set is accepted: no whitespace, quotes, `;`, braces, `$` or backslash.
const REDIRECT_PATH = /^\/(?:[A-Za-z0-9._~%-]+\/)*[A-Za-z0-9._~%-]*$/;
const REDIRECT_QUERY = /^[A-Za-z0-9._~%&=+-]*$/;
const RESERVED_REDIRECT_SOURCES = ['/.well-known', '/autodiscover/', '/mail/config-v1.1.xml'];
const REDIRECT_FIELDS = ['source', 'target', 'status', 'match'];

function redirectPath(value) {
  return typeof value === 'string' && value.length <= 192 && REDIRECT_PATH.test(value)
    && !value.includes('//') && !value.split('/').includes('..') && !value.split('/').includes('.');
}

function redirectTarget(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return null;
  const [location, query = '', ...extra] = value.split('?');
  if (extra.length || !REDIRECT_QUERY.test(query)) return null;
  if (location.startsWith('/')) return redirectPath(location) ? { local: true, path: location, query } : null;
  const match = /^https?:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(\/.*)?$/i.exec(location);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return null;
  const labels = match[1].toLowerCase().split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  const path = match[3] ?? '/';
  return redirectPath(path) ? { local: false, path, query } : null;
}

function redirectRules(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 50) {
    throw new NginxSettingsValidationError('invalid_nginx_redirect_rules', 'Redirect rules must be a list with at most 50 entries');
  }
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    const target = entry && typeof entry === 'object' && !Array.isArray(entry) ? redirectTarget(entry.target) : null;
    const valid = target && Object.keys(entry).length === REDIRECT_FIELDS.length
      && Object.keys(entry).every(field => REDIRECT_FIELDS.includes(field))
      && redirectPath(entry.source) && [301, 302].includes(entry.status) && ['exact', 'prefix'].includes(entry.match)
      && !RESERVED_REDIRECT_SOURCES.some(reserved => entry.source === reserved || entry.source.startsWith(reserved.endsWith('/') ? reserved : `${reserved}/`))
      && !(target.local && target.path === entry.source && !target.query)
      // A prefix keeps the rest of the path, so both ends must be directories and the target cannot carry a query.
      && (entry.match === 'exact' || (entry.source !== '/' && entry.source.endsWith('/') && target.path.endsWith('/') && !target.query));
    if (!valid) {
      throw new NginxSettingsValidationError('invalid_nginx_redirect_rule', 'Redirect rule needs a safe local source, a local or http(s) target, status 301 or 302 and exact or prefix matching');
    }
    const identity = `${entry.match}:${entry.source}`;
    if (seen.has(identity)) {
      throw new NginxSettingsValidationError('duplicate_nginx_redirect_rule', 'Each source path can have only one redirect rule');
    }
    seen.add(identity);
    return Object.freeze({ source: entry.source, target: entry.target, status: entry.status, match: entry.match });
  }));
}

// Password-protected directories: { path: "/admin/", key }. The random key names
// the htpasswd file, so a Domain or path that is removed and created again (maybe
// by another tenant) never inherits old users from a leftover file.
const PROTECTED_PATH_KEY = /^[a-f0-9]{16}$/;
function protectedPaths(value) {
  if (value === null) return null;
  const validEntry = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === 2 && typeof entry.key === 'string' && PROTECTED_PATH_KEY.test(entry.key)
    && redirectPath(entry.path) && entry.path !== '/' && entry.path.endsWith('/')
    && !RESERVED_REDIRECT_SOURCES.some(reserved => entry.path.startsWith(reserved.endsWith('/') ? reserved : `${reserved}/`));
  if (!Array.isArray(value) || value.length > 20 || !value.every(validEntry)) {
    throw new NginxSettingsValidationError('invalid_nginx_protected_paths', 'Protected paths must be up to 20 site directories such as /admin/ with a key');
  }
  // Nested or repeated paths would make one rule silently win over another.
  if (value.some((entry, index) => value.some((other, at) => at !== index && (entry.path.startsWith(other.path) || entry.key === other.key)))) {
    throw new NginxSettingsValidationError('overlapping_nginx_protected_paths', 'Protected paths and their keys must be unique and must not contain each other');
  }
  return Object.freeze(value.map(entry => Object.freeze({ path: entry.path, key: entry.key })));
}

export function newProtectedPathKey() {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// FNV-1a 64-bit: stable, file-name safe and available in the browser bundle too.
export function stableHexKey(path) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
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
    ...(Object.hasOwn(merged, 'documentRoot') ? { documentRoot: documentRoot(merged.documentRoot) } : {}),
    ...(Object.hasOwn(merged, 'indexFiles') ? { indexFiles: indexFiles(targetType, merged.indexFiles) } : {}),
    ...(Object.hasOwn(merged, 'errorPages') ? { errorPages: errorPages(merged.errorPages) } : {}),
  };
  const entryFiles = fileSettings.indexFiles ?? (targetType === 'php' ? ['index.php', 'index.html'] : ['index.html']);
  if (Object.values(fileSettings.errorPages ?? {}).some(uri => entryFiles.some(file => uri === '/' + file))) {
    throw new NginxSettingsValidationError('nginx_error_page_index_conflict', 'An internal error page cannot also be a public index file');
  }
  const rules = Object.hasOwn(merged, 'redirectRules') ? redirectRules(merged.redirectRules) : undefined;
  // An exact rule on an internal error page would render a duplicate nginx location.
  if (rules?.some(rule => rule.match === 'exact' && Object.values(fileSettings.errorPages ?? {}).includes(rule.source))) {
    throw new NginxSettingsValidationError('nginx_redirect_error_page_conflict', 'A redirect source cannot also be an internal error page');
  }
  const common = {
    clientMaxBodySizeMb: optionalInteger(merged.clientMaxBodySizeMb, 'clientMaxBodySizeMb', 1, 1024),
    ...(Object.hasOwn(merged, 'preferredDomain') ? { preferredDomain: preferredDomain(merged.preferredDomain) } : {}),
    // Optional file settings leave old stored envelopes byte-for-byte canonical.
    ...fileSettings,
    ...(rules !== undefined ? { redirectRules: rules } : {}),
    ...(Object.hasOwn(merged, 'gzip') ? { gzip: boolean(merged.gzip, 'gzip') } : {}),
    ...(Object.hasOwn(merged, 'protectedPaths') ? { protectedPaths: protectedPaths(merged.protectedPaths) } : {}),
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
    // PHP serves files from disk, so it may opt in to the static browser cache; absent keeps legacy bytes.
    ...(targetType === 'php' && Object.hasOwn(merged, 'staticAssetCacheSeconds')
      ? { staticAssetCacheSeconds: optionalInteger(merged.staticAssetCacheSeconds, 'staticAssetCacheSeconds', 0, 31_536_000) } : {}),
    headers: headers(merged.headers),
  });
}

export const nginxSettingsPolicy = Object.freeze({
  maxHeaders: 12,
  maxHeaderValueLength: 256,
  blockedHeaders: Object.freeze([...BLOCKED_HEADERS]),
});
