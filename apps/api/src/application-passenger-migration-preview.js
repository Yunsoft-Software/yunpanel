import { createHash } from 'node:crypto';
import { createNodePassengerMigrationPreview } from '@yunpanel/host-runtime/node-passenger-migration-preview';
import { ApplicationRegistryError } from './application-registry.js';

function blocker(code, detail = null) {
  return Object.freeze({ code, ...(detail ? { detail } : {}) });
}

function applicationSpec(application) {
  return Object.freeze({
    applicationId: application.id,
    releaseId: application.currentReleaseId,
    runtime: application.activeRuntime,
  });
}

function publicWebsiteBinding(website) {
  return website ? Object.freeze({
    websiteId: website.id,
    revision: website.revision,
    runtimeType: website.runtimeType,
    applicationId: website.applicationId,
  }) : null;
}

function publicDomainBinding(domain) {
  return domain ? Object.freeze({
    domainId: domain.id,
    websiteId: domain.websiteId ?? null,
    primaryDomain: domain.primaryDomain,
    aliases: Object.freeze([...domain.aliases]),
    desiredRevision: domain.desiredRevision,
    appliedRevision: domain.appliedRevision,
    state: domain.state,
    httpsMode: domain.httpsMode,
    targetType: domain.targetType,
  }) : null;
}

function hostDigestEvidence(host) {
  if (!host) return null;
  return Object.freeze({
    applicationId: host.applicationId ?? null,
    releaseId: host.releaseId ?? null,
    ready: host.ready === true,
    source: host.source ? Object.freeze({
      serviceName: host.source.serviceName ?? null,
      releaseId: host.source.releaseId ?? null,
      activeState: host.source.activeState ?? null,
      healthy: host.source.healthy === true,
      port: host.source.port ?? null,
      healthPath: host.source.healthPath ?? null,
    }) : null,
    environment: host.environment ? Object.freeze({
      present: host.environment.present === true,
      sha256: host.environment.sha256 ?? null,
    }) : null,
    target: host.target ? Object.freeze({
      intent: host.target.intent ?? null,
      inspection: host.target.inspection ? Object.freeze({
        satisfied: host.target.inspection.satisfied === true,
        nodeBinary: host.target.inspection.nodeBinary ?? null,
      }) : null,
      environmentBinding: host.target.environmentBinding ? Object.freeze({
        satisfied: host.target.environmentBinding.satisfied === true,
        sourcePath: host.target.environmentBinding.sourcePath ?? null,
        environmentInclude: host.target.environmentBinding.environmentInclude ?? null,
        includeSha256: host.target.environmentBinding.includeSha256 ?? null,
      }) : null,
    }) : null,
  });
}

function previewDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createApplicationPassengerMigrationPreviewService({
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  hostPreview = createNodePassengerMigrationPreview(),
  localServerId = null,
} = {}) {
  if (!applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || !websiteRegistry || typeof websiteRegistry.listWebsites !== 'function'
    || !domainRegistry || typeof domainRegistry.listDomains !== 'function'
    || !hostPreview || typeof hostPreview.preview !== 'function') {
    throw new Error('Application Passenger migration preview dependencies are required');
  }

  async function preview(applicationId) {
    const application = await applicationRegistry.getApplication(applicationId);
    if (!application || (localServerId && application.serverId !== localServerId)) {
      throw new ApplicationRegistryError('application_not_found', 'Application not found', 404);
    }
    if (application.type !== 'node') {
      throw new ApplicationRegistryError('node_passenger_migration_not_supported', 'Passenger migration is available only for Node applications', 409);
    }
    if (!application.currentReleaseId || !application.activeRuntime) {
      throw new ApplicationRegistryError('application_not_deployed', 'Application has no active release to migrate', 409);
    }
    if (application.activeDeploymentId) {
      throw new ApplicationRegistryError('deployment_in_progress', 'Application already has an active operation', 409);
    }

    const blockers = [];
    const websites = (await websiteRegistry.listWebsites({ serverId: application.serverId }))
      .filter((website) => website.applicationId === application.id);
    if (websites.length === 0) blockers.push(blocker('website_binding_missing'));
    if (websites.length > 1) blockers.push(blocker('website_binding_ambiguous'));
    const website = websites.length === 1 ? websites[0] : null;
    if (website && website.runtimeType !== 'node') blockers.push(blocker('website_runtime_mismatch', website.runtimeType));

    const domains = website
      ? (await domainRegistry.listDomains()).filter((domain) => (
          domain.serverId === application.serverId && domain.websiteId === website.id
        ))
      : [];
    if (website && domains.length === 0) blockers.push(blocker('domain_binding_missing'));
    if (domains.length > 1) blockers.push(blocker('multiple_domain_routes_unsupported', String(domains.length)));
    const domain = domains.length === 1 ? domains[0] : null;

    if (domain) {
      if (domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision) {
        blockers.push(blocker('domain_route_not_current'));
      }
      const target = domain.target;
      if (domain.targetType !== 'proxy'
        || target?.upstreamHost !== '127.0.0.1'
        || target?.upstreamPort !== application.activeRuntime.port) {
        blockers.push(blocker('legacy_proxy_route_mismatch'));
      }
    }

    let host = null;
    try {
      host = await hostPreview.preview(applicationSpec(application));
    } catch (error) {
      blockers.push(blocker('host_preview_failed', typeof error?.code === 'string' ? error.code : 'unknown'));
    }
    if (host && host.applicationId !== application.id) blockers.push(blocker('host_preview_application_mismatch'));
    if (host && host.releaseId !== application.currentReleaseId) blockers.push(blocker('host_preview_release_mismatch'));

    const uniqueBlockers = [...new Map(blockers.map((entry) => [`${entry.code}:${entry.detail ?? ''}`, entry])).values()];
    const applicationBinding = Object.freeze({
      applicationId: application.id,
      serverId: application.serverId,
      releaseId: application.currentReleaseId,
      desiredRevision: application.desiredRevision,
      appliedRevision: application.appliedRevision,
    });
    const websiteBinding = publicWebsiteBinding(website);
    const domainBinding = publicDomainBinding(domain);
    const digest = previewDigest({
      version: 1,
      application: applicationBinding,
      website: websiteBinding,
      domain: domainBinding,
      domainCount: domains.length,
      host: hostDigestEvidence(host),
      blockers: uniqueBlockers,
    });
    return Object.freeze({
      version: 1,
      mode: 'read-only',
      mutationPerformed: false,
      application: applicationBinding,
      website: websiteBinding,
      domain: domainBinding,
      domainCount: domains.length,
      host,
      ready: uniqueBlockers.length === 0 && host?.ready === true,
      blockers: Object.freeze(uniqueBlockers),
      previewDigest: digest,
      confirmation: `migrate-node-passenger:${application.id}:${digest}`,
    });
  }

  return Object.freeze({ preview });
}

export const applicationPassengerMigrationPreviewInternals = Object.freeze({
  blocker,
  applicationSpec,
  publicWebsiteBinding,
  publicDomainBinding,
  hostDigestEvidence,
  previewDigest,
});
