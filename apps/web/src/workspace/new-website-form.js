const EXISTING_APPLICATION_TYPES = Object.freeze({
  existing_node: 'node',
  existing_static: 'static',
});

function requiredText(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

export function existingApplicationType(sourceMode) {
  return EXISTING_APPLICATION_TYPES[sourceMode] ?? null;
}

export function availableExistingApplications({ applications = [], websites = [], serverId, sourceMode } = {}) {
  const type = existingApplicationType(sourceMode);
  if (!type || typeof serverId !== 'string' || !serverId) return [];
  const boundApplicationIds = new Set(websites.map((website) => website.applicationId).filter(Boolean));
  return applications.filter((application) => application.serverId === serverId
    && application.type === type
    && !boundApplicationIds.has(application.id));
}

function applicationForWebsite(website, applications) {
  if (!website?.applicationId) return null;
  return applications.find((application) => application.id === website.applicationId
    && application.serverId === website.serverId) ?? null;
}

export function sharedWebsiteTarget(website, applications = []) {
  if (!website || typeof website !== 'object') return null;
  const application = applicationForWebsite(website, applications);
  if (website.runtimeType === 'static' && application?.type === 'static'
    && website.documentRoot === application.webRoot) {
    return { targetType: 'static', target: { root: website.documentRoot, spaFallback: true } };
  }
  if (website.runtimeType === 'php' && application?.type === 'php') {
    return { targetType: 'php', target: { applicationId: application.id } };
  }
  if (website.runtimeType === 'node' && application?.type === 'node'
    && application.runtimeAdapter === 'passenger') {
    return { targetType: 'passenger', target: { applicationId: application.id } };
  }
  if (['docker', 'proxy'].includes(website.runtimeType) && website.proxyTarget) {
    const { host, port, websocket } = website.proxyTarget;
    if (typeof host === 'string' && Number.isInteger(port) && typeof websocket === 'boolean') {
      return { targetType: 'proxy', target: { upstreamHost: host, upstreamPort: port, websocket } };
    }
  }
  return null;
}

export function availableSharedWebsites({ websites = [], applications = [], serverId } = {}) {
  if (typeof serverId !== 'string' || !serverId) return [];
  return websites.filter((website) => website.serverId === serverId
    && sharedWebsiteTarget(website, applications) !== null);
}

export function sharedWebsiteConfirmation(primaryDomain, websiteId) {
  return `share-site:${requiredText(primaryDomain, 'Alan adı gereklidir.')}:${requiredText(websiteId, 'Website kimliği gereklidir.')}`;
}

export function sharedDomainCreateInput({ domain, website, applications = [], wwwMode = 'none' } = {}) {
  if (!domain || !website || domain.serverId !== website.serverId) {
    throw new Error('Paylaşılacak Website bu alan adıyla aynı yerel sunucuda olmalıdır.');
  }
  const routing = sharedWebsiteTarget(website, applications);
  if (!routing) throw new Error('Seçilen Website güvenli shared-site routing için uygun değil.');
  if (domain.parentDomainId === null && wwwMode === 'alias' && domain.primaryDomain.startsWith('www.')) {
    throw new Error('www ile başlayan alan adı için ayrıca www alias oluşturulamaz.');
  }
  const aliases = domain.parentDomainId === null && wwwMode === 'alias'
    ? [`www.${domain.primaryDomain}`]
    : [];
  return {
    serverId: domain.serverId,
    websiteId: website.id,
    primaryDomain: domain.primaryDomain,
    parentDomainId: domain.parentDomainId,
    aliases,
    targetType: routing.targetType,
    target: routing.target,
    httpsMode: domain.httpsMode,
  };
}

function sourceFromForm(form, selectedApplication) {
  if (form.sourceMode === 'new_node') {
    return {
      kind: 'new_node',
      repositoryUrl: requiredText(form.repositoryUrl, 'GitHub repository adresini girin.'),
      branch: requiredText(form.branch, 'Git branch bilgisini girin.'),
      retention: 5,
      runtime: {
        nodeMajor: 24,
        installMode: 'ci',
        buildScript: null,
        startMode: 'node',
        entryFile: requiredText(form.entryFile, 'Node.js başlangıç dosyasını girin.'),
        healthPath: requiredText(form.healthPath, 'Sağlık kontrolü yolunu girin.'),
        healthTimeoutSeconds: 30,
        restartPolicy: 'on-failure',
      },
    };
  }
  if (form.sourceMode === 'new_static') {
    return {
      kind: 'new_static',
      repositoryUrl: requiredText(form.repositoryUrl, 'GitHub repository adresini girin.'),
      branch: requiredText(form.branch, 'Git branch bilgisini girin.'),
      retention: 5,
      build: {
        mode: 'npm',
        installMode: 'ci',
        buildScript: 'build',
        outputDir: requiredText(form.outputDir, 'Statik build çıktı klasörünü girin.'),
        healthFile: 'index.html',
      },
    };
  }
  if (form.sourceMode === 'new_php') return { kind: 'new_php' };
  if (existingApplicationType(form.sourceMode)) {
    if (!selectedApplication || selectedApplication.type !== existingApplicationType(form.sourceMode)) {
      throw new Error('Bu Website için kullanılmamış uygun uygulamayı seçin.');
    }
    return { kind: 'existing_application', applicationId: selectedApplication.id };
  }
  if (form.sourceMode === 'external_proxy') {
    const port = Number(form.targetValue);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Yerel proxy portu 1024–65535 aralığında olmalıdır.');
    }
    return { kind: 'external_proxy', target: { host: '127.0.0.1', port, websocket: true } };
  }
  throw new Error('Website yayın kaynağı geçersiz.');
}

export function siteCreateInputFromForm({ form, operationId, serverId, domain, selectedApplication = null } = {}) {
  if (!form || !domain) throw new Error('Website formu tamamlanmadı.');
  const isSubdomain = domain.parentDomainId !== null;
  if (!isSubdomain && form.wwwMode === 'independent') {
    throw new Error('Bağımsız www, üst alan adı seçilmiş ayrı bir Website olarak oluşturulmalıdır.');
  }
  const source = sourceFromForm(form, selectedApplication);
  if (form.initialDatabase === true && ![
    'existing_application', 'new_static', 'new_node', 'new_php',
  ].includes(source.kind)) {
    throw new Error('Başlangıç veritabanı yalnız yönetilen Application Website için oluşturulabilir.');
  }
  const mailMode = isSubdomain ? 'none' : (form.mailMode || 'local');
  return {
    operationId,
    serverId,
    name: domain.primaryDomain,
    primaryDomain: domain.primaryDomain,
    parentDomainId: domain.parentDomainId,
    wwwMode: isSubdomain ? 'none' : form.wwwMode,
    httpsMode: form.httpsMode,
    source,
    database: { mode: form.initialDatabase === true ? 'create' : 'none' },
    mail: { mode: mailMode },
  };
}


export const newWebsiteFormInternals = Object.freeze({ applicationForWebsite, sourceFromForm });
