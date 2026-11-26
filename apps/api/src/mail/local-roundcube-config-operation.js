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

function exactPublicArtifacts(bundle) {
  if (!Array.isArray(bundle.publicArtifacts) || bundle.publicArtifacts.length !== 2
    || !bundle.preview?.fpm?.artifact?.path || !bundle.preview?.nginx?.artifact?.path) {
    throw new LocalRoundcubeConfigOperationError(
      'roundcube_configuration_bundle_invalid',
      'Roundcube protected desired state does not contain exact public artifacts',
    );
  }
  const byPath = new Map(bundle.publicArtifacts.map((artifact) => [artifact?.path, artifact]));
  if (byPath.size !== 2) {
    throw new LocalRoundcubeConfigOperationError('roundcube_configuration_bundle_invalid', 'Roundcube public artifacts are not unique');
  }
  const fpm = byPath.get(bundle.preview.fpm.artifact.path);
  const nginx = byPath.get(bundle.preview.nginx.artifact.path);
  if (!fpm || !nginx || typeof fpm.content !== 'string' || typeof nginx.content !== 'string') {
    throw new LocalRoundcubeConfigOperationError('roundcube_configuration_bundle_invalid', 'Roundcube public artifact bundle is invalid');
  }
  return Object.freeze({ fpm, nginx });
}

export function createLocalRoundcubeConfigOperation({
  configManager = createRoundcubeConfigManager(),
  backupManager = createRoundcubeConfigBackupManager(),
  activator = null,
  loadConfiguration,
} = {}) {
  if (!configManager || typeof configManager.stageConfiguration !== 'function'
    || typeof configManager.stageFpmPool !== 'function'
    || typeof configManager.stageNginxConfig !== 'function'
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
      || !bundle.preview || !Array.isArray(bundle.sensitiveArtifacts)
      || bundle.sensitiveArtifacts.length !== 1
      || bundle.preview.sha256 !== input.previewSha256
      || bundle.preview.configSha256 !== input.configSha256
      || bundle.preview.fpmSha256 !== input.fpmSha256
      || typeof bundle.preview.nginxSha256 !== 'string' || !SHA256_PATTERN.test(bundle.preview.nginxSha256)) {
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_configuration_bundle_invalid',
        'Roundcube protected desired state does not match the queued operation',
      );
    }
    const privateConfig = bundle.sensitiveArtifacts[0];
    if (privateConfig.path !== bundle.preview.configuration?.artifact?.path || typeof privateConfig.content !== 'string') {
      throw new LocalRoundcubeConfigOperationError(
        'roundcube_configuration_bundle_invalid',
        'Roundcube protected artifact bundle is invalid',
      );
    }
    const publicArtifacts = exactPublicArtifacts(bundle);

    await configManager.stageConfiguration(bundle.preview.configuration, privateConfig.content);
    await configManager.stageFpmPool(bundle.preview.fpm, publicArtifacts.fpm.content);
    await configManager.stageNginxConfig(bundle.preview.nginx, publicArtifacts.nginx.content);
    const activation = await resolvedActivator.activateConfiguration(bundle.preview, { transactionId: context.jobId });
    if (!activation || activation.applied !== true || activation.sideEffects !== true
      || activation.previewSha256 !== input.previewSha256
      || activation.configSha256 !== input.configSha256
      || activation.fpmSha256 !== input.fpmSha256
      || activation.nginxSha256 !== bundle.preview.nginxSha256
      || activation.httpHealthy !== true
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
      nginxSha256: activation.nginxSha256,
      databaseCreated: activation.databaseCreated,
      httpHealthy: true,
      applied: true,
      sideEffects: true,
    });
  }

  return Object.freeze({ execute });
}

export const localRoundcubeConfigOperationInternals = Object.freeze({
  assertExecution,
  assertPayload,
  exactPublicArtifacts,
});