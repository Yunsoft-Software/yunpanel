import { websiteDnsZoneProvisioningInternals } from '../../src/website-dns-zone-provisioning-handler.js';

export function ownedDnsZoneOperation(domain) {
  const records = [
    { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    { key: 'apex-ns', type: 'NS', name: '@', ttl: 300, values: ['ns1.host.example'], source: 'template' },
  ];
  const intent = {
    adapter: 'powerdns-zone', serverId: domain.serverId, webDomainId: domain.id,
    zoneName: domain.primaryDomain, templateVersion: 1, templateSnapshot: records,
    dnsIdentityRevision: 1, secondaryDns: [], serial: 2026091801, dnssec: false, records,
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    { kind: 'Primary', serial: 2026091801, dnssec: false, managedRrsetCount: 2,
      manualRrsetCount: 0, created: true, primaryKindChanged: false, changedRrsetCount: 1 },
  );
  return { operationId: '52345678-1234-4234-8234-123456789012', websiteId: domain.websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{ id: 'dns_zone', kind: 'dns_zone', state: 'succeeded', intent, evidence }] };
}
