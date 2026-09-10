import { OPERATIONS } from '@yunpanel/protocol';

const DATABASE_ENGINES = new Set(['mariadb', 'mysql']);
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const MAX_DATABASES = 10_000;

export class DatabaseJobResultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseJobResultError';
    this.code = 'invalid_job_result';
  }
}

function safeText(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function sanitizeDatabaseIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseJobResultError('Database result entry is invalid');
  }
  if (!safeText(value.name, 64) || RESERVED_DATABASES.has(value.name.toLowerCase())) {
    throw new DatabaseJobResultError('Database result name is invalid');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw new DatabaseJobResultError('Database result size is invalid');
  }
  return { name: value.name, sizeBytes: value.sizeBytes };
}

function sanitizeServerIdentity(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new DatabaseJobResultError('Database job result must be an object');
  }
  if (typeof result.engine !== 'string' || !DATABASE_ENGINES.has(result.engine)) {
    throw new DatabaseJobResultError('Database engine is invalid');
  }
  if (!safeText(result.version, 120)) {
    throw new DatabaseJobResultError('Database version is invalid');
  }
  return { engine: result.engine, version: result.version };
}

function sanitizeInventory(result) {
  const server = sanitizeServerIdentity(result);
  if (!Array.isArray(result.databases) || result.databases.length > MAX_DATABASES) {
    throw new DatabaseJobResultError('Database inventory is invalid');
  }
  const databases = result.databases.map(sanitizeDatabaseIdentity);
  const normalized = new Set();
  for (const database of databases) {
    const key = database.name.toLowerCase();
    if (normalized.has(key)) throw new DatabaseJobResultError('Database inventory contains duplicate names');
    normalized.add(key);
  }
  return { ...server, databases };
}

function sanitizeMutation(job, result, flag) {
  const server = sanitizeServerIdentity(result);
  const database = sanitizeDatabaseIdentity(result.database);
  if (database.name !== job.payload?.name) {
    throw new DatabaseJobResultError('Database result identity does not match the queued operation');
  }
  if (result[flag] !== true) {
    throw new DatabaseJobResultError(`Database ${flag} confirmation is missing`);
  }
  return { ...server, database, [flag]: true };
}

export function sanitizeDatabaseJobResult(job, result) {
  if (job?.operation === OPERATIONS.DATABASE_INSPECT) return sanitizeInventory(result);
  if (job?.operation === OPERATIONS.DATABASE_CREATE) return sanitizeMutation(job, result, 'created');
  if (job?.operation === OPERATIONS.DATABASE_DELETE) return sanitizeMutation(job, result, 'deleted');
  throw new DatabaseJobResultError('Database operation is not supported by the job sanitizer');
}

export const databaseJobResultInternals = Object.freeze({
  safeText,
  sanitizeDatabaseIdentity,
  sanitizeServerIdentity,
  sanitizeInventory,
  maxDatabases: MAX_DATABASES,
});
