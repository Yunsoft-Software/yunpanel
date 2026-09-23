const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SSL_SCOPE_DEFAULTS = Object.freeze({
  includeWww: true, includeWebmail: true, includeMail: true,
  assignToMail: false, includeWildcard: false,
});
const FIELDS = Object.freeze(['email', ...Object.keys(SSL_SCOPE_DEFAULTS)]);

// Only this authenticated user's data can provide a default. An email-shaped
// login name is an account address, not a generated admin@domain fallback.
export function sslContactEmail(session) {
  for (const value of [session?.user?.email, session?.user?.username]) {
    if (typeof value === 'string' && validSslContactEmail(value)) return value.trim();
  }
  return '';
}
export function validSslContactEmail(value) {
  return typeof value === 'string' && value.trim().length <= 254 && EMAIL.test(value.trim());
}

// Local React identity only; do not include CSRF tokens or persist form data.
export function sslDraftKey(domain, session, generation) {
  return JSON.stringify([domain?.id ?? null, domain?.serverId ?? null,
    session?.user?.id ?? null, session?.user?.role ?? null, generation]);
}
export function createSslRequestDraft(email = '') {
  const values = { email: validSslContactEmail(email) ? email.trim() : '', ...SSL_SCOPE_DEFAULTS };
  return { values, baseline: { ...values }, emailTouched: false };
}
export function sslDraftDirty(state) {
  return FIELDS.some((key) => key === 'email'
    ? state.values.email.trim() !== state.baseline.email.trim()
    : state.values[key] !== state.baseline[key]);
}
export function sslDraftSnapshot(state) {
  return Object.freeze(Object.fromEntries(FIELDS.map((key) => [key,
    key === 'email' ? state.values.email.trim() : state.values[key]])));
}

export function sslRequestDraftReducer(state, action) {
  if (action?.type === 'email-default') {
    // Never overwrite a manually entered or intentionally cleared address,
    // including when the user restored the old value before a late response.
    if (state.emailTouched) return state;
    const email = validSslContactEmail(action.email) ? action.email.trim() : '';
    if (state.values.email === email && state.baseline.email === email) return state;
    return { ...state, values: { ...state.values, email }, baseline: { ...state.baseline, email } };
  }
  if (action?.type === 'edit') {
    const { field, value } = action;
    if (!FIELDS.includes(field) || (field === 'email' ? typeof value !== 'string' : typeof value !== 'boolean')) return state;
    return { ...state, values: { ...state.values, [field]: value },
      emailTouched: state.emailTouched || field === 'email' };
  }
  if (action?.type === 'reset') {
    return { ...state, values: { ...state.baseline } };
  }
  if (action?.type === 'submitted') {
    // Only the caller's successful real request acknowledges a snapshot. A
    // later edit is still dirty; test/queued/failed requests must not call this.
    const values = action.values;
    if (!values || !validSslContactEmail(values.email)
      || Object.keys(SSL_SCOPE_DEFAULTS).some((key) => typeof values[key] !== 'boolean')) return state;
    return { ...state, baseline: Object.fromEntries(FIELDS.map((key) => [key,
      key === 'email' ? values.email.trim() : values[key]])), emailTouched: true };
  }
  return state;
}
