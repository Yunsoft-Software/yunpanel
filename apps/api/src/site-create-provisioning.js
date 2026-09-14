import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

function metadataStep(id, kind, state, intent) {
  return {
    id,
    kind,
    state: state ? 'succeeded' : 'pending',
    intent,
    compensation: { state: 'not_required' },
  };
}

function hostStep(id, kind, intent, required = true) {
  return {
    id,
    kind,
    required,
    state: 'pending',
    intent,
    compensation: { state: 'pending' },
  };
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
  if (runtimeType === 'node' || runtimeType === 'static') {
    steps.push(hostStep('unix_identity', 'unix_identity', {
      websiteId: preview.ids.websiteId,
      unixUser: preview.plan.website.unixUser,
      documentRoot: preview.plan.website.documentRoot,
    }));
    steps.push(hostStep('runtime', 'runtime', {
      websiteId: preview.ids.websiteId,
      runtimeType,
      adapter: runtimeType === 'node' ? 'passenger' : 'static',
      applicationId: preview.plan.application?.id ?? null,
    }));
  }

  steps.push(hostStep('nginx', 'nginx', {
    websiteId: preview.ids.websiteId,
    primaryDomain: preview.plan.primaryDomain?.primaryDomain,
    targetType: preview.plan.primaryDomain?.targetType,
  }));

  if (preview.plan.primaryDomain?.httpsMode === 'managed') {
    steps.push(hostStep('certificate', 'certificate', {
      websiteId: preview.ids.websiteId,
      primaryDomain: preview.plan.primaryDomain.primaryDomain,
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
