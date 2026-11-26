import { createNodePassengerMigrationManager } from '@yunpanel/host-runtime/node-passenger-migration-manager';
import { createNodePassengerMigrationPreview } from '@yunpanel/host-runtime/node-passenger-migration-preview';

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

function passengerTargetEvidence(preview) {
  const intent = preview?.target?.intent;
  const inspection = preview?.target?.inspection;
  const fields = [
    intent?.appRoot,
    intent?.documentRoot,
    intent?.startupFile,
    inspection?.nodeBinary,
    intent?.unixUser,
    intent?.appEnv,
    intent?.environmentInclude,
  ];
  if (!intent || inspection?.satisfied !== true
    || fields.some((value) => typeof value !== 'string' || value.length < 1)) {
    const error = new Error('Passenger target evidence is unavailable before migration');
    error.code = 'node_passenger_migration_target_evidence_unavailable';
    throw error;
  }
  return Object.freeze({
    appRoot: intent.appRoot,
    documentRoot: intent.documentRoot,
    startupFile: intent.startupFile,
    nodeBinary: inspection.nodeBinary,
    user: intent.unixUser,
    group: intent.unixUser,
    appEnv: intent.appEnv,
    environmentInclude: intent.environmentInclude,
  });
}

export function createLocalNodePassengerMigrationOperation({
  migrationPreview = createNodePassengerMigrationPreview(),
  migrationManager = null,
} = {}) {
  if (!migrationPreview || typeof migrationPreview.preview !== 'function') {
    throw new Error('migrationPreview must provide preview()');
  }
  const resolvedMigrationManager = migrationManager ?? createNodePassengerMigrationManager({ previewer: migrationPreview });
  if (!resolvedMigrationManager || typeof resolvedMigrationManager.migrate !== 'function') {
    throw new Error('migrationManager must provide migrate()');
  }

  return Object.freeze({
    async execute(payload, execution) {
      const context = assertNodePassengerMigrationExecutionContext(payload, execution);
      const target = passengerTargetEvidence(await migrationPreview.preview(payload.node));
      const result = await resolvedMigrationManager.migrate(Object.freeze({
        operationId: context.jobId.toLowerCase(),
        node: payload.node,
        domain: payload.domain,
      }));
      return Object.freeze({ ...result, passengerTarget: target });
    },
  });
}

export const localNodePassengerMigrationInternals = Object.freeze({
  UUID_PATTERN,
  passengerTargetEvidence,
});
