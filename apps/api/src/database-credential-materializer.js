import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class DatabaseCredentialMaterializerError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DatabaseCredentialMaterializerError';
    this.code = code;
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validatePayload(payload, operation) {
  const fields = [
    'databaseCredentialId', 'databaseBindingId', 'expectedCredentialRevision',
    'expectedBindingRevision', 'desiredStateSha256',
  ];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== fields.length || fields.some((field) => !Object.hasOwn(payload, field))
    || !Number.isSafeInteger(payload.expectedCredentialRevision) || payload.expectedCredentialRevision < 1
    || !Number.isSafeInteger(payload.expectedBindingRevision) || payload.expectedBindingRevision < 1
    || typeof payload.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(payload.desiredStateSha256)
    || ![OPERATIONS.DATABASE_CREDENTIAL_APPLY, OPERATIONS.DATABASE_CREDENTIAL_DELETE].includes(operation)) {
    throw new DatabaseCredentialMaterializerError('database_credential_materialization_input_invalid', 'Database credential materialization input is invalid');
  }
  return payload;
}

export function createDatabaseCredentialMaterializer({ databaseBindingRegistry, databaseCredentialRegistry } = {}) {
  if (!databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.getCredential !== 'function'
    || typeof databaseCredentialRegistry.materializeCredential !== 'function') {
    throw new DatabaseCredentialMaterializerError('database_credential_materialization_dependencies_invalid', 'Database credential materialization dependencies are unavailable', 503);
  }

  async function publicState(payload, operation) {
    validatePayload(payload, operation);
    let credential;
    let binding;
    try { credential = await databaseCredentialRegistry.getCredential(payload.databaseCredentialId); }
    catch { throw new DatabaseCredentialMaterializerError('database_credential_unavailable', 'Database credential could not be read', 503); }
    if (!credential) throw new DatabaseCredentialMaterializerError('database_credential_not_found', 'Database credential not found', 404);
    try { binding = await databaseBindingRegistry.getBinding(payload.databaseBindingId); }
    catch { throw new DatabaseCredentialMaterializerError('database_binding_unavailable', 'Database binding could not be read', 503); }
    if (!binding) throw new DatabaseCredentialMaterializerError('database_binding_not_found', 'Database binding not found', 404);
    if (credential.databaseBindingId !== binding.id || credential.serverId !== binding.serverId
      || credential.databaseName !== binding.databaseName || credential.websiteId !== binding.websiteId
      || credential.applicationId !== binding.applicationId || credential.siteUnixUser !== binding.unixUser
      || credential.revision !== payload.expectedCredentialRevision || binding.revision !== payload.expectedBindingRevision) {
      throw new DatabaseCredentialMaterializerError('database_credential_desired_state_stale', 'Database credential desired state changed after queueing');
    }
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
    if (digest(identity) !== payload.desiredStateSha256) {
      throw new DatabaseCredentialMaterializerError('database_credential_desired_state_stale', 'Database credential desired-state digest is stale');
    }
    return Object.freeze({ credential, binding, identity });
  }

  async function materialize(payload, operation) {
    const state = await publicState(payload, operation);
    const bundle = {
      version: 1,
      databaseCredentialId: state.credential.id,
      databaseBindingId: state.binding.id,
      credentialRevision: state.credential.revision,
      bindingRevision: state.binding.revision,
      desiredStateSha256: payload.desiredStateSha256,
      databaseName: state.binding.databaseName,
      username: state.credential.username,
      host: state.credential.host,
      privileges: Object.freeze([...state.credential.privileges]),
    };
    if (operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY) {
      let privateCredential;
      try {
        privateCredential = await databaseCredentialRegistry.materializeCredential(state.credential.id, {
          expectedRevision: state.credential.revision,
        });
      } catch {
        throw new DatabaseCredentialMaterializerError('database_credential_secret_unavailable', 'Database credential secret could not be materialized', 503);
      }
      if (!privateCredential || privateCredential.id !== state.credential.id
        || privateCredential.databaseBindingId !== state.binding.id
        || typeof privateCredential.password !== 'string') {
        throw new DatabaseCredentialMaterializerError('database_credential_secret_invalid', 'Database credential secret materialization is invalid', 503);
      }
      return Object.freeze({ ...bundle, password: privateCredential.password });
    }
    return Object.freeze(bundle);
  }

  return Object.freeze({ materialize });
}

export const databaseCredentialMaterializerInternals = Object.freeze({ digest, validatePayload });
