import { siteCreateProvisioningPlan as createBaseSiteCreateProvisioningPlan } from './site-create-provisioning.js';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const SFTP_ADAPTER = 'openssh-internal-sftp';

function exactIntent(candidate, expected) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const expectedEntries = Object.entries(expected);
  return Object.keys(candidate).length === expectedEntries.length
    && expectedEntries.every(([key, value]) => candidate[key] === value);
}

function isolationContract(plan) {
  const website = plan.resources?.website;
  if (!website || !HOSTED_RUNTIME_TYPES.has(website.runtimeType)) return null;
  if (website.id !== plan.websiteId) {
    throw new Error('Hosted Website isolation requires the canonical Website identity');
  }
  if (typeof website.applicationId !== 'string' || typeof website.unixUser !== 'string') {
    throw new Error('Hosted Website SFTP isolation requires Application and Unix identities');
  }
  const applicationId = website.applicationId;
  if (plan.resources?.application?.id && plan.resources.application.id !== applicationId) {
    throw new Error('Hosted Website isolation Application identity does not match Website ownership');
  }
  return Object.freeze({
    websiteId: plan.websiteId,
    applicationId,
    unixUser: website.unixUser,
  });
}

function assertUnixIdentityStep(plan, contract) {
  const matches = plan.steps.filter((step) => step.id === 'unix_identity' || step.kind === 'unix_identity');
  if (matches.length !== 1) {
    throw new Error('Hosted Website isolation requires exactly one canonical Unix identity step');
  }
  const [step] = matches;
  const expected = {
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
  };
  if (step.id !== 'unix_identity' || step.kind !== 'unix_identity'
    || !Object.entries(expected).every(([key, value]) => step.intent?.[key] === value)) {
    throw new Error('Hosted Website Unix identity step does not match canonical Website ownership');
  }
}

function isolationStep(contract) {
  return Object.freeze({
    id: 'sftp',
    kind: 'sftp',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: SFTP_ADAPTER,
      websiteId: contract.websiteId,
      applicationId: contract.applicationId,
      unixUser: contract.unixUser,
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function existingSftpStep(plan) {
  const matches = plan.steps.filter((step) => step.id === 'sftp' || step.kind === 'sftp');
  if (matches.length > 1) {
    throw new Error('Website provisioning contains duplicate SFTP isolation steps');
  }
  return matches[0] ?? null;
}

function assertSftpStep(step, contract) {
  const expectedIntent = {
    adapter: SFTP_ADAPTER,
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
  };
  if (step.id !== 'sftp' || step.kind !== 'sftp' || step.required !== true || !exactIntent(step.intent, expectedIntent)) {
    throw new Error('Existing Website SFTP step does not match canonical Website isolation intent');
  }
}

export function withWebsiteIsolationSteps(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new Error('A Website provisioning plan is required');
  }

  const contract = isolationContract(plan);
  const existingSftp = existingSftpStep(plan);
  if (!contract) {
    if (existingSftp) throw new Error('Non-hosted Website provisioning must not contain an SFTP isolation step');
    return plan;
  }

  assertUnixIdentityStep(plan, contract);
  if (existingSftp) {
    assertSftpStep(existingSftp, contract);
    return plan;
  }

  const sftp = isolationStep(contract);
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
  isolationContract,
  assertUnixIdentityStep,
  isolationStep,
  existingSftpStep,
  assertSftpStep,
});
