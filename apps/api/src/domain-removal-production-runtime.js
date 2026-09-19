import { createDomainRemovalBackupImpactProvider } from './domain-removal-backup-impact.js';
import { createDomainRemovalOperationRegistry } from './domain-removal-operation-registry.js';
import { createDomainRemovalPreview } from './domain-removal-plan.js';
import { createDomainRemovalRuntime } from './domain-removal-runtime.js';
import { previewResourceImpact } from './resource-impact.js';

export class DomainRemovalProductionRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainRemovalProductionRuntimeError';
    this.code = code;
    this.status = status;
  }
}

export function createDomainRemovalProductionRuntime({
  filePath,
  registry,
  applicationRegistry,
  websiteRegistry,
  domainRegistry,
  certificateRegistry,
  jobRegistry,
  dnsHostingRegistry,
  mailDomainRegistry,
  mailboxRegistry,
  dockerWorkloadRegistry,
  backupOperationRegistry,
  databaseBindingRegistry,
  domainSuspensionRuntime,
  dnsZoneRetirementService = null,
  dnsZoneRetirementRuntime = null,
  mailDomainRemovalRuntime,
  roundcubeDomainMappingRegistry,
  roundcubeDomainMappingService,
  localServerId,
} = {}) {
  const required = [
    [registry, 'getServer'],
    [applicationRegistry, 'getApplication'],
    [websiteRegistry, 'getWebsite'],
    [domainRegistry, 'getDomain'],
    [certificateRegistry, 'listCertificates'],
    [jobRegistry, 'listJobs'],
    [dnsHostingRegistry, 'listZones'],
    [mailDomainRegistry, 'listMailDomains'],
    [mailboxRegistry, 'listMailboxes'],
    [dockerWorkloadRegistry, 'getWorkload'],
    [backupOperationRegistry, 'listOperations'],
    [databaseBindingRegistry, 'listBindings'],
    [roundcubeDomainMappingRegistry, 'listActiveMappings'],
    [roundcubeDomainMappingRegistry, 'listInFlight'],
  ];
  if (typeof filePath !== 'string' || !filePath
    || typeof localServerId !== 'string' || !localServerId
    || required.some(([dependency, method]) => !dependency || typeof dependency[method] !== 'function')
    || !domainSuspensionRuntime
    || !mailDomainRemovalRuntime
    || !roundcubeDomainMappingService) {
    throw new DomainRemovalProductionRuntimeError(
      'domain_removal_production_dependencies_invalid',
      'Domain removal production runtime dependencies are unavailable',
      503,
    );
  }

  async function dnsRetirementImpactProvider({ domainIds }) {
    if (!dnsZoneRetirementService) return [];
    return Promise.all(domainIds.map(async (domainId) => {
      const preview = await dnsZoneRetirementService.preview({ domainId });
      return Object.freeze({
        domainId,
        state: preview.retirementPlanReady ? 'ready' : 'blocked',
        previewDigest: preview.previewDigest,
        zoneSnapshotDigest: preview.zone.snapshotDigest,
        ownershipEvidenceDigest: preview.zone.exists
          ? preview.zone.ownershipOrigin?.evidenceDigest ?? null
          : null,
        snapshotRetentionDays: preview.zone.exists && preview.retention.configured
          ? preview.retention.snapshotRetentionDays
          : null,
        blockers: Object.freeze([...preview.blockers]),
      });
    }));
  }

  const backupImpactProvider = createDomainRemovalBackupImpactProvider({
    backupOperationRegistry,
    domainRegistry,
    websiteRegistry,
    databaseBindingRegistry,
    mailDomainRegistry,
    localServerId,
  });

  async function webmailMappingImpactProvider({ domainIds }) {
    const affected = new Set(domainIds);
    const [active, inFlight] = await Promise.all([
      roundcubeDomainMappingRegistry.listActiveMappings({ serverId: localServerId }),
      roundcubeDomainMappingRegistry.listInFlight({ serverId: localServerId }),
    ]);
    if (!Array.isArray(active) || !Array.isArray(inFlight)) {
      throw new DomainRemovalProductionRuntimeError(
        'domain_removal_webmail_inventory_invalid',
        'Webmail mapping inventory is invalid',
        503,
      );
    }
    return [...active, ...inFlight]
      .filter((mapping) => affected.has(mapping.webDomainId))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function domainPreview({ domainId } = {}) {
    const domain = await domainRegistry.getDomain(domainId);
    if (!domain || domain.serverId !== localServerId) {
      throw new DomainRemovalProductionRuntimeError(
        'domain_not_found',
        'Domain was not found on the local server',
        404,
      );
    }
    const impact = await previewResourceImpact({
      resourceType: 'domain',
      resourceId: domain.id,
      operation: 'delete',
      targetServerId: null,
      registry,
      applicationRegistry,
      websiteRegistry,
      domainRegistry,
      certificateRegistry,
      jobRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      additionalProviders: {
        dockerWorkloads: async ({ dockerWorkloadId }) => {
          if (!dockerWorkloadId) return [];
          const workload = await dockerWorkloadRegistry.getWorkload(dockerWorkloadId);
          if (!workload) throw new Error('Docker workload reference is unavailable');
          return [{ id: workload.id, state: workload.state }];
        },
        backups: backupImpactProvider,
        webmailMappings: webmailMappingImpactProvider,
        mailboxes: async ({ domainIds }) => {
          const impactedDomains = new Set(domainIds);
          const mailDomainIds = new Set((await mailDomainRegistry.listMailDomains())
            .filter((item) => item.webDomainId !== null && impactedDomains.has(item.webDomainId))
            .map((item) => item.id));
          return (await mailboxRegistry.listMailboxes())
            .filter((item) => mailDomainIds.has(item.mailDomainId))
            .map((item) => ({ id: item.id, state: item.enabled ? 'enabled' : 'disabled' }));
        },
      },
      ...(dnsZoneRetirementService ? { dnsRetirementImpactProvider } : {}),
    });
    return createDomainRemovalPreview({ domain, impact });
  }

  const operationRegistry = createDomainRemovalOperationRegistry({ filePath });
  const runtime = createDomainRemovalRuntime({
    registry: operationRegistry,
    previewProvider: domainPreview,
    suspensionRuntime: domainSuspensionRuntime,
    domainRegistry,
    certificateRegistry,
    dnsZoneRetirementRuntime,
    dnsHostingRegistry,
    mailDomainRemovalRuntime,
    roundcubeDomainMappingRegistry,
    roundcubeDomainMappingService,
  });

  return Object.freeze({
    runtime,
    registry: operationRegistry,
    preview: domainPreview,
  });
}
