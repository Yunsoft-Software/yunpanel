import { useCallback, useEffect, useRef, useState } from 'react';
import { WEBSITE_PREFERENCES_KEY, normalizeWebsitePreferences, readWebsitePreferences, saveWebsitePreferences } from './website-preferences.js';

function storage() {
  try { return window.localStorage; } catch { return null; }
}

// Only browser-wide density/page-size values are stored. No account, domain,
// application identifiers, queries, credentials or API data are persisted.
export function useWebsitePreferences() {
  const [preferences, setPreferences] = useState(() => readWebsitePreferences(storage()));
  const [saved, setSaved] = useState(true);
  const current = useRef(preferences);
  const change = useCallback((patch) => {
    const next = normalizeWebsitePreferences({ ...current.current, ...patch, version: 1 });
    current.current = next;
    setPreferences(next);
    setSaved(saveWebsitePreferences(storage(), next));
  }, []);
  useEffect(() => {
    const receive = (event) => {
      const local = storage();
      if (!local || event.storageArea !== local || (event.key !== null && event.key !== WEBSITE_PREFERENCES_KEY)) return;
      const next = readWebsitePreferences(local);
      current.current = next; setPreferences(next);
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, []);
  return { preferences, change, saved };
}
