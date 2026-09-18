const CATEGORY_LABELS = Object.freeze({
  web: 'Web sunucusu',
  database: 'Veritabanı',
  containers: 'Container',
  scheduler: 'Zamanlayıcı',
  mail: 'Mail',
  database_tool: 'Veritabanı aracı',
  file_tool: 'Dosya yöneticisi',
});

const CONFLICTS = Object.freeze({
  mysql: 'mariadb',
  mariadb: 'mysql',
});

export function managedServiceCategoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category ?? 'Servis';
}

export function managedServiceConflict(service, services = []) {
  const conflictId = CONFLICTS[service?.id];
  if (!conflictId || service?.installed) return null;
  const conflict = services.find((candidate) => candidate?.id === conflictId && candidate.installed === true);
  return conflict ? `${conflict.label ?? conflict.id} kurulu olduğu için birlikte kurulamaz.` : null;
}

export function managedServiceActions(service, services = []) {
  const installed = service?.installed === true;
  const active = service?.active === true;
  const controllable = !Array.isArray(service?.units) || service.units.length > 0;
  const conflict = managedServiceConflict(service, services);
  return Object.freeze({
    install: !installed && !conflict,
    start: controllable && installed && !active,
    stop: controllable && installed && active,
    restart: controllable && installed,
    conflict,
  });
}

export function managedServiceStatus(service) {
  if (!service || service.installed !== true) return Object.freeze({ state: 'unknown', label: 'Kurulu değil' });
  if (Array.isArray(service.units) && service.units.length === 0) {
    if (service.health?.configuration === 'invalid') {
      return Object.freeze({ state: 'warning', label: 'Yapılandırma hatalı' });
    }
    return Object.freeze({ state: 'active', label: 'Kurulu' });
  }
  if (service.active === true) return Object.freeze({ state: 'active', label: 'Çalışıyor' });
  const inspectionFailed = Array.isArray(service.units) && service.units.some((unit) => unit?.inspectionError === true);
  if (inspectionFailed) return Object.freeze({ state: 'warning', label: 'Durum doğrulanamadı' });
  return Object.freeze({ state: 'off', label: 'Durduruldu' });
}

export function managedServiceVersion(service) {
  if (!Array.isArray(service?.packages)) return null;
  const versions = service.packages.map((entry) => entry?.version).filter(Boolean);
  return versions.length > 0 ? versions.join(', ') : null;
}
