import { normalizeNginxSettings } from '@yunpanel/shared';

// Optional settings the PHP/Passenger projection carries over when present. A
// field missing here is silently dropped from the rendered site, so every new
// optional nginx setting must be listed (tests: domain-nginx-*.test.js).
const OPTIONAL_FIELDS = Object.freeze({
  passenger: ['preferredDomain', 'redirectRules', 'gzip', 'protectedPaths'],
  php: ['preferredDomain', 'redirectRules', 'gzip', 'protectedPaths', 'indexFiles', 'errorPages', 'documentRoot', 'staticAssetCacheSeconds'],
});

// Only trusted Domain state is projected when an existing Website resolves to
// PHP/Passenger. Request payload validation remains strict in the protocol.
export function domainNginxSettingsForTarget(domain, targetType) {
  if (!['passenger', 'php'].includes(targetType)) return domain.nginxSettings;
  const settings = domain.nginxSettings ?? {};
  return normalizeNginxSettings(targetType, {
    clientMaxBodySizeMb: settings.clientMaxBodySizeMb ?? null,
    headers: settings.headers ?? [],
    ...Object.fromEntries(OPTIONAL_FIELDS[targetType]
      .filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]])),
  });
}
