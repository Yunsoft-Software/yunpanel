import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 100_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EXCLUDED_NAMES = new Set(['.git']);
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;

function safeEntryName(name) {
  return name !== '.'
    && name !== '..'
    && !/[\u0000-\u001f\u007f]/.test(name)
    && !name.includes('/')
    && !name.includes('\\');
}

function normalizeHealthFile(value = 'index.html') {
  if (typeof value !== 'string' || !SAFE_RELATIVE_PATH.test(value) || value.startsWith('/')) {
    throw new Error('Artifact health file is invalid');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Artifact health file is invalid');
  }
  return value;
}

export async function copyStaticArtifact({ sourceDir, targetDir, healthFile = 'index.html' }) {
  const stats = { files: 0, directories: 0, bytes: 0 };

  async function copyDirectory(source, target) {
    await mkdir(target, { recursive: true, mode: 0o755 });
    const entries = await readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      if (!safeEntryName(entry.name)) throw new Error('Artifact contains an unsafe file name');

      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      const info = await lstat(sourcePath);

      if (info.isSymbolicLink()) throw new Error('Artifact symbolic links are not allowed');
      if (info.isDirectory()) {
        stats.directories += 1;
        await copyDirectory(sourcePath, targetPath);
        continue;
      }
      if (!info.isFile()) throw new Error('Artifact contains an unsupported filesystem entry');

      stats.files += 1;
      stats.bytes += info.size;
      if (stats.files > MAX_FILES) throw new Error('Artifact contains too many files');
      if (stats.bytes > MAX_BYTES) throw new Error('Artifact exceeds the maximum size');

      await copyFile(sourcePath, targetPath);
    }
  }

  const sourceInfo = await lstat(sourceDir);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Artifact source must be a real directory');
  await copyDirectory(sourceDir, targetDir);
  if (stats.files < 1) throw new Error('Artifact output is empty');

  const normalizedHealthFile = normalizeHealthFile(healthFile);
  let healthInfo;
  try {
    healthInfo = await lstat(path.join(targetDir, normalizedHealthFile));
  } catch {
    throw new Error('Artifact health file is missing');
  }
  if (!healthInfo.isFile() || healthInfo.isSymbolicLink() || healthInfo.size < 1) {
    throw new Error('Artifact health file is invalid');
  }

  return { ...stats, healthFile: normalizedHealthFile };
}

async function main() {
  const [sourceDir, targetDir, healthFile] = process.argv.slice(2);
  if (!sourceDir || !targetDir) throw new Error('sourceDir and targetDir are required');
  const result = await copyStaticArtifact({ sourceDir, targetDir, healthFile: healthFile ?? 'index.html' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
