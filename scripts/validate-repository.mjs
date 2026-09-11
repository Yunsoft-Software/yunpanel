import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const violations = [];
const supportedLinuxNativeBindings = new Map([
  ['node_modules/@rolldown/binding-linux-x64-gnu', 'x64'],
  ['node_modules/@rolldown/binding-linux-arm64-gnu', 'arm64'],
  ['node_modules/lightningcss-linux-x64-gnu', 'x64'],
  ['node_modules/lightningcss-linux-arm64-gnu', 'arm64'],
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;

    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');

    if (entry.isDirectory()) {
      if (relativePath === '.github/workflows' || relativePath.startsWith('.github/workflows/')) {
        violations.push(`${relativePath}: GitHub Actions are not allowed`);
        continue;
      }
      await walk(fullPath);
      continue;
    }

    if (/\.(ts|tsx)$/i.test(entry.name)) {
      violations.push(`${relativePath}: TypeScript files are not allowed`);
    }

    if (entry.name === 'package.json') {
      const packageJson = JSON.parse(await readFile(fullPath, 'utf8'));
      const dependencySections = [
        packageJson.dependencies,
        packageJson.devDependencies,
        packageJson.peerDependencies,
        packageJson.optionalDependencies,
      ];

      for (const dependencies of dependencySections) {
        if (dependencies?.typescript) {
          violations.push(`${relativePath}: TypeScript dependency is not allowed`);
        }
      }
    }
  }
}

await walk(root);

const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const [packagePath, cpu] of supportedLinuxNativeBindings) {
  const binding = packageLock.packages?.[packagePath];
  if (!binding || binding.optional !== true || !binding.os?.includes('linux')
    || !binding.cpu?.includes(cpu) || !binding.libc?.includes('glibc')
    || typeof binding.integrity !== 'string' || !binding.integrity.startsWith('sha512-')) {
    violations.push(`package-lock.json: missing complete Ubuntu ${cpu} native binding ${packagePath}`);
  }
}

if (violations.length > 0) {
  console.error('Repository policy validation failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Repository policy validation passed.');
}
