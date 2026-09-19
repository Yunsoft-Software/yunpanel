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
    createMailDomain: ({
      mailDomainId = null,
      domainName,
      webDomainId = null,
      managementMode,
    } = {}) => registry.createResource({
      resourceId: mailDomainId,
      name: domainName,
      webDomainId,
      managementMode,
    }),
    recordObservation: registry.recordObservation,
    transitionLocalStatus: registry.transitionLocalStatus,
    deleteMailDomain: registry.deleteResource,
    getMailDomain: registry.getResource,
    listMailDomains: registry.listResources,
  });
}
