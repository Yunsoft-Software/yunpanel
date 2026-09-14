import path from 'node:path';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

const APPLICATION_DATA_ROOT = '/var/lib/yunpanel/data';
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

function hostStep(id, kind, intent, { required = true, state = 'pending', error = null } = {}) {
  return {
    id,
    kind,
    required,
    state,
    intent,
    error,
    compensation: { state: 'pending' },
  };
}

function passengerIntent(preview, applicationId) {
  const application = preview.plan.application;
  const runtime = application?.runtime;
  if (!runtime || !runtime.start) throw new Error('Node Website provisioning requires normalized runtime state');
  const releaseRoot = preview.plan.website.documentRoot;
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
    steps.push(hostStep('unix_identity', 'unix_identity', {
      websiteId: preview.ids.websiteId,
      unixUser: preview.plan.website.unixUser,
      homeDirectory: `${APPLICATION_DATA_ROOT}/${applicationId}`,
      documentRoot: preview.plan.website.documentRoot,
    }));
    if (runtimeType === 'node') {
      runtimeIntent = passengerIntent(preview, applicationId);
      const blocked = Boolean(runtimeIntent.blocker);
      steps.push(hostStep('runtime', 'runtime', runtimeIntent, {
        state: blocked ? 'blocked' : 'pending',
        error: blocked ? runtimeIntent.blocker : null,
      }));
    } else {
      runtimeIntent = Object.freeze({
        websiteId: preview.ids.websiteId,
        runtimeType,
        adapter: 'static',
        applicationId,
      });
      steps.push(hostStep('runtime', 'runtime', runtimeIntent));
    }
  }

  steps.push(hostStep('nginx', 'nginx', {
    websiteId: preview.ids.websiteId,
    primaryDomain: preview.plan.primaryDomain?.primaryDomain,
    aliases: preview.plan.primaryDomain?.aliases ?? [],
    targetType: runtimeType === 'node' ? 'passenger' : preview.plan.primaryDomain?.targetType,
    target: runtimeType === 'node' ? runtimeIntent : preview.plan.primaryDomain?.target,
  }));

  if (preview.plan.primaryDomain?.httpsMode === 'managed') {
    steps.push(hostStep('certificate', 'certificate', {
      websiteId: preview.ids.websiteId,
      primaryDomain: preview.plan.primaryDomain.primaryDomain,
      aliases: preview.plan.primaryDomain.aliases ?? [],
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
});
