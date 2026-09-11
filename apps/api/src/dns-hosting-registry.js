import { createExternalLifecycleRegistry } from './external-lifecycle-registry.js';

export function createDnsHostingRegistry(options = {}) {
  const registry = createExternalLifecycleRegistry({
    ...options,
    prefix: 'dns_zone',
    resourceType: 'dns_zone',
    collectionKey: 'dnsZones',
    nameField: 'zoneName',
  });
  return Object.freeze({
    init: registry.init,
    createZone: ({ zoneName, webDomainId = null, managementMode } = {}) => registry.createResource({
      name: zoneName, webDomainId, managementMode,
    }),
    recordObservation: registry.recordObservation,
    getZone: registry.getResource,
    listZones: registry.listResources,
  });
}
