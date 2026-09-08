import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const NGINX_ROOT = '/etc/nginx';
const CONFIG_DIRECTORIES = Object.freeze([
  '/etc/nginx/sites-enabled',
  '/etc/nginx/conf.d',
]);
const MAX_CONFIG_BYTES = 512 * 1024;

function unique(values) {
  return [...new Set(values)];
}

function directiveValues(content, directive) {
  const values = [];
  const pattern = new RegExp(`(^|\\n)\\s*${directive}\\s+([^;]+);`, 'g');
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const value = match[2].replace(/\s+#.*$/, '').trim();
    if (value) values.push(value);
  }
  return values;
}

function sanitizeProxyTarget(value) {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 197)}...`;
  }
}

export function parseNginxConfigMetadata(content) {
  const serverNames = directiveValues(content, 'server_name')
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
  const listens = directiveValues(content, 'listen');
  const roots = directiveValues(content, 'root');
  const proxyTargets = directiveValues(content, 'proxy_pass').map(sanitizeProxyTarget);

  return {
    serverNames: unique(serverNames),
    listens: unique(listens),
    roots: unique(roots),
    proxyTargets: unique(proxyTargets),
  };
}

function isInsideNginxRoot(resolvedPath) {
  const root = path.resolve(NGINX_ROOT);
  const candidate = path.resolve(resolvedPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function createNginxInspector({
  readdirFn = readdir,
  lstatFn = lstat,
  realpathFn = realpath,
  statFn = stat,
  readFileFn = readFile,
} = {}) {
  return async function inspectNginx() {
    const configs = [];
    const issues = [];
    let detectedDirectory = false;

    for (const directory of CONFIG_DIRECTORIES) {
      let names;
      try {
        names = await readdirFn(directory);
        detectedDirectory = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') issues.push({ directory, code: 'directory_unreadable' });
        continue;
      }

      for (const name of names.sort()) {
        if (typeof name !== 'string' || name.startsWith('.') || name.includes('/') || name.includes('\\')) continue;

        const sourcePath = path.join(directory, name);
        try {
          const sourceStats = await lstatFn(sourcePath);
          if (!sourceStats.isFile() && !sourceStats.isSymbolicLink()) continue;

          const resolvedPath = await realpathFn(sourcePath);
          if (!isInsideNginxRoot(resolvedPath)) {
            issues.push({ directory, name, code: 'symlink_outside_nginx_root' });
            continue;
          }

          const resolvedStats = await statFn(resolvedPath);
          if (!resolvedStats.isFile()) continue;
          if (resolvedStats.size > MAX_CONFIG_BYTES) {
            issues.push({ directory, name, code: 'config_too_large' });
            continue;
          }

          const content = await readFileFn(resolvedPath, 'utf8');
          configs.push({
            directory,
            name,
            symlink: sourceStats.isSymbolicLink(),
            ...parseNginxConfigMetadata(content),
          });
        } catch (error) {
          issues.push({ directory, name, code: error?.code === 'EACCES' ? 'permission_denied' : 'config_unreadable' });
        }
      }
    }

    return {
      installed: detectedDirectory,
      configDirectories: CONFIG_DIRECTORIES,
      configs,
      issues,
    };
  };
}

export const inspectNginx = createNginxInspector();
