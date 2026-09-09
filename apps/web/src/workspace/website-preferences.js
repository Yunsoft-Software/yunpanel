export const WEBSITE_PREFERENCES_KEY = 'yunpanel:websites:view:v1';

export function normalizeWebsitePreferences(value) {
  return {
    version: 1,
    density: value?.version === 1 && value.density === 'compact' ? 'compact' : 'comfortable',
    perPage: value?.version === 1 && [10, 25, 50].includes(value.perPage) ? value.perPage : 10,
  };
}

export function readWebsitePreferences(storage) {
  try { return normalizeWebsitePreferences(JSON.parse(storage.getItem(WEBSITE_PREFERENCES_KEY))); }
  catch { return normalizeWebsitePreferences(null); }
}

export function saveWebsitePreferences(storage, value) {
  try { storage.setItem(WEBSITE_PREFERENCES_KEY, JSON.stringify(normalizeWebsitePreferences(value))); return true; }
  catch { return false; }
}
