import { useEffect, useLayoutEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, normalizePreferences, readPreferences, resolveTheme, writePreferences } from './ux-model.js';

function readStored() {
  try { return readPreferences(window.localStorage); } catch { return { ...DEFAULT_PREFERENCES }; }
}
function apply(value) {
  const root = document.documentElement;
  root.dataset.wsTheme = resolveTheme(value.theme, window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.wsDensity = value.density;
}
// Loaded with the workspace module, before React paints the workspace. No inline
// script, remote font, auth change, or sensitive data in browser storage.
if (typeof window !== 'undefined') apply(readStored());

export default function Preferences() {
  const [value, setValue] = useState(readStored);
  const [persisted, setPersisted] = useState(true);
  useLayoutEffect(() => { apply(value); }, [value]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const systemChanged = () => { if (value.theme === 'system') apply(value); };
    media.addEventListener('change', systemChanged);
    return () => media.removeEventListener('change', systemChanged);
  }, [value]);
  useEffect(() => {
    const changed = (event) => { if (event.key === PREFERENCE_KEY || event.key === null) { setValue(readStored()); setPersisted(true); } };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function change(key, next) {
    const updated = normalizePreferences({ ...value, [key]: next });
    setValue(updated);
    try { setPersisted(writePreferences(window.localStorage, updated)); } catch { setPersisted(false); }
  }
  return <fieldset className="ws-preferences"><legend>Görünüm</legend>
    <label htmlFor="ws-theme-preference">Tema<select id="ws-theme-preference" value={value.theme} onChange={(event) => change('theme', event.target.value)}><option value="system">Sistem</option><option value="light">Açık</option><option value="dark">Koyu</option></select></label>
    <label htmlFor="ws-density-preference">Yoğunluk<select id="ws-density-preference" value={value.density} onChange={(event) => change('density', event.target.value)}><option value="comfortable">Rahat</option><option value="compact">Kompakt</option></select></label>
    {!persisted && <p role="status">Tercih bu oturumda uygulandı; tarayıcı kalıcı kayda izin vermiyor.</p>}
  </fieldset>;
}
