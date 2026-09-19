import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';
import { siteCreateProvisioningPlan as createIsolatedSiteCreateProvisioningPlan } from './site-create-provisioning-isolation.js';

function mailDomainMetadataStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain) return null;
  return Object.freeze({
    id: 'mail_domain_metadata',
    kind: 'mail_domain_metadata',
    required: true,
    state: preview.steps?.mailDomainReady === true ? 'succeeded' : 'pending',
    intent: Object.freeze({
      adapter: 'mail-domain-metadata',
      mailDomainId: mailDomain.id,
      webDomainId: mailDomain.webDomainId,
      domainName: mailDomain.domainName,
      managementMode: mailDomain.managementMode,
    }),
    compensation: Object.freeze({ state: 'not_required' }),
  });
}

function localMailConfigStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain || mailDomain.managementMode !== 'local') return null;
  if (mailDomain.initialStatus !== 'disabled' || mailDomain.desiredStatus !== 'enabled') {
    throw new Error('Local Mail Domain provisioning intent must start disabled and target enabled');
  }
  const serverId = preview.plan?.website?.serverId;
  if (typeof serverId !== 'string' || !serverId) {
    throw new Error('Local Mail Domain provisioning requires the Website server identity');
  }
  return Object.freeze({
    id: 'mail_config',
    kind: 'mail_config',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'managed-mail-config',
      serverId,
      websiteId: preview.ids.websiteId,
      webDomainId: mailDomain.webDomainId,
      mailDomainId: mailDomain.id,
      expectedRevision: 1,
      initialStatus: 'disabled',
      desiredStatus: 'enabled',
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function cloneSteps(steps) {
  return steps.map((step) => ({
    ...step,
    intent: { ...step.intent },
    compensation: { ...step.compensation },
  }));
}

export function withSiteCreateMailSteps(plan, preview) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new Error('A Website provisioning plan is required');
  }
  const metadata = mailDomainMetadataStep(preview);
  const mailConfig = localMailConfigStep(preview);
  if (!metadata && !mailConfig) return plan;
  if (plan.steps.some((step) => ['mail_domain_metadata', 'mail_config'].includes(step.id)
    || ['mail_domain_metadata', 'mail_config'].includes(step.kind))) {
    throw new Error('Website provisioning already contains Mail Domain steps');
  }

  const steps = cloneSteps(plan.steps);
  const firstHostIndex = steps.findIndex((step) => ![
    'application_metadata',
    'docker_workload_binding',
    'website_metadata',
    'domain_metadata',
  ].includes(step.kind));
  steps.splice(firstHostIndex >= 0 ? firstHostIndex : steps.length, 0, metadata);

  if (mailConfig) {
    const certificateIndex = steps.findIndex((step) => step.id === 'certificate');
    steps.splice(certificateIndex >= 0 ? certificateIndex + 1 : steps.length, 0, mailConfig);
  }

  return createWebsiteProvisioningPlan({
    operationId: plan.operationId,
    websiteId: plan.websiteId,
    resources: plan.resources,
    steps,
  });
}

export function siteCreateProvisioningPlan(preview) {
  return withSiteCreateMailSteps(createIsolatedSiteCreateProvisioningPlan(preview), preview);
}

export const siteCreateMailProvisioningInternals = Object.freeze({
  mailDomainMetadataStep,
  localMailConfigStep,
  withSiteCreateMailSteps,
});
