import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// Live feature tests go through the panel. Writing its stores directly leaves state the API
// refuses at startup: the sqlite3 CLI runs with foreign keys off and registries are cached.
const liveTestWriteRules = [
  [/sqlite3[^\n]*\b(DELETE FROM|INSERT( OR [A-Z]+)? INTO|UPDATE \w+ SET|REPLACE INTO|DROP TABLE|ALTER TABLE)\b/i, 'writes a panel database with sqlite3'],
  [/systemctl\s+(restart|stop)\s+yunpanel-/, 'restarts a panel service'],
  // Deleting what the panel provisioned leaves records the removal flow treats as drift, so it refuses to finish.
  [/runSsh\([^)\n]*\b(userdel|groupdel)\b/, 'deletes a Unix user behind the panel'],
  [/runSsh\([^)\n]*\brm\s+-[a-z]+\s+[^)\n]*(\/etc\/(nginx|php|cron\.d)\/|\/var\/lib\/yunpanel\/(homes|reports|staging)\/|\/run\/(php|yunpanel)\/)/, 'deletes panel-managed host files'],
  [/runSsh\([^)\n]*\bdocker\s+(rm\b|volume\s+rm\b|compose\b[^\n]*\bdown\b)/, 'deletes Docker resources behind the panel'],
];
const registryPathPattern = /\/var\/lib\/yunpanel\/control-plane\/[\w./-]+\.json/;
const registryWritePattern = /writeFileSync\(|json\.dump\(|open\([^)]*,\s*['"]w['"]\)/;
const liveTestDirectory = path.join(root, 'e2e', 'ozellik');
for (const entry of await readdir(liveTestDirectory)) {
  if (!entry.endsWith('.spec.js')) continue;
  const source = await readFile(path.join(liveTestDirectory, entry), 'utf8');
  for (const [pattern, problem] of liveTestWriteRules) {
    if (pattern.test(source)) violations.push(`e2e/ozellik/${entry}: ${problem}`);
  }
  if (registryPathPattern.test(source) && registryWritePattern.test(source)) {
    violations.push(`e2e/ozellik/${entry}: edits a panel registry file`);
  }
}

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
