import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const filePath = fileURLToPath(url);
    const source = await fs.readFile(filePath, 'utf8');
    const { code } = await transformWithOxc(source, filePath, {
      jsx: { runtime: 'automatic' },
    });
    return {
      format: 'module',
      shortCircuit: true,
      source: code,
    };
  }
  return nextLoad(url, context);
}
