import { useEffect, useLayoutEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, PREFERENCE_KEY, normalizePreferences, readPreferences, resolveTheme, writePreferences } from './ux-model.js';

export const FIRST_VISIT_PREFERENCES = Object.freeze({ ...DEFAULT_PREFERENCES, theme: 'dark' });
export function readStored(storage) {
  try {
    // Respect explicit light/system/dark choices, including preferences saved by
    // the previous UI. Only a new visitor receives the approved midnight theme.
    const s = arguments.length > 0 ? storage : (typeof window !== 'undefined' ? window.localStorage : null);
    if (!s) return { ...FIRST_VISIT_PREFERENCES };
    return s.getItem(PREFERENCE_KEY) === null ? { ...FIRST_VISIT_PREFERENCES } : readPreferences(s);
  } catch { return { ...FIRST_VISIT_PREFERENCES }; }
}
export function apply(value) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  const darkMatch = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    ? Boolean(window.matchMedia('(prefers-color-scheme: dark)').matches)
    : false;
  root.dataset.wsTheme = resolveTheme(value.theme, darkMatch);
  root.dataset.wsDensity = value.density;
}
// Apply before the workspace paints. No remote font, auth change or secrets in storage.
if (typeof window !== 'undefined') apply(readStored());

export default function Preferences() {
  const [value, setValue] = useState(readStored);
  const [persisted, setPersisted] = useState(true);
  useLayoutEffect(() => { apply(value); }, [value]);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const systemChanged = () => { if (value.theme === 'system') apply(value); };
    media.addEventListener?.('change', systemChanged);
    return () => media.removeEventListener?.('change', systemChanged);
  }, [value]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const changed = (event) => {
      if (event.key === PREFERENCE_KEY || event.key === null) {
        let nextValue;
        if (event.key === null || event.newValue === null) {
          nextValue = { ...FIRST_VISIT_PREFERENCES };
        } else if (typeof event.newValue === 'string') {
          try {
            nextValue = normalizePreferences(JSON.parse(event.newValue));
          } catch {
            nextValue = readStored();
          }
        } else {
          nextValue = readStored();
        }
        setValue(nextValue);
        setPersisted(true);
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  function change(key, next) {
    const updated = normalizePreferences({ ...value, [key]: next });
    setValue(updated);
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : null;
      if (!storage) {
        setPersisted(false);
      } else {
        setPersisted(Boolean(writePreferences(storage, updated)));
      }
    } catch {
      setPersisted(false);
    }
  }
  return <fieldset className="ws-preferences"><legend>Görünüm</legend>
    <label htmlFor="ws-theme-preference">Tema<select id="ws-theme-preference" value={value.theme} onChange={(event) => change('theme', event.target.value)}><option value="dark">Gece</option><option value="light">Açık</option><option value="system">Sistem</option></select></label>
    <label htmlFor="ws-density-preference">Yoğunluk<select id="ws-density-preference" value={value.density} onChange={(event) => change('density', event.target.value)}><option value="comfortable">Rahat</option><option value="compact">Kompakt</option></select></label>
    {!persisted && <p role="status">Tercih bu oturumda uygulandı; tarayıcı kalıcı kayda izin vermiyor.</p>}
  </fieldset>;
}
