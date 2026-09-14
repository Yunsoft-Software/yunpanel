import { createNodePassengerMigrationManager } from '@yunpanel/host-runtime/node-passenger-migration-manager';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertNodePassengerMigrationExecutionContext(payload, execution) {
  const applicationId = payload?.node?.applicationId;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !UUID_PATTERN.test(execution.jobId)
    || execution.resourceType !== 'application'
    || execution.resourceId !== applicationId) {
    const error = new Error('Node Passenger migration execution context does not match the queued application');
    error.code = 'node_passenger_migration_execution_context_invalid';
    throw error;
  }
  return execution;
}

export function createLocalNodePassengerMigrationOperation({
  migrationManager = createNodePassengerMigrationManager(),
} = {}) {
  if (!migrationManager || typeof migrationManager.migrate !== 'function') {
    throw new Error('migrationManager must provide migrate()');
  }

  return Object.freeze({
    async execute(payload, execution) {
      const context = assertNodePassengerMigrationExecutionContext(payload, execution);
      return migrationManager.migrate(Object.freeze({
        operationId: context.jobId.toLowerCase(),
        node: payload.node,
        domain: payload.domain,
      }));
    },
  });
}

export const localNodePassengerMigrationInternals = Object.freeze({ UUID_PATTERN });
