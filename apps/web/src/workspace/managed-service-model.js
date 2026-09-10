const CATEGORY_LABELS = Object.freeze({
  web: 'Web sunucusu',
  database: 'Veritabanı',
  containers: 'Container',
  scheduler: 'Zamanlayıcı',
  mail: 'Mail',
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
  const conflict = managedServiceConflict(service, services);
  return Object.freeze({
    install: !installed && !conflict,
    start: installed && !active,
    stop: installed && active,
    restart: installed,
    conflict,
  });
}

export function managedServiceStatus(service) {
  if (!service || service.installed !== true) return Object.freeze({ state: 'unknown', label: 'Kurulu değil' });
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
