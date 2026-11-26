import { createWebsiteNodeReleaseManager } from '@yunpanel/host-runtime/website-node-release-manager';

export class WebsiteNodeReleaseProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteNodeReleaseProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function releaseSpec(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'passenger-release'
    || typeof intent.applicationId !== 'string'
    || typeof intent.deploymentId !== 'string'
    || typeof intent.repositoryUrl !== 'string'
    || typeof intent.branch !== 'string'
    || !intent.runtime || typeof intent.runtime !== 'object' || Array.isArray(intent.runtime)) {
    throw new WebsiteNodeReleaseProvisioningError(
      'website_node_release_intent_invalid',
      'Passenger Node release provisioning intent is invalid',
    );
  }
  return Object.freeze({
    applicationId: intent.applicationId,
    deploymentId: intent.deploymentId,
    repositoryUrl: intent.repositoryUrl,
    branch: intent.branch,
    runtime: intent.runtime,
    retention: intent.retention,
  });
}

function compensationTarget(context = {}) {
  const spec = releaseSpec(context.intent);
  const previousReleaseId = context.evidence?.previousReleaseId;
  if (previousReleaseId !== null && typeof previousReleaseId !== 'string') {
    return null;
  }
  return Object.freeze({
    applicationId: spec.applicationId,
    deploymentId: spec.deploymentId,
    previousReleaseId,
  });
}

export function createWebsiteNodeReleaseProvisioningHandler({
  nodeReleaseManager = createWebsiteNodeReleaseManager(),
  gitCredentialProvider = null,
} = {}) {
  if (!nodeReleaseManager
    || typeof nodeReleaseManager.prepare !== 'function'
    || typeof nodeReleaseManager.inspectDeployment !== 'function'
    || typeof nodeReleaseManager.compensate !== 'function'
    || typeof nodeReleaseManager.inspectCompensation !== 'function'
    || (gitCredentialProvider !== null && typeof gitCredentialProvider !== 'function')) {
    throw new WebsiteNodeReleaseProvisioningError(
      'website_node_release_dependencies_invalid',
      'Passenger Node release provisioning dependencies are invalid',
      503,
    );
  }

  async function apply({ intent } = {}) {
    const spec = releaseSpec(intent);
    const current = await nodeReleaseManager.inspectDeployment(spec);
    if (current?.satisfied === true) return current;
    const gitCredential = gitCredentialProvider
      ? await gitCredentialProvider(spec.applicationId)
      : null;
    return nodeReleaseManager.prepare(spec, { gitCredential });
  }

  async function inspect({ intent } = {}) {
    return nodeReleaseManager.inspectDeployment(releaseSpec(intent));
  }

  async function compensate(context = {}) {
    const target = compensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_node_release_compensation_evidence_missing' });
    }
    return nodeReleaseManager.compensate(target);
  }

  async function inspectCompensation(context = {}) {
    const target = compensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_node_release_compensation_evidence_missing' });
    }
    return nodeReleaseManager.inspectCompensation(target);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteNodeReleaseProvisioningInternals = Object.freeze({
  releaseSpec,
  compensationTarget,
});
