import { createWebsitePythonReleaseManager } from '@yunpanel/host-runtime/website-python-release-manager';

export class WebsitePythonReleaseProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePythonReleaseProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function releaseSpec(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || intent.adapter !== 'python-release'
    || typeof intent.applicationId !== 'string'
    || typeof intent.deploymentId !== 'string'
    || typeof intent.repositoryUrl !== 'string'
    || typeof intent.branch !== 'string'
    || !intent.runtime || typeof intent.runtime !== 'object' || Array.isArray(intent.runtime)) {
    throw new WebsitePythonReleaseProvisioningError(
      'website_python_release_intent_invalid',
      'Python release provisioning intent is invalid',
    );
  }
  return Object.freeze({
    applicationId: intent.applicationId,
    deploymentId: intent.deploymentId,
    repositoryUrl: intent.repositoryUrl,
    branch: intent.branch,
    gitTarget: intent.gitTarget,
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

export function createWebsitePythonReleaseProvisioningHandler({
  pythonReleaseManager = createWebsitePythonReleaseManager(),
  gitCredentialProvider = null,
} = {}) {
  if (!pythonReleaseManager
    || typeof pythonReleaseManager.prepare !== 'function'
    || typeof pythonReleaseManager.inspectDeployment !== 'function'
    || typeof pythonReleaseManager.compensate !== 'function'
    || typeof pythonReleaseManager.inspectCompensation !== 'function'
    || (gitCredentialProvider !== null && typeof gitCredentialProvider !== 'function')) {
    throw new WebsitePythonReleaseProvisioningError(
      'website_python_release_dependencies_invalid',
      'Python release provisioning dependencies are invalid',
      503,
    );
  }

  async function apply({ intent } = {}) {
    const spec = releaseSpec(intent);
    const current = await pythonReleaseManager.inspectDeployment(spec);
    if (current?.satisfied === true) return current;
    const gitCredential = gitCredentialProvider
      ? await gitCredentialProvider(spec.applicationId)
      : null;
    return pythonReleaseManager.prepare(spec, { gitCredential });
  }

  async function inspect({ intent } = {}) {
    return pythonReleaseManager.inspectDeployment(releaseSpec(intent));
  }

  async function compensate(context = {}) {
    const target = compensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_python_release_compensation_evidence_missing' });
    }
    return pythonReleaseManager.compensate(target);
  }

  async function inspectCompensation(context = {}) {
    const target = compensationTarget(context);
    if (!target) {
      return Object.freeze({ satisfied: false, reason: 'website_python_release_compensation_evidence_missing' });
    }
    return pythonReleaseManager.inspectCompensation(target);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websitePythonReleaseProvisioningInternals = Object.freeze({
  releaseSpec,
  compensationTarget,
});
