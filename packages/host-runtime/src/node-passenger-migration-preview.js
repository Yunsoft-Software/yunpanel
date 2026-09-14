import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeNodeStatusSpec } from '@yunpanel/shared';
import { createApplicationIdentity } from './application-identity.js';
import { nodeStatusInspector } from './node-status-inspector.js';
import {
  passengerEnvironmentManager,
  passengerEnvironmentManagerInternals,
} from './passenger-environment-manager.js';
import { createPassengerSiteManager } from './passenger-site-manager.js';

const ENV_ROOT = passengerEnvironmentManagerInternals.sourceRoot;
const PASSENGER_ENV_ROOT = passengerEnvironmentManagerInternals.includeRoot;
const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';

export class NodePassengerMigrationPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodePassengerMigrationPreviewError';
    this.code = code;
  }
}

function normalizeSpec(value) {
  try {
    return normalizeNodeStatusSpec(value);
  } catch {
    throw new NodePassengerMigrationPreviewError('node_passenger_migration_spec_invalid', 'Node Passenger migration preview specification is invalid');
  }
}

function targetIntent(spec) {
  const identity = createApplicationIdentity(spec.applicationId);
  if (spec.runtime.start.mode !== 'node') return null;
  const appRoot = spec.runtime.documentRoot === '.'
    ? identity.paths.runtime.currentRelease
    : path.posix.join(identity.paths.runtime.currentRelease, spec.runtime.documentRoot);
  return Object.freeze({
    adapter: 'passenger',
    applicationId: spec.applicationId,
    nodeMajor: spec.runtime.nodeMajor,
    nodeCandidates: Object.freeze([
      path.posix.join(MANAGED_NODE_ROOT, `v${spec.runtime.nodeMajor}`, 'bin', 'node'),
      '/usr/bin/node',
    ]),
    appRoot,
    documentRoot: appRoot,
    startupFile: spec.runtime.start.entryFile,
    startMode: 'node',
    appEnv: spec.runtime.mode,
    unixUser: identity.unixUser,
    healthPath: spec.runtime.healthPath,
    healthTimeoutSeconds: spec.runtime.healthTimeoutSeconds,
    environmentInclude: path.posix.join(PASSENGER_ENV_ROOT, `${spec.applicationId}.conf`),
  });
}

function blocker(code, detail = null) {
  return Object.freeze({ code, ...(detail ? { detail } : {}) });
}

export function createNodePassengerMigrationPreview({
  statusInspector = nodeStatusInspector,
  passengerSiteManager = createPassengerSiteManager(),
  passengerEnvironment = passengerEnvironmentManager,
  readFileFn = readFile,
  envRoot = ENV_ROOT,
} = {}) {
  if (!statusInspector || typeof statusInspector.inspectNodeStatus !== 'function'
    || !passengerSiteManager || typeof passengerSiteManager.inspect !== 'function'
    || !passengerEnvironment || typeof passengerEnvironment.inspect !== 'function'
    || typeof readFileFn !== 'function'
    || typeof envRoot !== 'string' || !path.posix.isAbsolute(envRoot)) {
    throw new NodePassengerMigrationPreviewError('node_passenger_migration_dependencies_invalid', 'Node Passenger migration preview dependencies are invalid');
  }

  async function inspectEnvironment(spec) {
    const environmentPath = path.posix.join(envRoot, `${spec.applicationId}.env`);
    let content;
    try {
      content = await readFileFn(environmentPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return Object.freeze({
          path: environmentPath,
          present: false,
          bytes: 0,
          sha256: null,
        });
      }
      throw new NodePassengerMigrationPreviewError('node_passenger_migration_environment_inspection_failed', 'Node environment evidence could not be inspected safely');
    }
    if (typeof content !== 'string') {
      throw new NodePassengerMigrationPreviewError('node_passenger_migration_environment_inspection_failed', 'Node environment evidence is invalid');
    }
    return Object.freeze({
      path: environmentPath,
      present: true,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }

  async function preview(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    const blockers = [];
    const intent = targetIntent(spec);

    let source;
    try {
      source = await statusInspector.inspectNodeStatus(spec);
    } catch (error) {
      blockers.push(blocker('systemd_source_inspection_failed', typeof error?.code === 'string' ? error.code : 'unknown'));
      source = null;
    }

    if (source && (source.releaseId !== spec.releaseId || source.healthy !== true)) {
      blockers.push(blocker('systemd_source_unhealthy', source.releaseId !== spec.releaseId ? 'release_drift' : 'health_check_failed'));
    }

    const environment = await inspectEnvironment(spec);
    let environmentBinding = Object.freeze({ satisfied: false, reason: 'systemd_environment_missing' });
    if (!environment.present) {
      blockers.push(blocker('systemd_environment_missing'));
    } else {
      try {
        environmentBinding = await passengerEnvironment.inspect(Object.freeze({
          applicationId: spec.applicationId,
          runtime: spec.runtime,
          expectedSourceSha256: environment.sha256,
        }));
      } catch (error) {
        environmentBinding = Object.freeze({
          satisfied: false,
          reason: typeof error?.code === 'string' ? error.code : 'passenger_environment_binding_inspection_failed',
        });
      }
      if (!environmentBinding?.satisfied) {
        blockers.push(blocker('passenger_environment_unready', environmentBinding?.reason ?? 'passenger_environment_binding_unavailable'));
      } else {
        if (environmentBinding.sourcePath !== environment.path) {
          blockers.push(blocker('passenger_environment_source_mismatch'));
        }
        if (!intent || environmentBinding.environmentInclude !== intent.environmentInclude) {
          blockers.push(blocker('passenger_environment_include_mismatch'));
        }
      }
    }

    let target = null;
    if (!intent) {
      blockers.push(blocker('passenger_start_mode_unsupported', spec.runtime.start.mode));
    } else {
      try {
        target = await passengerSiteManager.inspect(intent);
        if (!target?.satisfied) {
          blockers.push(blocker('passenger_target_unready', target?.reason ?? 'passenger_target_unverified'));
        }
      } catch (error) {
        blockers.push(blocker('passenger_target_inspection_failed', typeof error?.code === 'string' ? error.code : 'unknown'));
      }
    }

    const uniqueBlockers = [...new Map(blockers.map((entry) => [`${entry.code}:${entry.detail ?? ''}`, entry])).values()];
    const ready = uniqueBlockers.length === 0;
    return Object.freeze({
      applicationId: spec.applicationId,
      releaseId: spec.releaseId,
      mode: 'read-only',
      mutationPerformed: false,
      source: source ? Object.freeze({
        adapter: 'systemd',
        serviceName: source.serviceName,
        releaseId: source.releaseId,
        activeState: source.activeState,
        subState: source.subState,
        healthy: source.healthy === true,
        healthPath: source.healthPath,
        port: source.port,
      }) : null,
      environment,
      target: Object.freeze({
        adapter: 'passenger',
        intent,
        inspection: target,
        environmentBinding: Object.freeze({
          satisfied: environmentBinding?.satisfied === true,
          reason: environmentBinding?.reason ?? null,
          sourcePath: environmentBinding?.sourcePath ?? null,
          environmentInclude: environmentBinding?.environmentInclude ?? null,
          includeSha256: environmentBinding?.includeSha256 ?? null,
        }),
      }),
      preservation: Object.freeze({
        release: source?.releaseId === spec.releaseId,
        health: source?.healthy === true,
        environment: environment.present
          && environmentBinding?.satisfied === true
          && environmentBinding.sourcePath === environment.path
          && intent !== null
          && environmentBinding.environmentInclude === intent.environmentInclude,
      }),
      ready,
      blockers: Object.freeze(uniqueBlockers),
    });
  }

  return Object.freeze({ preview });
}

export const nodePassengerMigrationPreview = createNodePassengerMigrationPreview();
export const nodePassengerMigrationPreviewInternals = Object.freeze({
  normalizeSpec,
  targetIntent,
  ENV_ROOT,
  PASSENGER_ENV_ROOT,
  MANAGED_NODE_ROOT,
});
