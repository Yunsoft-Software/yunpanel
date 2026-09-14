import http from 'node:http';
import https from 'node:https';
import { assertUuid, normalizeNodeStatusSpec } from '@yunpanel/shared';
import { nginxManager } from './nginx-manager.js';
import { nodePassengerMigrationPreview } from './node-passenger-migration-preview.js';
import { nodeProcessManager } from './node-process-manager.js';
import { passengerEnvironmentManager } from './passenger-environment-manager.js';

const DOMAIN_FIELDS = new Set([
  'primaryDomain',
  'aliases',
  'tls',
  'canonicalRedirect',
  'httpsRedirect',
  'nginxSettings',
]);
const SAFE_NGINX_ACTIVATION_FAILURES = new Set([
  'staged_config_missing',
  'staged_config_changed',
  'nginx_rollback_receipt_conflict',
  'nginx_activation_prepare_failed',
  'nginx_config_invalid',
  'nginx_reload_failed',
]);
const PREPARE_ENVIRONMENT_REASONS = new Set([
  'passenger_environment_include_missing',
  'passenger_environment_include_drift',
]);

export class NodePassengerMigrationManagerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'NodePassengerMigrationManagerError';
    this.code = code;
    this.details = details;
  }
}

function normalizeOperationId(value) {
  try { return assertUuid(value, 'operationId'); }
  catch {
    throw new NodePassengerMigrationManagerError(
      'node_passenger_migration_operation_invalid',
      'Node Passenger migration operation identity is invalid',
    );
  }
}

function normalizeSpec(value) {
  try { return normalizeNodeStatusSpec(value); }
  catch {
    throw new NodePassengerMigrationManagerError(
      'node_passenger_migration_spec_invalid',
      'Node Passenger migration specification is invalid',
    );
  }
}

function normalizeDomainEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((field) => !DOMAIN_FIELDS.has(field))) {
    throw new NodePassengerMigrationManagerError(
      'node_passenger_migration_domain_invalid',
      'Node Passenger migration domain envelope is invalid',
    );
  }
  return Object.freeze({
    primaryDomain: value.primaryDomain,
    aliases: Array.isArray(value.aliases) ? Object.freeze([...value.aliases]) : [],
    tls: value.tls == null ? null : Object.freeze({ ...value.tls }),
    canonicalRedirect: value.canonicalRedirect === true,
    httpsRedirect: value.httpsRedirect !== false,
    nginxSettings: value.nginxSettings == null ? undefined : Object.freeze(structuredClone(value.nginxSettings)),
  });
}

function passengerNginxSettings(proxySettings) {
  if (proxySettings == null) return undefined;
  const result = {};
  if (Object.hasOwn(proxySettings, 'clientMaxBodySizeMb')) {
    result.clientMaxBodySizeMb = proxySettings.clientMaxBodySizeMb;
  }
  if (Object.hasOwn(proxySettings, 'headers')) result.headers = structuredClone(proxySettings.headers);
  return result;
}

function commonDomainSpec(domain) {
  return {
    primaryDomain: domain.primaryDomain,
    aliases: domain.aliases,
    tls: domain.tls,
    canonicalRedirect: domain.canonicalRedirect,
    httpsRedirect: domain.httpsRedirect,
  };
}

function sourceDomainSpec(domain, spec) {
  return Object.freeze({
    ...commonDomainSpec(domain),
    targetType: 'proxy',
    target: Object.freeze({
      upstreamHost: '127.0.0.1',
      upstreamPort: spec.runtime.port,
      websocket: domain.nginxSettings?.websocket !== false,
    }),
    nginxSettings: domain.nginxSettings,
  });
}

function targetDomainSpec(domain, preview) {
  const intent = preview?.target?.intent;
  const inspection = preview?.target?.inspection;
  if (!intent || !inspection?.satisfied || typeof inspection.nodeBinary !== 'string') return null;
  return Object.freeze({
    ...commonDomainSpec(domain),
    targetType: 'passenger',
    target: Object.freeze({
      appRoot: intent.appRoot,
      documentRoot: intent.documentRoot,
      startupFile: intent.startupFile,
      nodeBinary: inspection.nodeBinary,
      user: intent.unixUser,
      group: intent.unixUser,
      appEnv: intent.appEnv,
      environmentInclude: intent.environmentInclude,
    }),
    nginxSettings: passengerNginxSettings(domain.nginxSettings),
  });
}

function preflightCanPrepare(preview) {
  if (!preview?.source || preview.source.healthy !== true
    || preview.preservation?.release !== true
    || preview.environment?.present !== true
    || !preview.target?.intent
    || preview.target?.inspection?.satisfied !== true) return false;
  return preview.blockers.every((entry) => entry.code === 'passenger_environment_unready'
    && PREPARE_ENVIRONMENT_REASONS.has(entry.detail));
}

function requestNginxHealth({ hostname, healthPath, tls, timeoutMs = 2_000 }) {
  return new Promise((resolve) => {
    const secure = tls !== null;
    const transport = secure ? https : http;
    const request = transport.request({
      host: '127.0.0.1',
      port: secure ? 443 : 80,
      ...(secure ? { servername: hostname } : {}),
      path: healthPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        host: hostname,
        connection: 'close',
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function defaultWaitForTargetHealth({ hostname, healthPath, tls, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    if (await requestNginxHealth({ hostname, healthPath, tls })) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return false;
}

function processSpec(spec, action) {
  return Object.freeze({
    applicationId: spec.applicationId,
    releaseId: spec.releaseId,
    runtime: spec.runtime,
    action,
  });
}

function publicNginxState(sourceStage, targetStage) {
  return Object.freeze({
    sourceChecksum: sourceStage?.checksum ?? null,
    targetChecksum: targetStage?.checksum ?? null,
  });
}

export function createNodePassengerMigrationManager({
  previewer = nodePassengerMigrationPreview,
  passengerEnvironment = passengerEnvironmentManager,
  nginx = nginxManager,
  nodeProcess = nodeProcessManager,
  waitForTargetHealth = defaultWaitForTargetHealth,
} = {}) {
  if (!previewer || typeof previewer.preview !== 'function'
    || !passengerEnvironment || typeof passengerEnvironment.apply !== 'function'
    || typeof passengerEnvironment.compensate !== 'function'
    || !nginx || typeof nginx.stageDomain !== 'function'
    || typeof nginx.inspectActiveDomain !== 'function'
    || typeof nginx.activateDomain !== 'function'
    || typeof nginx.compensateDomain !== 'function'
    || !nodeProcess || typeof nodeProcess.inspectNodeProcess !== 'function'
    || typeof nodeProcess.controlNodeProcess !== 'function'
    || typeof waitForTargetHealth !== 'function') {
    throw new NodePassengerMigrationManagerError(
      'node_passenger_migration_dependencies_invalid',
      'Node Passenger migration dependencies are invalid',
    );
  }

  async function compensateEnvironmentIfOwned(spec, operationId, environmentResult) {
    if (environmentResult?.ownedByOperation !== true) return Object.freeze({ preservedUnownedEnvironment: true });
    try {
      return await passengerEnvironment.compensate(
        { applicationId: spec.applicationId },
        { operationId },
      );
    } catch (error) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_environment_rollback_failed',
        'Passenger environment rollback could not be confirmed',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }
  }

  async function rollbackTarget({ spec, domain, operationId, targetStage, environmentResult }) {
    let sourceAfterFailure;
    try { sourceAfterFailure = await previewer.preview(spec); }
    catch {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_source_unverified_after_cutover',
        'Passenger target is unhealthy and the legacy systemd source could not be reverified; automatic rollback was refused',
      );
    }
    if (sourceAfterFailure?.source?.healthy !== true || sourceAfterFailure?.preservation?.release !== true) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_source_unavailable_after_cutover',
        'Passenger target is unhealthy and the legacy systemd source is no longer healthy; automatic rollback was refused',
      );
    }

    try {
      await nginx.compensateDomain({
        primaryDomain: domain.primaryDomain,
        checksum: targetStage.checksum,
      });
    } catch (error) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_nginx_rollback_failed',
        'Passenger target health failed and the previous Nginx route could not be restored; environment state was preserved for safety',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }
    await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
  }

  async function cleanupLegacySystemd(spec) {
    let state;
    try { state = await nodeProcess.inspectNodeProcess(processSpec(spec, 'stop')); }
    catch (error) {
      return Object.freeze({
        complete: false,
        stopped: false,
        disabled: false,
        reason: 'systemd_inspection_failed',
        cause: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }

    let stopped = state.active !== true;
    if (!stopped) {
      try {
        state = await nodeProcess.controlNodeProcess(processSpec(spec, 'stop'));
        stopped = state.active !== true && state.activeState === 'inactive' && state.mainPid === 0;
      } catch (error) {
        return Object.freeze({
          complete: false,
          stopped: false,
          disabled: false,
          reason: 'systemd_stop_failed',
          cause: typeof error?.code === 'string' ? error.code : 'unknown',
        });
      }
    }

    let disabled = state.unitFileState === 'disabled' || state.enabled === false;
    if (!disabled) {
      try {
        state = await nodeProcess.controlNodeProcess(processSpec(spec, 'disable'));
        disabled = state.unitFileState === 'disabled' || state.enabled === false;
      } catch (error) {
        return Object.freeze({
          complete: false,
          stopped: true,
          disabled: false,
          reason: 'systemd_disable_failed',
          cause: typeof error?.code === 'string' ? error.code : 'unknown',
        });
      }
    }

    return Object.freeze({
      complete: stopped && disabled,
      stopped,
      disabled,
      serviceName: state.serviceName,
    });
  }

  async function verifyTargetHealth(spec, domain) {
    try {
      return await waitForTargetHealth({
        hostname: domain.primaryDomain,
        healthPath: spec.runtime.healthPath,
        tls: domain.tls,
        timeoutSeconds: spec.runtime.healthTimeoutSeconds,
      });
    } catch {
      return false;
    }
  }

  async function migratedResult({ spec, sourceStage, targetStage, resumed, cleanup }) {
    if (!cleanup.complete) {
      return Object.freeze({
        satisfied: false,
        state: 'passenger_active_cleanup_required',
        applicationId: spec.applicationId,
        releaseId: spec.releaseId,
        targetHealthy: true,
        resumed,
        cleanup,
        nginx: publicNginxState(sourceStage, targetStage),
      });
    }
    return Object.freeze({
      satisfied: true,
      state: 'migrated',
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      targetHealthy: true,
      resumed,
      cleanup,
      nginx: publicNginxState(sourceStage, targetStage),
    });
  }

  async function migrate({ operationId: rawOperationId, node: rawSpec, domain: rawDomain } = {}) {
    const operationId = normalizeOperationId(rawOperationId);
    const spec = normalizeSpec(rawSpec);
    const domain = normalizeDomainEnvelope(rawDomain);

    const initialPreview = await previewer.preview(spec);
    const sourceSpec = sourceDomainSpec(domain, spec);
    let sourceStage;
    try { sourceStage = await nginx.stageDomain(sourceSpec); }
    catch (error) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_source_route_invalid',
        'Legacy systemd Nginx route could not be rendered for migration verification',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }
    const sourceActive = await nginx.inspectActiveDomain({
      primaryDomain: domain.primaryDomain,
      checksum: sourceStage.checksum,
    });

    const initialTargetSpec = targetDomainSpec(domain, initialPreview);
    let initialTargetStage = null;
    let targetAlreadyActive = { satisfied: false, result: null };
    if (initialTargetSpec) {
      try {
        initialTargetStage = await nginx.stageDomain(initialTargetSpec);
        targetAlreadyActive = await nginx.inspectActiveDomain({
          primaryDomain: domain.primaryDomain,
          checksum: initialTargetStage.checksum,
        });
      } catch (error) {
        if (sourceActive.satisfied) {
          throw new NodePassengerMigrationManagerError(
            'node_passenger_migration_target_route_invalid',
            'Passenger Nginx target could not be rendered for migration',
            { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
          );
        }
      }
    }

    if (targetAlreadyActive.satisfied) {
      if (initialPreview.preservation?.environment !== true) {
        throw new NodePassengerMigrationManagerError(
          'node_passenger_migration_active_target_environment_unverified',
          'Passenger route is already active but its environment binding is not verified; automatic cleanup was refused',
        );
      }
      const environmentResult = await passengerEnvironment.apply({
        applicationId: spec.applicationId,
        runtime: spec.runtime,
        expectedSourceSha256: initialPreview.environment.sha256,
      }, { operationId });
      const healthy = await verifyTargetHealth(spec, domain);
      if (!healthy) {
        if (initialPreview.source?.healthy === true && initialPreview.preservation?.release === true) {
          await rollbackTarget({
            spec,
            domain,
            operationId,
            targetStage: initialTargetStage,
            environmentResult,
          });
          throw new NodePassengerMigrationManagerError(
            'node_passenger_migration_target_health_failed',
            'Passenger target failed health checks and the legacy Nginx route was restored',
          );
        }
        throw new NodePassengerMigrationManagerError(
          'node_passenger_migration_target_unhealthy_source_unavailable',
          'Passenger route is active but unhealthy and the legacy source is not healthy enough for automatic rollback',
        );
      }
      const cleanup = await cleanupLegacySystemd(spec);
      return migratedResult({
        spec,
        sourceStage,
        targetStage: initialTargetStage,
        resumed: true,
        cleanup,
      });
    }

    if (!sourceActive.satisfied) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_source_route_drift',
        'Neither the verified legacy systemd route nor the Passenger target is active; migration was refused',
      );
    }
    if (!preflightCanPrepare(initialPreview)) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_preflight_blocked',
        'Node Passenger migration preflight is blocked',
        { blockers: initialPreview.blockers },
      );
    }

    let environmentResult;
    try {
      environmentResult = await passengerEnvironment.apply({
        applicationId: spec.applicationId,
        runtime: spec.runtime,
        expectedSourceSha256: initialPreview.environment.sha256,
      }, { operationId });
    } catch (error) {
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_environment_apply_failed',
        'Passenger environment binding could not be prepared',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }

    let boundPreview;
    try { boundPreview = await previewer.preview(spec); }
    catch (error) {
      await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_postcondition_failed',
        'Passenger migration readiness could not be reverified after environment binding',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }
    if (!boundPreview.ready) {
      await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_postcondition_failed',
        'Passenger migration readiness is not satisfied after environment binding',
        { blockers: boundPreview.blockers },
      );
    }

    const targetSpec = targetDomainSpec(domain, boundPreview);
    if (!targetSpec) {
      await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_target_unavailable',
        'Passenger migration target could not be constructed from verified readiness evidence',
      );
    }

    let targetStage;
    try { targetStage = await nginx.stageDomain(targetSpec); }
    catch (error) {
      await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_target_route_invalid',
        'Passenger Nginx target could not be staged',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }

    const sourceBeforeActivation = await nginx.inspectActiveDomain({
      primaryDomain: domain.primaryDomain,
      checksum: sourceStage.checksum,
    });
    if (!sourceBeforeActivation.satisfied) {
      await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_source_route_changed',
        'Legacy Nginx route changed during migration preparation; cutover was refused',
      );
    }

    try {
      await nginx.activateDomain({
        primaryDomain: domain.primaryDomain,
        checksum: targetStage.checksum,
      });
    } catch (error) {
      if (SAFE_NGINX_ACTIVATION_FAILURES.has(error?.code)) {
        await compensateEnvironmentIfOwned(spec, operationId, environmentResult);
        throw new NodePassengerMigrationManagerError(
          'node_passenger_migration_nginx_activation_failed',
          'Passenger Nginx activation failed and the legacy route was preserved',
          { cause: error.code },
        );
      }
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_nginx_state_uncertain',
        'Passenger Nginx activation failed with uncertain rollback state; environment binding was preserved for safety',
        { cause: typeof error?.code === 'string' ? error.code : 'unknown' },
      );
    }

    const targetHealthy = await verifyTargetHealth(spec, domain);
    if (!targetHealthy) {
      await rollbackTarget({ spec, domain, operationId, targetStage, environmentResult });
      throw new NodePassengerMigrationManagerError(
        'node_passenger_migration_target_health_failed',
        'Passenger target failed health checks and the legacy Nginx route was restored',
      );
    }

    const cleanup = await cleanupLegacySystemd(spec);
    return migratedResult({
      spec,
      sourceStage,
      targetStage,
      resumed: false,
      cleanup,
    });
  }

  return Object.freeze({ migrate });
}

export const nodePassengerMigrationManager = createNodePassengerMigrationManager();
export const nodePassengerMigrationManagerInternals = Object.freeze({
  normalizeOperationId,
  normalizeSpec,
  normalizeDomainEnvelope,
  passengerNginxSettings,
  sourceDomainSpec,
  targetDomainSpec,
  preflightCanPrepare,
  requestNginxHealth,
  defaultWaitForTargetHealth,
  processSpec,
});
