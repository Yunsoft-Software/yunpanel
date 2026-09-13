import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const USERNAME_PATTERN = /^ydb_[a-f0-9]{24}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DatabaseCredentialJobResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseCredentialJobResultError';
    this.code = code;
  }
}

function invalid(message) {
  throw new DatabaseCredentialJobResultError('invalid_job_result', message);
}

function expectedUsername(bindingId) {
  return `ydb_${createHash('sha256').update(bindingId).digest('hex').slice(0, 24)}`;
}

export function sanitizeDatabaseCredentialResult(job, result) {
  const terminalField = job.operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied'
    : job.operation === OPERATIONS.DATABASE_CREDENTIAL_DELETE ? 'deleted'
      : null;
  if (!terminalField || !job?.payload || !result || typeof result !== 'object' || Array.isArray(result)) {
    invalid('Database credential result is invalid');
  }
  const expectedKeys = [
    'version', 'databaseCredentialId', 'databaseBindingId', 'credentialRevision', 'bindingRevision',
    'databaseName', 'username', 'host', 'desiredStateSha256', terminalField, 'sideEffects',
  ];
  if (Object.keys(result).length !== expectedKeys.length
    || expectedKeys.some((field) => !Object.hasOwn(result, field))
    || result.version !== 1
    || result.databaseCredentialId !== job.payload.databaseCredentialId
    || result.databaseBindingId !== job.payload.databaseBindingId
    || result.credentialRevision !== job.payload.expectedCredentialRevision
    || result.bindingRevision !== job.payload.expectedBindingRevision
    || result.databaseName !== job.resourceId || !DATABASE_NAME_PATTERN.test(result.databaseName)
    || result.username !== expectedUsername(job.payload.databaseBindingId) || !USERNAME_PATTERN.test(result.username)
    || result.host !== 'localhost'
    || result.desiredStateSha256 !== job.payload.desiredStateSha256
    || !SHA256_PATTERN.test(result.desiredStateSha256)
    || result[terminalField] !== true || result.sideEffects !== true) {
    invalid('Database credential result does not match the queued desired state');
  }
  return Object.freeze({
    version: 1,
    databaseCredentialId: result.databaseCredentialId,
    databaseBindingId: result.databaseBindingId,
    credentialRevision: result.credentialRevision,
    bindingRevision: result.bindingRevision,
    databaseName: result.databaseName,
    username: result.username,
    host: 'localhost',
    desiredStateSha256: result.desiredStateSha256,
    [terminalField]: true,
    sideEffects: true,
  });
}

export const databaseCredentialJobResultInternals = Object.freeze({ expectedUsername });
