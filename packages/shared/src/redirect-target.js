// Target of a forwarding-only Domain (targetType 'redirect'). The URL is written
// unquoted into an nginx `return`, so only URL characters that cannot end the
// directive, open a block or expand a variable are accepted.
const URL_CHARACTERS = /^[A-Za-z0-9\-._~:/?[\]@&+=%]+$/;
const FIELDS = new Set(['url', 'status', 'preservePath']);
const MAX_URL_LENGTH = 512;

export class RedirectTargetValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RedirectTargetValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RedirectTargetValidationError(code, message);
}

export function normalizeRedirectTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !FIELDS.has(key))) {
    fail('invalid_redirect_target', 'Redirect target must contain only url, status and preservePath');
  }
  const status = target.status ?? 301;
  if (status !== 301 && status !== 302) fail('invalid_redirect_status', 'Redirect status must be 301 or 302');
  const preservePath = target.preservePath ?? true;
  if (typeof preservePath !== 'boolean') fail('invalid_redirect_preserve_path', 'preservePath must be a boolean');
  const { url } = target;
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !URL_CHARACTERS.test(url)) {
    fail('invalid_redirect_url', 'Redirect URL contains unsupported characters');
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { fail('invalid_redirect_url', 'Redirect URL must be an absolute http or https address'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || !/^https?:\/\/[^/]/i.test(url)) {
    fail('invalid_redirect_url', 'Redirect URL must be an absolute http or https address without credentials');
  }
  // The request path and query are appended when kept, so the target cannot carry its own query.
  if (preservePath && parsed.search) fail('invalid_redirect_url', 'A redirect that keeps the path cannot have a query string');
  return Object.freeze({ url: preservePath ? url.replace(/\/+$/, '') : url, status, preservePath });
}
