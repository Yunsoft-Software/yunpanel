import { siteCreateProvisioningPlan as createBaseSiteCreateProvisioningPlan } from './site-create-provisioning.js';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);

function isolationStep(plan) {
  const website = plan.resources?.website;
  if (!website || !HOSTED_RUNTIME_TYPES.has(website.runtimeType)) return null;
  if (typeof website.applicationId !== 'string' || typeof website.unixUser !== 'string') {
    throw new Error('Hosted Website SFTP isolation requires Application and Unix identities');
  }
  return Object.freeze({
    id: 'sftp',
    kind: 'sftp',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'openssh-internal-sftp',
      websiteId: plan.websiteId,
      applicationId: website.applicationId,
      unixUser: website.unixUser,
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

export function withWebsiteIsolationSteps(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new Error('A Website provisioning plan is required');
  }
  if (plan.steps.some((step) => step.id === 'sftp')) return plan;
  const sftp = isolationStep(plan);
  if (!sftp) return plan;

  const steps = plan.steps.map((step) => ({
    ...step,
    intent: { ...step.intent },
    compensation: { ...step.compensation },
  }));
  const nginxIndex = steps.findIndex((step) => step.id === 'nginx');
  const insertAt = nginxIndex >= 0 ? nginxIndex : steps.length;
  steps.splice(insertAt, 0, sftp);

  return createWebsiteProvisioningPlan({
    operationId: plan.operationId,
    websiteId: plan.websiteId,
    resources: plan.resources,
    steps,
  });
}

export function siteCreateProvisioningPlan(preview) {
  return withWebsiteIsolationSteps(createBaseSiteCreateProvisioningPlan(preview));
}

export const siteCreateProvisioningIsolationInternals = Object.freeze({
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  isolationStep,
});
