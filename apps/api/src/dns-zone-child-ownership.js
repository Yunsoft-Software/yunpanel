import { dnsZoneRetirementInternals } from './dns-zone-retirement.js';

// A child Domain may have its own zone, but its hostname/parent relationship
// alone is never authority to use PowerDNS credentials against that zone.
export async function hasOwnChildDnsZone(domain, provisioningRegistry) {
  if (!domain?.websiteId || !provisioningRegistry) return false;
  const operations = await provisioningRegistry.listForDnsZone({
    serverId: domain.serverId,
    webDomainId: domain.id,
    zoneName: domain.primaryDomain,
  });
  if (!Array.isArray(operations)) throw new Error('Invalid DNS provisioning history');
  if (operations.some(operation => operation?.websiteId !== domain.websiteId)) return false;
  const claims = operations.flatMap(operation => {
    if (!Array.isArray(operation.steps)) throw new Error('Invalid DNS provisioning steps');
    return operation.steps.filter(step => step?.kind === 'dns_zone' && step.state === 'succeeded'
      && step.evidence?.created === true && step.compensation?.state !== 'succeeded');
  });
  if (claims.length !== 1) return false;
  return dnsZoneRetirementInternals.provisioningOwnership(domain, operations).status === 'provisioning_created';
}
