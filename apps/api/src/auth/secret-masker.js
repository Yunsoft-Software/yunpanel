const MASKED = '[REDACTED]';

const SENSITIVE_KEY_EXCLUSIONS = new Set([
  'id', 'keyid', 'tokenid', 'operationid', 'jobid', 'websiteid', 'customerId',
  'resellerid', 'serverid', 'applicationid', 'domainid', 'certificateid',
  'name', 'username', 'user', 'email', 'status', 'type', 'category', 'code',
  'level', 'severity', 'label', 'mode', 'version', 'domain', 'port', 'unit',
  'path', 'count', 'tags', 'createdat', 'updatedat', 'timestamp',
]);

const SENSITIVE_KEY_WORDS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'bearer',
  'privatekey', 'private_key', 'credential', 'credentials',
  'masterkey', 'master_key', 'apikey', 'api_key', 'accesskey',
  'access_key', 'authkey', 'auth_key', 'auth_header', 'authorization',
  'secretkey', 'secret_key', 'signingkey', 'signing_key',
];

export function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const clean = key.trim().toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE_KEY_EXCLUSIONS.has(clean)) return false;
  return SENSITIVE_KEY_WORDS.some((word) => clean.includes(word.replace(/[-_]/g, '')));
}

const URI_CREDENTIAL_REGEX = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:]+):([^@]+)@/g;
const BEARER_REGEX = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const PEM_PRIVATE_KEY_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const KV_SECRET_REGEX = /((?:["']\b)?(?:password|passwd|pwd|secret(?:_?key)?|token|auth_?token|api_?key|access_?key|master_?key|private_?key|signing_?key|credential(?:s)?)(?:\b["']?)?\s*(?:[:=]|\s+)\s*)(["']?)([^'"\s,;&]+)\2/gi;
const ENV_SECRET_REGEX = /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(["']?)([^'"\s,;&]+)\2/g;
const QUERY_SECRET_REGEX = /([?&](?:password|passwd|secret|token|key|api_?key)=)[^&#\s]+/gi;

export function maskSecretsInString(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(PEM_PRIVATE_KEY_REGEX, '[REDACTED]')
    .replace(URI_CREDENTIAL_REGEX, '$1$2:[REDACTED]@')
    .replace(BEARER_REGEX, '$1[REDACTED]')
    .replace(KV_SECRET_REGEX, '$1$2[REDACTED]$2')
    .replace(ENV_SECRET_REGEX, '$1$2[REDACTED]$2')
    .replace(QUERY_SECRET_REGEX, '$1[REDACTED]');
}

export function maskSecrets(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return maskSecretsInString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item, seen));
  }

  if (value instanceof Error) {
    const sanitizedError = {
      name: value.name,
      code: value.code,
      status: value.status,
      message: maskSecretsInString(value.message),
    };
    if (value.stack) {
      sanitizedError.stack = maskSecretsInString(value.stack);
    }
    for (const [key, val] of Object.entries(value)) {
      if (key === 'stack' || key === 'message') continue;
      if (isSensitiveKey(key)) {
        sanitizedError[key] = MASKED;
      } else {
        sanitizedError[key] = maskSecrets(val, seen);
      }
    }
    return sanitizedError;
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = MASKED;
    } else {
      result[key] = maskSecrets(val, seen);
    }
  }

  return result;
}
