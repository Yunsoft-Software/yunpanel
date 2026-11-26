import { DockerComposeObserverError } from '@yunpanel/host-runtime';
import {
  ManagedComposeWebsiteBindingError,
  normalizeManagedComposeWebsiteBinding,
  resolveManagedComposeWebsiteBinding,
} from './managed-compose-website-binding.js';

export class ManagedComposeWebsiteDiagnosisError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ManagedComposeWebsiteDiagnosisError';
    this.code = code;
    this.status = status;
  }
}

const TARGET_ACTIONS = Object.freeze({
  managed_compose_project_not_found: ['compose_project_missing', 'review_website_binding', 'The bound Compose project no longer exists.'],
  managed_compose_project_identity_mismatch: ['compose_project_identity_mismatch', 'review_website_binding', 'The bound Compose project identity no longer matches.'],
  website_managed_compose_server_mismatch: ['compose_project_server_mismatch', 'review_website_binding', 'The bound Compose project belongs to another server.'],
  managed_compose_service_not_found: ['compose_service_not_configured', 'review_website_binding', 'The bound Compose service no longer exists in the project.'],
  managed_compose_binding_not_ready: ['nginx_target_not_published', 'publish_selected_target_port', 'The selected service port is not currently published.'],
  managed_compose_binding_ambiguous: ['nginx_target_ambiguous', 'publish_selected_target_port_once', 'The selected service port is published more than once.'],
  managed_compose_published_binding_not_loopback: ['nginx_target_not_loopback', 'publish_selected_target_port_on_loopback', 'The selected service port is not restricted to loopback.'],
  managed_compose_published_binding_invalid: ['nginx_target_invalid', 'review_published_port', 'The selected service published port is invalid.'],
});

function issue(code, severity, action, message) {
  return Object.freeze({ code, severity, action, message });
}

function targetIssue(error) {
  const mapped = TARGET_ACTIONS[error.code]
    ?? ['nginx_target_unavailable', 'review_website_binding', 'The Managed Compose Nginx target is unavailable.'];
  return issue(mapped[0], 'error', mapped[1], mapped[2]);
}

function runtimeSummary(runtime) {
  const containers = Array.isArray(runtime?.containers) ? runtime.containers : [];
  let unhealthyCount = 0;
  let restartingCount = 0;
  let oomKilledCount = 0;
  let deadCount = 0;
  let exitedCount = 0;
  let nonZeroExitCount = 0;
  const exitCodes = new Set();
  for (const container of containers) {
    const state = container?.runtime ?? {};
    if (state.health?.status === 'unhealthy') unhealthyCount += 1;
    if (state.restarting === true) restartingCount += 1;
    if (state.oomKilled === true) oomKilledCount += 1;
    if (state.dead === true) deadCount += 1;
    if (state.status === 'exited') exitedCount += 1;
    if (Number.isSafeInteger(state.exitCode)) {
      exitCodes.add(state.exitCode);
      if (state.exitCode !== 0) nonZeroExitCount += 1;
    }
  }
  return Object.freeze({
    status: typeof runtime?.status === 'string' ? runtime.status : 'unknown',
    containerCount: Number.isSafeInteger(runtime?.containerCount) ? runtime.containerCount : containers.length,
    unhealthyCount,
    restartingCount,
    oomKilledCount,
    deadCount,
    exitedCount,
    nonZeroExitCount,
    exitCodes: Object.freeze([...exitCodes].sort((left, right) => left - right).slice(0, 8)),
  });
}

function runtimeIssues(summary) {
  const issues = [];
  if (summary.status === 'absent') {
    issues.push(issue('compose_service_absent', 'error', 'start_or_redeploy_service', 'No container exists for the bound Compose service.'));
    return issues;
  }
  if (summary.deadCount > 0) {
    issues.push(issue('compose_service_dead', 'error', 'recreate_service', 'One or more service containers are dead.'));
  }
  if (summary.oomKilledCount > 0) {
    issues.push(issue('compose_service_oom_killed', 'error', 'review_memory_and_logs', 'One or more service containers were killed by the OOM killer.'));
  }
  if (summary.unhealthyCount > 0) {
    issues.push(issue('compose_service_unhealthy', 'error', 'inspect_healthcheck_and_logs', 'One or more service containers are unhealthy.'));
  }
  if (summary.restartingCount > 0 || summary.status === 'restarting') {
    issues.push(issue('compose_service_restarting', 'error', 'inspect_service_logs', 'The bound Compose service is restarting.'));
  }
  if (summary.nonZeroExitCount > 0) {
    issues.push(issue('compose_service_exited', 'error', 'inspect_service_logs', 'One or more service containers exited with a non-zero status.'));
  } else if (summary.status === 'stopped') {
    issues.push(issue('compose_service_stopped', 'error', 'start_service', 'The bound Compose service is stopped.'));
  }
  if (summary.status === 'starting') {
    issues.push(issue('compose_service_starting', 'info', 'wait_or_inspect_logs', 'The bound Compose service is still starting.'));
  }
  if (summary.status === 'degraded' && issues.length === 0) {
    issues.push(issue('compose_service_degraded', 'error', 'inspect_service_logs', 'The bound Compose service is degraded.'));
  }
  return issues;
}

function overallStatus(issues) {
  if (issues.some((item) => item.severity === 'error')) return 'action_required';
  if (issues.length > 0) return 'attention';
  return 'ready';
}

function unavailableRuntime(project) {
  return Object.freeze({
    status: project ? 'unknown' : 'unavailable',
    containerCount: 0,
    unhealthyCount: 0,
    restartingCount: 0,
    oomKilledCount: 0,
    deadCount: 0,
    exitedCount: 0,
    nonZeroExitCount: 0,
    exitCodes: Object.freeze([]),
  });
}

export async function diagnoseManagedComposeBinding({
  project,
  binding,
  serverId,
  dockerComposeObserver,
} = {}) {
  if (!dockerComposeObserver || typeof dockerComposeObserver.inspect !== 'function') {
    throw new ManagedComposeWebsiteDiagnosisError(
      'managed_compose_diagnosis_dependencies_invalid',
      'Managed Compose diagnosis dependencies are invalid',
      500,
    );
  }

  let normalizedBinding;
  try {
    normalizedBinding = normalizeManagedComposeWebsiteBinding(binding, { persisted: true });
  } catch (error) {
    if (error instanceof ManagedComposeWebsiteBindingError) {
      throw new ManagedComposeWebsiteDiagnosisError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!normalizedBinding) {
    throw new ManagedComposeWebsiteDiagnosisError(
      'managed_compose_binding_required',
      'Managed Compose binding is required',
      409,
    );
  }

  const issues = [];
  let target = Object.freeze({ ready: false, host: null, port: null });
  if (!project) {
    issues.push(targetIssue(new ManagedComposeWebsiteBindingError(
      'managed_compose_project_not_found',
      'Managed Compose project was not found',
      404,
    )));
  } else {
    try {
      const resolved = resolveManagedComposeWebsiteBinding({ binding: normalizedBinding, serverId, project });
      target = Object.freeze({
        ready: true,
        host: resolved.proxyTarget.host,
        port: resolved.proxyTarget.port,
      });
    } catch (error) {
      if (!(error instanceof ManagedComposeWebsiteBindingError)) throw error;
      issues.push(targetIssue(error));
    }
  }

  let runtime = unavailableRuntime(project);
  if (project) {
    try {
      runtime = runtimeSummary(await dockerComposeObserver.inspect({
        projectName: project.projectName,
        service: normalizedBinding.serviceName,
      }));
      issues.push(...runtimeIssues(runtime));
    } catch (error) {
      if (!(error instanceof DockerComposeObserverError)) throw error;
      issues.push(issue(
        'compose_runtime_inspection_unavailable',
        'error',
        error.code === 'docker_compose_unavailable' ? 'install_or_start_docker' : 'check_docker_service',
        'Compose service runtime state could not be inspected.',
      ));
    }
  }

  return Object.freeze({
    version: 1,
    status: overallStatus(issues),
    binding: Object.freeze({ ...normalizedBinding }),
    target,
    runtime,
    issues: Object.freeze(issues),
  });
}

export function createManagedComposeWebsiteDiagnosisService({
  websiteRegistry,
  dockerComposeProjectRegistry,
  dockerComposeObserver,
  localServerId = null,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function'
    || !dockerComposeObserver || typeof dockerComposeObserver.inspect !== 'function') {
    throw new ManagedComposeWebsiteDiagnosisError(
      'managed_compose_diagnosis_dependencies_invalid',
      'Managed Compose Website diagnosis dependencies are invalid',
      500,
    );
  }

  async function diagnose(websiteId) {
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new ManagedComposeWebsiteDiagnosisError('invalid_website_id', 'Website ID is required');
    }
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website || (localServerId && website.serverId !== localServerId)) {
      throw new ManagedComposeWebsiteDiagnosisError('website_not_found', 'Website not found', 404);
    }
    const binding = website.managedComposeBinding ?? null;
    if (!binding || website.runtimeType !== 'docker') {
      throw new ManagedComposeWebsiteDiagnosisError(
        'managed_compose_binding_required',
        'Website is not bound to a managed Compose service',
        409,
      );
    }

    const project = await dockerComposeProjectRegistry.getProject(binding.projectId);
    const diagnosis = await diagnoseManagedComposeBinding({
      project,
      binding,
      serverId: website.serverId,
      dockerComposeObserver,
    });
    return Object.freeze({ ...diagnosis, websiteId: website.id });
  }

  return Object.freeze({ diagnose });
}

export const managedComposeWebsiteDiagnosisInternals = Object.freeze({
  runtimeSummary,
  runtimeIssues,
  targetIssue,
  overallStatus,
  unavailableRuntime,
});
