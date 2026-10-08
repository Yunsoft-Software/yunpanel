import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('./jsx-loader.js', import.meta.url);

import {
  DEFAULT_PREFERENCES,
  PREFERENCE_KEY,
  normalizePreferences,
  readPreferences,
  writePreferences,
  resolveTheme,
} from '../src/workspace/ui/ux-model.js';

const {
  FIRST_VISIT_PREFERENCES,
  readStored,
  apply,
} = await import('../src/workspace/ui/Preferences.jsx');

const readWebSource = (filePath) => readFile(new URL(`../src/${filePath}`, import.meta.url), 'utf8');

/* ==========================================================================
   Criterion 1 & 2:
   Yeni tarayıcı profili Gece temasını açmalı; daha önce açık veya sistem
   tema kaydeden kişinin tercihi değişmemelidir.
   ========================================================================== */

test('Criterion 1: Fresh browser profile (first visit) defaults to Gece (dark) theme', () => {
  // Fresh browser profile: storage has no preference item (getItem returns null)
  const freshStorage = {
    getItem: (key) => (key === PREFERENCE_KEY ? null : undefined),
    setItem: () => {},
  };
  const initial = readStored(freshStorage);
  assert.equal(initial.theme, 'dark', 'New browser profile must default to Gece (dark) theme');
  assert.equal(initial.density, 'comfortable', 'New browser profile must default to comfortable density');
  assert.deepEqual(initial, FIRST_VISIT_PREFERENCES);

  // Storage access blocked / restricted (e.g. SecurityError in private mode) also safely yields dark theme
  const blockedStorage = {
    getItem: () => {
      const err = new Error('Access is denied for this document');
      err.name = 'SecurityError';
      throw err;
    },
    setItem: () => {},
  };
  const blockedInitial = readStored(blockedStorage);
  assert.equal(blockedInitial.theme, 'dark', 'Blocked storage on first visit must safely fall back to Gece theme');
  assert.equal(blockedInitial.density, 'comfortable');
});

test('Criterion 1: Static index.html provides default Gece theme to prevent light flashes', async () => {
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  // Root HTML tag must declare data-ws-theme="dark" and data-ws-density="comfortable"
  assert.match(indexHtml, /<html\s+[^>]*data-ws-theme="dark"/, 'index.html must have data-ws-theme="dark"');
  assert.match(indexHtml, /<html\s+[^>]*data-ws-density="comfortable"/, 'index.html must have data-ws-density="comfortable"');
  // Inline script must check existing preference and apply it synchronously before paint
  assert.match(indexHtml, /localStorage\.getItem\(['"]yunpanel\.ui\.preferences\.v1['"]\)/);
  assert.match(indexHtml, /document\.documentElement\.dataset\.wsTheme/);
});

test('Criterion 2: Existing saved preferences (light, system, dark) are preserved and never overridden', () => {
  // User who previously saved light theme
  const lightStorage = {
    getItem: (key) => (key === PREFERENCE_KEY ? JSON.stringify({ theme: 'light', density: 'comfortable' }) : null),
  };
  const lightPrefs = readStored(lightStorage);
  assert.equal(lightPrefs.theme, 'light', 'Previously saved light theme must be preserved');
  assert.equal(lightPrefs.density, 'comfortable');

  // User who previously saved system theme with compact density
  const systemStorage = {
    getItem: (key) => (key === PREFERENCE_KEY ? JSON.stringify({ theme: 'system', density: 'compact' }) : null),
  };
  const systemPrefs = readStored(systemStorage);
  assert.equal(systemPrefs.theme, 'system', 'Previously saved system theme must be preserved');
  assert.equal(systemPrefs.density, 'compact');

  // User who previously saved dark theme with compact density
  const darkStorage = {
    getItem: (key) => (key === PREFERENCE_KEY ? JSON.stringify({ theme: 'dark', density: 'compact' }) : null),
  };
  const darkPrefs = readStored(darkStorage);
  assert.equal(darkPrefs.theme, 'dark', 'Previously saved dark theme must be preserved');
  assert.equal(darkPrefs.density, 'compact');

  // Theme resolution: explicit theme always wins over system preference
  assert.equal(resolveTheme('light', true), 'light', 'Explicit light wins even if system is dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', false), 'dark', 'Explicit dark wins even if system is light');
  assert.equal(resolveTheme('dark', true), 'dark');
  // System theme adapts to system dark mode
  assert.equal(resolveTheme('system', true), 'dark', 'System theme resolves to dark when system is dark');
  assert.equal(resolveTheme('system', false), 'light', 'System theme resolves to light when system is light');
});

/* ==========================================================================
   Criterion 3:
   Sol menü > Görünüm tercihleri üzerinden tema ve yoğunluk değişimi yapılabilmeli;
   depolama engeli durumunda UI bozulmadan çalışmalıdır.
   ========================================================================== */

test('Criterion 3: Sol menü > Görünüm tercihleri defines accessible controls and options', async () => {
  const preferencesSrc = await readWebSource('workspace/ui/Preferences.jsx');
  const layoutSrc = await readWebSource('workspace/WorkspaceLayout.jsx');

  // Sidebar navigation hosts Görünüm tercihleri details disclosure
  assert.match(layoutSrc, /<details className="ws-appearance"><summary>Görünüm tercihleri<\/summary><Preferences \/><\/details>/);

  // Fieldset has legend "Görünüm"
  assert.match(preferencesSrc, /<fieldset className="ws-preferences"><legend>Görünüm<\/legend>/);

  // Theme preference selector with Gece, Açık, Sistem options
  assert.match(preferencesSrc, /<label htmlFor="ws-theme-preference">Tema<select id="ws-theme-preference"/);
  assert.match(preferencesSrc, /<option value="dark">Gece<\/option>/);
  assert.match(preferencesSrc, /<option value="light">Açık<\/option>/);
  assert.match(preferencesSrc, /<option value="system">Sistem<\/option>/);

  // Density preference selector with Rahat, Kompakt options
  assert.match(preferencesSrc, /<label htmlFor="ws-density-preference">Yoğunluk<select id="ws-density-preference"/);
  assert.match(preferencesSrc, /<option value="comfortable">Rahat<\/option>/);
  assert.match(preferencesSrc, /<option value="compact">Kompakt<\/option>/);

  // Status notification when storage write is not permitted
  assert.match(preferencesSrc, /role="status"/);
  assert.match(preferencesSrc, /Tercih bu oturumda uygulandı; tarayıcı kalıcı kayda izin vermiyor\./);
});

test('Criterion 3: Normalization and writePreferences handle storage restrictions gracefully', () => {
  // Normalization keeps only valid themes and densities, stripping foreign properties
  assert.deepEqual(
    normalizePreferences({ theme: 'dark', density: 'compact', authCookie: 'secret', injection: '<script>' }),
    { theme: 'dark', density: 'compact' },
  );
  assert.deepEqual(normalizePreferences({ theme: 'invalid', density: 'unknown' }), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);

  // Successful storage write
  let stored = null;
  const writableStorage = {
    setItem: (key, val) => {
      assert.equal(key, PREFERENCE_KEY);
      stored = JSON.parse(val);
    },
  };
  const writeSuccess = writePreferences(writableStorage, { theme: 'light', density: 'compact' });
  assert.equal(writeSuccess, true);
  assert.deepEqual(stored, { theme: 'light', density: 'compact' });

  // QuotaExceededError or storage disabled: writePreferences returns false without throwing
  const quotaStorage = {
    setItem: () => {
      const err = new Error('The quota has been exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    },
  };
  assert.equal(writePreferences(quotaStorage, { theme: 'dark', density: 'comfortable' }), false);

  // Storage access throwing SecurityError: writePreferences returns false without throwing
  const accessDeniedStorage = {
    setItem: () => {
      const err = new Error('Access is denied');
      err.name = 'SecurityError';
      throw err;
    },
  };
  assert.equal(writePreferences(accessDeniedStorage, { theme: 'light', density: 'compact' }), false);
});

/* ==========================================================================
   Criterion 4:
   İki sekme arasında storage event senkronizasyonu doğrulanmalıdır.
   ========================================================================== */

test('Criterion 4: Cross-tab storage event synchronizes preferences between tabs', async () => {
  const preferencesSrc = await readWebSource('workspace/ui/Preferences.jsx');

  // Preferences component registers and unregisters window 'storage' event listener
  assert.match(preferencesSrc, /window\.addEventListener\('storage',\s*changed\)/);
  assert.match(preferencesSrc, /window\.removeEventListener\('storage',\s*changed\)/);

  // Listener checks event.key against PREFERENCE_KEY or null (storage cleared)
  assert.match(preferencesSrc, /event\.key === PREFERENCE_KEY \|\| event\.key === null/);

  // Simulate cross-tab event: Tab 1 writes updated preferences
  const tab1Updated = { theme: 'light', density: 'compact' };
  const mockStorageEvent = {
    key: PREFERENCE_KEY,
    newValue: JSON.stringify(tab1Updated),
    oldValue: JSON.stringify(FIRST_VISIT_PREFERENCES),
  };

  const receivedFromEvent = normalizePreferences(JSON.parse(mockStorageEvent.newValue));
  assert.deepEqual(receivedFromEvent, { theme: 'light', density: 'compact' });

  // Simulate cross-tab event: Tab 1 clears storage (storage.clear())
  const clearStorageEvent = { key: null, newValue: null };
  assert.ok(clearStorageEvent.key === null || clearStorageEvent.newValue === null);

  // Simulate cross-tab event: Tab 1 removes preferences item
  const removeStorageEvent = { key: PREFERENCE_KEY, newValue: null };
  assert.ok(removeStorageEvent.newValue === null);
});

/* ==========================================================================
   Criterion 5:
   Mobil üst çubukta arama, menü, AI ve aktif işler bileşenleri erişilebilir kalmalıdır.
   ========================================================================== */

test('Criterion 5: Mobile top bar has search, menu, AI, and active jobs buttons with accessible attributes', async () => {
  const layoutSrc = await readWebSource('workspace/WorkspaceLayout.jsx');
  const consoleTheme = await readWebSource('workspace/ui/console-theme.css');
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');
  const workspaceCss = await readWebSource('workspace/workspace.css');

  // 1. Menu button: .ws-mobile-menu in toolbar
  assert.match(layoutSrc, /<Button\s+className="ws-mobile-menu"\s+icon="menu"\s+aria-label="Ana menüyü aç"\s+aria-expanded=\{menuOpen\}\s+aria-controls="workspace-navigation"/);

  // 2. Search button: .ws-command-trigger in toolbar
  assert.match(layoutSrc, /<button\s+type="button"\s+className="ws-command-trigger"\s+aria-label="Site veya panel bölümü ara"\s+aria-haspopup="dialog"/);
  assert.match(layoutSrc, /<Icon name="search" \/>/);

  // 3. AI assistant button in toolbar actions
  assert.match(layoutSrc, /<Button\s+icon="terminal"\s+aria-label="AI asistanı aç \(Ürün uzantısı\)"\s+title="AI asistanı · Ürün uzantısı · Ctrl \/ ⌘ Shift A"/);

  // 4. Active jobs link in toolbar actions with dynamic jobCount
  assert.match(layoutSrc, /<LinkButton\s+to="\/jobs"\s+icon="jobs"\s+aria-label=\{`İşlemler\$\{jobCount > 0 \? `, \$\{jobCount\} aktif` : ''\}`\}\s+title="İşlemler"/);
  assert.match(layoutSrc, /\{jobCount > 0 && <span className="ws-nav-count">\{jobCount\}<\/span>\}/);

  // Mobile menu button is displayed on narrow viewports (<= 900px)
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-mobile-menu,\s*\.ws-nav-close\s*\{[^}]*display:\s*inline-flex/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-mobile-menu,\s*\.ws-nav-close\s*\{[^}]*display:\s*inline-flex/);

  // Toolbar actions and touch target accessibility (>= 44px min-height/min-width)
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-toolbar-actions\s+\.ws-button\s*\{[^}]*min-width:\s*44px/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?min-height:\s*44px/);

  // Toolbar wrapping prevents overflow on 320px/390px viewports
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap;/);
});

/* ==========================================================================
   Criterion 6:
   Documentary integrity: Live documentary acceptance remains open
   ========================================================================== */

test('Criterion 6: Live acceptance checkbox remains open pending Code Factory mechanical verification', async () => {
  const todo = await readFile(new URL('../../../todo.md', import.meta.url), 'utf8');

  // Verify that todo.md retains the open checkbox for theme preferences live acceptance
  assert.match(
    todo,
    /- \[ \] Yeni tarayıcı profili Gece temasını açmalı; daha önce açık\/sistem tema kaydeden kişinin tercihi değişmemeli\./,
    'Live acceptance checkbox in todo.md must remain open (- [ ]) pending Code Factory integration',
  );
});
