import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';
import { siteCreateProvisioningPlan as createIsolatedSiteCreateProvisioningPlan } from './site-create-provisioning-isolation.js';
import { deterministicWebsiteMailDkimSelector } from './website-mail-dkim-selector.js';

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

function localMailDkimKeyStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain || mailDomain.managementMode !== 'local') return null;
  const serverId = preview.plan?.website?.serverId;
  if (typeof serverId !== 'string' || !serverId
    || typeof preview.ids?.websiteId !== 'string' || !preview.ids.websiteId
    || typeof mailDomain.webDomainId !== 'string' || !mailDomain.webDomainId) {
    throw new Error('Local DKIM provisioning requires exact Website ownership');
  }
  return Object.freeze({
    id: 'mail_dkim_key',
    kind: 'mail_dkim_key',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'managed-mail-dkim-key',
      serverId,
      websiteId: preview.ids.websiteId,
      webDomainId: mailDomain.webDomainId,
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
      expectedMailDomainRevision: 2,
      expectedMailDomainStatus: 'enabled',
      expectedKeyRevision: 0,
      selector: deterministicWebsiteMailDkimSelector(preview.operationId),
    }),
    compensation: Object.freeze({ state: 'not_required' }),
  });
}

function localWebmailCertificateStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain || mailDomain.managementMode !== 'local') return null;
  const serverId = preview.plan?.website?.serverId;
  const webmail = preview.plan?.webmail;
  if (typeof serverId !== 'string' || !serverId
    || typeof preview.ids?.websiteId !== 'string' || !preview.ids.websiteId
    || typeof mailDomain.webDomainId !== 'string' || !mailDomain.webDomainId
    || !webmail || webmail.sharedRoundcube !== true
    || webmail.certificateCoverageRequired !== true
    || webmail.hostname !== `webmail.${mailDomain.domainName}`) {
    throw new Error('Local webmail certificate provisioning requires exact Website ownership');
  }
  return Object.freeze({
    id: 'webmail_certificate',
    kind: 'webmail_certificate',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'acme-webmail-certificate',
      serverId,
      websiteId: preview.ids.websiteId,
      webDomainId: mailDomain.webDomainId,
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
      hostname: webmail.hostname,
      expectedMailDomainRevision: 2,
    }),
    compensation: Object.freeze({ state: 'not_required' }),
  });
}

function localMailDkimConfigStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain || mailDomain.managementMode !== 'local') return null;
  const serverId = preview.plan?.website?.serverId;
  if (typeof serverId !== 'string' || !serverId
    || typeof preview.ids?.websiteId !== 'string' || !preview.ids.websiteId
    || typeof mailDomain.webDomainId !== 'string' || !mailDomain.webDomainId) {
    throw new Error('Local DKIM configuration requires exact Website ownership');
  }
  return Object.freeze({
    id: 'mail_dkim_config',
    kind: 'mail_dkim_config',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'managed-mail-dkim-config',
      serverId,
      websiteId: preview.ids.websiteId,
      webDomainId: mailDomain.webDomainId,
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
      expectedMailDomainRevision: 2,
      expectedMailDomainStatus: 'enabled',
      expectedKeyRevision: 1,
      selector: deterministicWebsiteMailDkimSelector(preview.operationId),
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function localRoundcubeMappingStep(preview) {
  const mailDomain = preview.plan?.mailDomain;
  if (!mailDomain || mailDomain.managementMode !== 'local') return null;
  const serverId = preview.plan?.website?.serverId;
  if (typeof serverId !== 'string' || !serverId
    || typeof preview.ids?.websiteId !== 'string' || !preview.ids.websiteId
    || typeof mailDomain.webDomainId !== 'string' || !mailDomain.webDomainId) {
    throw new Error('Local Roundcube provisioning requires exact Website ownership');
  }
  return Object.freeze({
    id: 'roundcube_mapping',
    kind: 'roundcube_mapping',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: 'shared-roundcube-mapping',
      serverId,
      websiteId: preview.ids.websiteId,
      webDomainId: mailDomain.webDomainId,
      mailDomainId: mailDomain.id,
      domainName: mailDomain.domainName,
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
  const mailDkimKey = localMailDkimKeyStep(preview);
  const webmailCertificate = localWebmailCertificateStep(preview);
  const mailDkimConfig = localMailDkimConfigStep(preview);
  const roundcubeMapping = localRoundcubeMappingStep(preview);
  if (!metadata && !mailConfig && !mailDkimKey && !webmailCertificate && !mailDkimConfig && !roundcubeMapping) return plan;
  if (plan.steps.some((step) => ['mail_domain_metadata', 'mail_config', 'mail_dkim_key', 'webmail_certificate', 'mail_dkim_config', 'roundcube_mapping'].includes(step.id)
    || ['mail_domain_metadata', 'mail_config', 'mail_dkim_key', 'webmail_certificate', 'mail_dkim_config', 'roundcube_mapping'].includes(step.kind))) {
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
    const tlsActivationIndex = steps.findIndex((step) => step.id === 'tls_activation');
    const certificateIndex = steps.findIndex((step) => step.id === 'certificate');
    const mailConfigIndex = tlsActivationIndex >= 0
      ? tlsActivationIndex + 1
      : certificateIndex >= 0 ? certificateIndex + 1 : steps.length;
    steps.splice(mailConfigIndex, 0, mailConfig);
    if (mailDkimKey) steps.splice(mailConfigIndex + 1, 0, mailDkimKey);
    if (webmailCertificate) steps.splice(mailConfigIndex + 2, 0, webmailCertificate);
    if (mailDkimConfig) steps.splice(mailConfigIndex + 3, 0, mailDkimConfig);
    if (roundcubeMapping) steps.splice(mailConfigIndex + 4, 0, roundcubeMapping);
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
  localMailDkimKeyStep,
  localWebmailCertificateStep,
  localMailDkimConfigStep,
  localRoundcubeMappingStep,
  withSiteCreateMailSteps,
});
