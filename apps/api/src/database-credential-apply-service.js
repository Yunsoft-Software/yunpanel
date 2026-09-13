import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const DATABASE_OPERATIONS = new Set([
  OPERATIONS.DATABASE_INSPECT,
  OPERATIONS.DATABASE_CREATE,
  OPERATIONS.DATABASE_DELETE,
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);

export class DatabaseCredentialApplyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DatabaseCredentialApplyError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function positiveRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DatabaseCredentialApplyError('database_credential_revision_invalid', `${field} must be a positive integer`);
  }
  return value;
}

function expectedDigest(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DatabaseCredentialApplyError('database_credential_preview_digest_invalid', 'Database credential preview digest is invalid');
  }
  return value;
}

export function createDatabaseCredentialApplyService({
  databaseBindingRegistry,
  databaseCredentialRegistry,
  jobRegistry,
} = {}) {
  if (!databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.getCredential !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function' || typeof jobRegistry.enqueue !== 'function') {
    throw new DatabaseCredentialApplyError('database_credential_dependencies_invalid', 'Database credential apply dependencies are unavailable', 503);
  }

  async function stateFor(credentialId) {
    let credential;
    let binding;
    try { credential = await databaseCredentialRegistry.getCredential(credentialId); }
    catch { throw new DatabaseCredentialApplyError('database_credential_unavailable', 'Database credential could not be read', 503); }
    if (!credential) throw new DatabaseCredentialApplyError('database_credential_not_found', 'Database credential not found', 404);
    try { binding = await databaseBindingRegistry.getBinding(credential.databaseBindingId); }
    catch { throw new DatabaseCredentialApplyError('database_binding_unavailable', 'Database binding could not be verified', 503); }
    if (!binding) throw new DatabaseCredentialApplyError('database_binding_not_found', 'Database binding not found', 404);
    if (binding.serverId !== credential.serverId || binding.databaseName !== credential.databaseName
      || binding.websiteId !== credential.websiteId || binding.applicationId !== credential.applicationId
      || binding.unixUser !== credential.siteUnixUser) {
      throw new DatabaseCredentialApplyError('database_credential_binding_drift', 'Database credential no longer matches its binding', 409);
    }
    return Object.freeze({ credential, binding });
  }

  async function assertIdle(serverId) {
    const jobs = await jobRegistry.listJobs({ serverId });
    if (!Array.isArray(jobs)) throw new DatabaseCredentialApplyError('database_job_state_unavailable', 'Database job state is invalid', 503);
    if (jobs.some((job) => DATABASE_OPERATIONS.has(job.operation) && ACTIVE_JOB_STATUSES.has(job.status))) {
      throw new DatabaseCredentialApplyError('database_job_conflict', 'Another database operation is already queued or running', 409);
    }
  }

  async function preview(credentialId, operation) {
    const { credential, binding } = await stateFor(credentialId);
    await assertIdle(binding.serverId);
    const identity = Object.freeze({
      version: 1,
      operation,
      databaseCredentialId: credential.id,
      databaseBindingId: binding.id,
      serverId: binding.serverId,
      databaseName: binding.databaseName,
      username: credential.username,
      host: credential.host,
      privileges: Object.freeze([...credential.privileges]),
      expectedCredentialRevision: credential.revision,
      expectedBindingRevision: binding.revision,
      passwordUpdatedAt: credential.passwordUpdatedAt,
    });
    const desiredStateSha256 = digest(identity);
    const action = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'apply' : 'delete';
    return Object.freeze({
      ...identity,
      desiredStateSha256,
      confirmation: `${action}-database-credential:${credential.id}:${desiredStateSha256}`,
      sideEffects: false,
    });
  }

  async function queue(input, operation) {
    const credentialRevision = positiveRevision(input.expectedCredentialRevision, 'expectedCredentialRevision');
    const bindingRevision = positiveRevision(input.expectedBindingRevision, 'expectedBindingRevision');
    const sha256 = expectedDigest(input.expectedDesiredStateSha256);
    const current = await preview(input.credentialId, operation);
    if (current.expectedCredentialRevision !== credentialRevision
      || current.expectedBindingRevision !== bindingRevision || current.desiredStateSha256 !== sha256) {
      throw new DatabaseCredentialApplyError('database_credential_preview_stale', 'Database credential preview is stale', 409);
    }
    if (input.confirmation !== current.confirmation) {
      throw new DatabaseCredentialApplyError('database_credential_confirmation_mismatch', 'Database credential confirmation does not match', 409);
    }
    const job = await jobRegistry.enqueue({
      serverId: current.serverId,
      type: operation,
      operation,
      payload: {
        databaseCredentialId: current.databaseCredentialId,
        databaseBindingId: current.databaseBindingId,
        expectedCredentialRevision: current.expectedCredentialRevision,
        expectedBindingRevision: current.expectedBindingRevision,
        desiredStateSha256: current.desiredStateSha256,
      },
      resourceType: 'database',
      resourceId: current.databaseName,
      idempotencyKey: `${operation}:${current.databaseCredentialId}:${current.desiredStateSha256}`,
    });
    return Object.freeze({ desiredStateSha256: current.desiredStateSha256, job });
  }

  return Object.freeze({
    previewApply: (credentialId) => preview(credentialId, OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    queueApply: (input) => queue(input, OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    previewDelete: (credentialId) => preview(credentialId, OPERATIONS.DATABASE_CREDENTIAL_DELETE),
    queueDelete: (input) => queue(input, OPERATIONS.DATABASE_CREDENTIAL_DELETE),
  });
}

export const databaseCredentialApplyInternals = Object.freeze({ digest, positiveRevision, expectedDigest });
