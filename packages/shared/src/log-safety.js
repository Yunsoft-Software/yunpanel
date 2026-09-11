const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi;
const SENSITIVE_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie)[A-Za-z0-9_.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SENSITIVE_QUERY = /([?&](?:password|passwd|pwd|secret|token|api[-_]?key|key|authorization)=)[^&#\s]*/gi;
const AUTHORIZATION = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g;
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const logSafetyPolicy = Object.freeze({
  maxInputLength: 64 * 1024,
  maxMessageLength: 4 * 1024,
});

export function sanitizeLogMessage(value) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const bounded = raw.slice(0, logSafetyPolicy.maxInputLength);
  const redacted = bounded
    .replace(ANSI_ESCAPE, '')
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(AUTHORIZATION, '$1 [REDACTED]')
    .replace(GITHUB_TOKEN, '[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]@')
    .replace(JWT, '[REDACTED JWT]')
    .replace(CONTROL_CHARACTER, '�');
  return {
    message: redacted.slice(0, logSafetyPolicy.maxMessageLength),
    truncated: raw.length > logSafetyPolicy.maxInputLength || redacted.length > logSafetyPolicy.maxMessageLength,
  };
}
