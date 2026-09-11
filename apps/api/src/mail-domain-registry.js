import { createExternalLifecycleRegistry } from './external-lifecycle-registry.js';

export function createMailDomainRegistry(options = {}) {
  const registry = createExternalLifecycleRegistry({
    ...options,
    prefix: 'mail_domain',
    resourceType: 'mail_domain',
    collectionKey: 'mailDomains',
    nameField: 'domainName',
  });
  return Object.freeze({
    init: registry.init,
    createMailDomain: ({ domainName, webDomainId = null, managementMode } = {}) => registry.createResource({
      name: domainName, webDomainId, managementMode,
    }),
    recordObservation: registry.recordObservation,
    getMailDomain: registry.getResource,
    listMailDomains: registry.listResources,
  });
}
