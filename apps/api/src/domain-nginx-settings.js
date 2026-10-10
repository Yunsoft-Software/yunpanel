import { normalizeNginxSettings } from '@yunpanel/shared';

// Only trusted Domain state is projected when an existing Website resolves to
// PHP/Passenger. Request payload validation remains strict in the protocol.
export function domainNginxSettingsForTarget(domain, targetType) {
  if (!['passenger', 'php'].includes(targetType)) return domain.nginxSettings;
  const settings = domain.nginxSettings ?? {};
  return normalizeNginxSettings(targetType, {
    clientMaxBodySizeMb: settings.clientMaxBodySizeMb ?? null,
    headers: settings.headers ?? [],
    ...(targetType === 'php' ? Object.fromEntries(['indexFiles', 'errorPages']
      .filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]])) : {}),
  });
}
