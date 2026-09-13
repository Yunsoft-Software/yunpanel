import { createDatabaseCredentialManager } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class LocalDatabaseCredentialOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalDatabaseCredentialOperationError';
    this.code = code;
  }
}

function assertExecution(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !EXECUTION_ID_PATTERN.test(execution.jobId)
    || typeof execution.serverId !== 'string' || !UUID_PATTERN.test(execution.serverId)
    || execution.resourceType !== 'database' || typeof execution.resourceId !== 'string' || !execution.resourceId) {
    throw new LocalDatabaseCredentialOperationError(
      'database_credential_execution_context_invalid',
      'Database credential execution context is invalid',
    );
  }
  return execution;
}

export function createLocalDatabaseCredentialOperation({
  materializer,
  manager = createDatabaseCredentialManager(),
  receiptStore = null,
} = {}) {
  if (!materializer || typeof materializer.materialize !== 'function'
    || !manager || typeof manager.applyCredential !== 'function' || typeof manager.deleteCredential !== 'function'
    || (receiptStore !== null && typeof receiptStore.write !== 'function')) {
    throw new LocalDatabaseCredentialOperationError(
      'database_credential_operation_dependencies_invalid',
      'Database credential local operation dependencies are invalid',
    );
  }

  async function execute(operation, payload, execution) {
    const context = assertExecution(execution);
    if (![OPERATIONS.DATABASE_CREDENTIAL_APPLY, OPERATIONS.DATABASE_CREDENTIAL_DELETE].includes(operation)) {
      throw new LocalDatabaseCredentialOperationError('database_credential_operation_invalid', 'Database credential operation is invalid');
    }
    const bundle = await materializer.materialize(payload, operation);
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || bundle.databaseCredentialId !== payload.databaseCredentialId
      || bundle.databaseBindingId !== payload.databaseBindingId
      || bundle.credentialRevision !== payload.expectedCredentialRevision
      || bundle.bindingRevision !== payload.expectedBindingRevision
      || bundle.desiredStateSha256 !== payload.desiredStateSha256
      || bundle.databaseName !== context.resourceId) {
      throw new LocalDatabaseCredentialOperationError(
        'database_credential_bundle_mismatch',
        'Database credential private bundle does not match the queued job',
      );
    }
    const result = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
      ? await manager.applyCredential(bundle)
      : await manager.deleteCredential(bundle);
    const terminalField = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted';
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.databaseCredentialId !== payload.databaseCredentialId
      || result.databaseBindingId !== payload.databaseBindingId
      || result.credentialRevision !== payload.expectedCredentialRevision
      || result.bindingRevision !== payload.expectedBindingRevision
      || result.databaseName !== context.resourceId
      || result.desiredStateSha256 !== payload.desiredStateSha256
      || result[terminalField] !== true || result.sideEffects !== true) {
      throw new LocalDatabaseCredentialOperationError(
        'database_credential_activation_unconfirmed',
        'Database credential host mutation did not confirm the queued desired state',
      );
    }
    if (receiptStore) {
      try {
        await receiptStore.write({
          serverId: context.serverId,
          jobId: context.jobId,
          operation,
          result,
        });
      } catch {
        // The host mutation is already complete. A supplementary recovery receipt
        // must never recast successful host work as failed; durable completion is
        // still attempted by the local executor.
      }
    }
    return Object.freeze({ ...result });
  }

  return Object.freeze({ execute });
}

export const localDatabaseCredentialOperationInternals = Object.freeze({ assertExecution });
