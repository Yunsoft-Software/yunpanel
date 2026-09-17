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
  return {
    operationId,
    serverId,
    name: domain.primaryDomain,
    primaryDomain: domain.primaryDomain,
    parentDomainId: domain.parentDomainId,
    wwwMode: isSubdomain ? 'none' : form.wwwMode,
    httpsMode: form.httpsMode,
    source: sourceFromForm(form, selectedApplication),
  };
}

export const newWebsiteFormInternals = Object.freeze({ sourceFromForm });
