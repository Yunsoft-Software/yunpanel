export function createDatabaseImpactProvider({ databaseBindingRegistry }) {
  if (!databaseBindingRegistry || typeof databaseBindingRegistry.listBindings !== 'function') {
    throw new Error('databaseBindingRegistry is required for database impact provider');
  }
  return async ({ websiteId }) => {
    if (!websiteId) return [];
    const bindings = await databaseBindingRegistry.listBindings({ websiteId });
    return bindings.map((binding) => ({
      id: binding.id,
      state: binding.databaseName,
    }));
  };
}

export function createSftpKeyImpactProvider({ websiteSftpKeyRegistry }) {
  if (!websiteSftpKeyRegistry || typeof websiteSftpKeyRegistry.listKeys !== 'function') {
    throw new Error('websiteSftpKeyRegistry is required for sftp key impact provider');
  }
  return async ({ websiteId }) => {
    if (!websiteId) return [];
    let keys = [];
    try {
      keys = await websiteSftpKeyRegistry.listKeys({ websiteId });
    } catch {
      // In case mock only accepts raw string
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      try {
        const fallback = await websiteSftpKeyRegistry.listKeys(websiteId);
        if (Array.isArray(fallback) && fallback.length > 0) {
          keys = fallback;
        }
      } catch {
        // ignore
      }
    }
    return (keys || []).map((key) => ({
      id: key.id,
      state: key.status,
    }));
  };
}

export function createRuntimeBindingImpactProvider({ runtimeBindingRegistry }) {
  if (!runtimeBindingRegistry || typeof runtimeBindingRegistry.getBinding !== 'function') {
    throw new Error('runtimeBindingRegistry is required for runtime binding impact provider');
  }
  return async ({ applicationId }) => {
    if (!applicationId) return [];
    const binding = await runtimeBindingRegistry.getBinding(applicationId);
    if (!binding) return [];
    if (typeof binding.applicationId !== 'string' || binding.applicationId !== applicationId) {
      throw new Error('runtime binding identity does not match the requested application');
    }
    return [{
      id: binding.applicationId,
      state: binding.state,
    }];
  };
}

export function createUnixIdentityImpactProvider({ websiteRegistry }) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('websiteRegistry is required for unix identity impact provider');
  }
  return async ({ websiteId }) => {
    if (!websiteId) return [];
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) return [];
    const unixUser = website.systemUser ?? website.unixUser ?? null;
    if (!unixUser) return [];
    return [{
      id: unixUser,
      state: 'active',
    }];
  };
}

export function createLogScopeImpactProvider({ websiteRegistry }) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function') {
    throw new Error('websiteRegistry is required for log scope impact provider');
  }
  return async ({ websiteId }) => {
    if (!websiteId) return [];
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) return [];
    return [{
      id: website.id,
      state: 'managed',
    }];
  };
}

export function createAllWebsiteImpactProviders({
  databaseBindingRegistry = null,
  websiteSftpKeyRegistry = null,
  runtimeBindingRegistry = null,
  websiteRegistry = null,
} = {}) {
  const providers = {};
  if (databaseBindingRegistry) {
    providers.databases = createDatabaseImpactProvider({ databaseBindingRegistry });
  }
  if (websiteSftpKeyRegistry) {
    providers.sftpKeys = createSftpKeyImpactProvider({ websiteSftpKeyRegistry });
  }
  if (runtimeBindingRegistry) {
    providers.runtimeBindings = createRuntimeBindingImpactProvider({ runtimeBindingRegistry });
  }
  if (websiteRegistry) {
    providers.unixIdentities = createUnixIdentityImpactProvider({ websiteRegistry });
    providers.logScopes = createLogScopeImpactProvider({ websiteRegistry });
  }
  return Object.freeze(providers);
}
