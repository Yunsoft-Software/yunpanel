import path from 'node:path';
import { createWebsitePathContract } from '@yunpanel/host-runtime';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

const MANAGED_NODE_ROOT = '/opt/yunpanel/node-runtimes';

function metadataStep(id, kind, state, intent) {
  return {
    id,
    kind,
    state: state ? 'succeeded' : 'pending',
    intent,
    compensation: { state: 'not_required' },
  };
}

function hostStep(id, kind, intent, {
  required = true,
  state = 'pending',
  error = null,
  compensationState = 'pending',
} = {}) {
  return {
    id,
    kind,
    required,
    state,
    intent,
    error,
    compensation: { state: compensationState },
  };
}

function passengerIntent(preview, applicationId, paths = createWebsitePathContract({
  websiteId: preview?.ids?.websiteId,
  applicationId,
})) {
  const application = preview.plan.application;
  const runtime = application?.runtime;
  if (!runtime || !runtime.start) throw new Error('Node Website provisioning requires normalized runtime state');
  if (preview.plan.website.documentRoot !== paths.runtime.currentRelease) {
    throw new Error('Node Website document root does not match the managed Website path contract');
  }
  const releaseRoot = paths.runtime.currentRelease;
  const appRoot = path.posix.resolve(releaseRoot, runtime.documentRoot ?? '.');
  const base = {
    adapter: 'passenger',
    applicationId,
    websiteId: preview.ids.websiteId,
    nodeMajor: runtime.nodeMajor,
    nodeCandidates: Object.freeze([
      `${MANAGED_NODE_ROOT}/v${runtime.nodeMajor}/bin/node`,
      '/usr/bin/node',
    ]),
    appRoot,
    documentRoot: appRoot,
    startupFile: runtime.start.entryFile,
    startMode: runtime.start.mode,
    appEnv: runtime.mode,
    unixUser: preview.plan.website.unixUser,
    healthPath: runtime.healthPath,
    healthTimeoutSeconds: runtime.healthTimeoutSeconds,
  };
  if (runtime.start.mode !== 'node' || !runtime.start.entryFile) {
    return Object.freeze({
      ...base,
      blocker: 'passenger_start_mode_unsupported',
    });
  }
  return Object.freeze(base);
}

function nodeReleaseIntent(preview, applicationId, paths = createWebsitePathContract({
  websiteId: preview?.ids?.websiteId,
  applicationId,
})) {
  if (preview.source?.kind !== 'new_node') {
    throw new Error('Passenger Node release preparation is available only for new Node Websites');
  }
  const application = preview.plan.application;
  const runtime = application?.runtime;
  if (!runtime || !runtime.start) throw new Error('Node Website release preparation requires normalized runtime state');
  if (preview.plan.website.documentRoot !== paths.runtime.currentRelease) {
    throw new Error('Node Website document root does not match the managed Website path contract');
  }
  const { port: _legacyPort, ...portlessRuntime } = runtime;
  return Object.freeze({
    adapter: 'passenger-release',
    websiteId: preview.ids.websiteId,
    applicationId,
    deploymentId: preview.operationId,
    repositoryUrl: preview.source.repositoryUrl,
    branch: preview.source.branch,
    runtime: Object.freeze({
      ...portlessRuntime,
      start: Object.freeze({ ...runtime.start }),
    }),
    retention: preview.source.retention,
    currentRelease: paths.runtime.currentRelease,
    releasesDirectory: paths.runtime.releasesDirectory,
  });
}

function passengerApplicationReleaseIntent(preview, applicationId) {
  if (preview.source?.kind !== 'new_node' || preview.plan.application?.runtimeAdapter !== 'passenger') {
    throw new Error('Passenger Application release finalization requires a new Passenger Node Website');
  }
  return Object.freeze({
    adapter: 'passenger-application-release',
    applicationId,
    releaseId: preview.operationId,
  });
}

function passengerAuthorityIntent(preview, applicationId) {
  if (preview.source?.kind !== 'new_node' || preview.plan.application?.runtimeAdapter !== 'passenger') {
    throw new Error('Passenger runtime authority requires a new Passenger Node Website');
  }
  return Object.freeze({
    adapter: 'passenger-authority',
    applicationId,
    websiteId: preview.ids.websiteId,
    domainIds: Object.freeze([
      preview.ids.primaryDomainId,
      preview.ids.wwwDomainId,
    ].filter(Boolean)),
  });
}

function staticIntent(preview, applicationId, paths = createWebsitePathContract({
  websiteId: preview?.ids?.websiteId,
  applicationId,
})) {
  const application = preview.plan.application;
  if (!application || application.type !== 'static') {
    throw new Error('Static Website provisioning requires normalized Application state');
  }
  if (preview.plan.website.documentRoot !== path.posix.join(paths.static.publishRoot, 'current')) {
    throw new Error('Static Website document root does not match the managed Website path contract');
  }

  const base = {
    websiteId: preview.ids.websiteId,
    runtimeType: 'static',
    adapter: 'static',
    applicationId,
    homeDirectory: paths.workspace.homeDirectory,
    buildRoot: paths.static.buildRoot,
    publishRoot: paths.static.publishRoot,
  };
  if (preview.source?.kind !== 'new_static') {
    return Object.freeze({ ...base, mode: 'bind_existing' });
  }
  if (typeof application.repositoryUrl !== 'string' || typeof application.branch !== 'string'
    || !application.build || typeof application.build !== 'object'
    || !Number.isInteger(application.retention)) {
    throw new Error('New static Website provisioning requires complete deployment state');
  }
  return Object.freeze({
    ...base,
    mode: 'deploy',
    deploymentId: preview.operationId,
    repositoryUrl: application.repositoryUrl,
    branch: application.branch,
    build: Object.freeze({ ...application.build }),
    retention: application.retention,
  });
}

function websiteAliases(preview) {
  const values = [
    ...(preview.plan.primaryDomain?.aliases ?? []),
    ...(preview.plan.wwwDomain?.primaryDomain ? [preview.plan.wwwDomain.primaryDomain] : []),
  ];
  return Object.freeze([...new Set(values)]);
}

export function siteCreateProvisioningPlan(preview) {
  if (!preview || typeof preview !== 'object' || !preview.ids?.websiteId || !preview.operationId || !preview.plan?.website) {
    throw new Error('A valid site-create preview is required');
  }

  const steps = [];
  if (preview.plan.application) {
    steps.push(metadataStep(
      'application_metadata',
      'application_metadata',
      preview.steps?.applicationReady === true,
      { applicationId: preview.plan.application.id },
    ));
  }
  if (preview.plan.dockerWorkload) {
    steps.push(metadataStep(
      'docker_workload_binding',
      'docker_workload_binding',
      preview.steps?.dockerWorkloadReady === true,
      { dockerWorkloadId: preview.plan.dockerWorkload.id },
    ));
  }
  steps.push(metadataStep(
    'website_metadata',
    'website_metadata',
    preview.steps?.websiteReady === true,
    { websiteId: preview.ids.websiteId },
  ));
  steps.push(metadataStep(
    'primary_domain_metadata',
    'domain_metadata',
    preview.steps?.primaryDomainReady === true,
    { domainId: preview.ids.primaryDomainId, hostname: preview.plan.primaryDomain?.primaryDomain },
  ));
  if (preview.plan.wwwDomain) {
    steps.push(metadataStep(
      'www_domain_metadata',
      'domain_metadata',
      preview.steps?.wwwDomainReady === true,
      { domainId: preview.ids.wwwDomainId, hostname: preview.plan.wwwDomain.primaryDomain },
    ));
  }

  const runtimeType = preview.plan.website.runtimeType;
  let runtimeIntent = null;
  if (runtimeType === 'node' || runtimeType === 'static') {
    const applicationId = preview.plan.application?.id;
    if (!applicationId) throw new Error('Hosted Website provisioning requires an Application identity');
    const identity = createApplicationIdentity(applicationId);
    if (preview.plan.website.unixUser !== identity.unixUser) {
      throw new Error('Website Unix user does not match the managed Application identity');
    }
    const paths = createWebsitePathContract({
      websiteId: preview.ids.websiteId,
      applicationId,
    });
    steps.push(hostStep('unix_identity', 'unix_identity', {
      websiteId: preview.ids.websiteId,
      applicationId,
      unixUser: identity.unixUser,
      homeDirectory: paths.workspace.homeDirectory,
      documentRoot: preview.plan.website.documentRoot,
    }));
    if (runtimeType === 'node') {
      if (preview.source?.kind === 'new_node') {
        steps.push(hostStep('node_release', 'node_release', nodeReleaseIntent(preview, applicationId, paths), {
          compensationState: 'pending',
        }));
      }
      runtimeIntent = passengerIntent(preview, applicationId, paths);
      const blocked = Boolean(runtimeIntent.blocker);
      steps.push(hostStep('runtime', 'runtime', runtimeIntent, {
        state: blocked ? 'blocked' : 'pending',
        error: blocked ? runtimeIntent.blocker : null,
        compensationState: 'not_required',
      }));
    } else {
      runtimeIntent = staticIntent(preview, applicationId, paths);
      steps.push(hostStep('runtime', 'static_runtime', runtimeIntent, {
        compensationState: runtimeIntent.mode === 'bind_existing' ? 'not_required' : 'pending',
      }));
    }
  }

  const aliases = websiteAliases(preview);
  steps.push(hostStep('nginx', 'nginx', {
    websiteId: preview.ids.websiteId,
    primaryDomain: preview.plan.primaryDomain?.primaryDomain,
    aliases,
    targetType: runtimeType === 'node' ? 'passenger' : preview.plan.primaryDomain?.targetType,
    target: runtimeType === 'node' ? runtimeIntent : preview.plan.primaryDomain?.target,
  }));

  if (runtimeType === 'node' && preview.source?.kind === 'new_node') {
    const applicationId = preview.plan.application?.id;
    steps.push(hostStep(
      'application_release',
      'passenger_application_release',
      passengerApplicationReleaseIntent(preview, applicationId),
      { compensationState: 'pending' },
    ));
    steps.push(hostStep(
      'passenger_authority',
      'passenger_authority',
      passengerAuthorityIntent(preview, applicationId),
      { compensationState: 'pending' },
    ));
  }

  if (preview.plan.primaryDomain?.httpsMode === 'managed') {
    steps.push(hostStep('certificate', 'certificate', {
      websiteId: preview.ids.websiteId,
      primaryDomainId: preview.ids.primaryDomainId,
      primaryDomain: preview.plan.primaryDomain.primaryDomain,
      aliases,
      wwwDomainId: preview.ids.wwwDomainId ?? null,
      wwwDomain: preview.plan.wwwDomain?.primaryDomain ?? null,
    }));
  }

  return createWebsiteProvisioningPlan({
    operationId: preview.operationId,
    websiteId: preview.ids.websiteId,
    resources: preview.plan,
    steps,
  });
}

export const siteCreateProvisioningInternals = Object.freeze({
  passengerIntent,
  nodeReleaseIntent,
  passengerApplicationReleaseIntent,
  passengerAuthorityIntent,
  staticIntent,
  websiteAliases,
});
