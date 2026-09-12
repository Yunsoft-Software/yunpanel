import {
  createRoundcubeConfigActivator,
  createRoundcubeConfigBackupManager,
  createRoundcubeConfigManager,
} from '@yunpanel/host-runtime';

const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class LocalRoundcubeConfigOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalRoundcubeConfigOperationError';
    this.code = code;
  }
}

function assertExecution(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || typeof execution.jobId !== 'string' || !JOB_ID_PATTERN.test(execution.jobId)
    || execution.resourceType !== 'server' || typeof execution.resourceId !== 'string' || !execution.resourceId) {
    throw new LocalRoundcubeConfigOperationError(
      'roundcube_execution_context_invalid',
      'Roundcube execution context does not match a server resource',
    );
  }
  return execution;
}

function assertPayload(payload) {
  const fields = new Set(['previewSha256', 'configSha256', 'fpmSha256']);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== fields.size || Object.keys(payload).some((field) => !fields.has(field))
    || typeof payload.previewSha256 !== 'string' || !SHA256_PATTERN.test(payload.previewSha256)
    || typeof payload.configSha256 !== 'string' || !SHA256_PATTERN.test(payload.configSha256)
    || typeof payload.fpmSha256 !== 'string' || !SHA256_PATTERN.test(payload.fpmSha256)) {
    throw new LocalRoundcubeConfigOperationError('roundcube_operation_payload_invalid', 'Roundcube operation payload is invalid');
  }
  return payload;
}

export function createLocalRoundcubeConfigOperation({
  configManager = createRoundcubeConfigManager(),
  backupManager = createRoundcubeConfigBackupManager(),
  activator = null,
  loadConfiguration,
} = {}) {
  if (!configManager || typeof configManager.stageConfiguration !== 'function'
    || typeof configManager.stageFpmPool !== 'function'
    || !backupManager || typeof backupManager.backupConfiguration !== 'function'
    || typeof loadConfiguration !== 'function') {
    throw new LocalRoundcubeConfigOperationError(
      'roundcube_operation_dependencies_invalid',
      'Roundcube host operation dependencies are invalid',
    );
  }
  const resolvedActivator = activator ?? createRoundcubeConfigActivator({ configManager, backupManager });
  if (!resolvedActivator || typeof resolvedActivator.activateConfiguration !== 'function') {
    throw new LocalRoundcubeConfigOperationError('roundcube_operation_dependencies_invalid', 'Roundcube activator is unavailable');
  }

  async function execute(payload, execution) {
    const input = assertPayload(payload);
    const context = assertExecution(execution);
    let bundle;
    try { bundle = await loadConfiguration(input, context); }
    catch (error) {
      if (error instanceof LocalRoundcubeConfigOperationError) throw error;
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_configuration_materialization_failed',
        'Roundcube protected desired state could not be materialized',
      );
    }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || !bundle.preview || !Array.isArray(bundle.sensitiveArtifacts) || !Array.isArray(bundle.publicArtifacts)
      || bundle.sensitiveArtifacts.length !== 1 || bundle.publicArtifacts.length !== 1
      || bundle.preview.sha256 !== input.previewSha256
      || bundle.preview.configSha256 !== input.configSha256
      || bundle.preview.fpmSha256 !== input.fpmSha256) {
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_configuration_bundle_invalid',
        'Roundcube protected desired state does not match the queued operation',
      );
    }
    const privateConfig = bundle.sensitiveArtifacts[0];
    const publicFpm = bundle.publicArtifacts[0];
    if (privateConfig.path !== bundle.preview.configuration?.artifact?.path
      || publicFpm.path !== bundle.preview.fpm?.artifact?.path
      || typeof privateConfig.content !== 'string' || typeof publicFpm.content !== 'string') {
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_configuration_bundle_invalid',
        'Roundcube protected artifact bundle is invalid',
      );
    }

    await configManager.stageConfiguration(bundle.preview.configuration, privateConfig.content);
    await configManager.stageFpmPool(bundle.preview.fpm, publicFpm.content);
    const activation = await resolvedActivator.activateConfiguration(bundle.preview, { transactionId: context.jobId });
    if (!activation || activation.applied !== true || activation.sideEffects !== true
      || activation.previewSha256 !== input.previewSha256
      || activation.configSha256 !== input.configSha256
      || activation.fpmSha256 !== input.fpmSha256
      || typeof activation.databaseCreated !== 'boolean') {
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_activation_unconfirmed',
        'Roundcube activation did not confirm the queued configuration',
      );
    }
    return Object.freeze({
      version: 1,
      previewSha256: input.previewSha256,
      configSha256: input.configSha256,
      fpmSha256: input.fpmSha256,
      databaseCreated: activation.databaseCreated,
      applied: true,
      sideEffects: true,
    });
  }

  return Object.freeze({ execute });
}

export const localRoundcubeConfigOperationInternals = Object.freeze({
  assertExecution,
  assertPayload,
});
