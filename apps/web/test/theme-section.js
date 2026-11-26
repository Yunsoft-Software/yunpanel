// T956 merged the global style layers into src/workspace/design-system/theme.css. Each former file
// is now a titled section of that stylesheet; tests that checked one layer read the same section.
import { readFile } from 'node:fs/promises';

export const THEME_PATH = new URL('../src/workspace/design-system/theme.css', import.meta.url);

const SECTION_TITLES = {
  styles: 'Base: document, headings, legacy buttons and status dots',
  'server-cards': 'Server status details',
  'domain-list': 'Domain list (legacy owner screens)',
  workspace: 'Workspace shell: sidebar, toolbar, sections, tables, badges',
  'ux-theme': 'Workspace density and preferences',
  'legacy-bridge': 'Legacy auth controls inside the workspace',
  'console-theme': 'Console skin',
  'ember-typography': 'Typography (self-hosted fonts)',
  'design-system': 'Design system: tokens and shared components (Shadcn zinc/slate)',
  'ember-theme': 'Theme overrides, accessibility and reduced motion',
};

export function readTheme() {
  return readFile(THEME_PATH, 'utf8');
}

// Text of one section, from its header comment to the next section header.
export async function themeSection(name) {
  const title = SECTION_TITLES[name];
  if (!title) throw new Error(`Unknown theme section: ${name}`);
  const css = await readTheme();
  const starts = Object.values(SECTION_TITLES).map((t) => css.indexOf(`   ${t}\n`)).filter((i) => i >= 0).sort((a, b) => a - b);
  const start = css.indexOf(`   ${title}\n`);
  if (start < 0) throw new Error(`Theme section not found: ${title}`);
  const next = starts.find((i) => i > start);
  return css.slice(start, next === undefined ? css.length : css.lastIndexOf('/*', next));
}
