import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RCLONE_PATHS = Object.freeze(['/usr/bin/rclone', '/usr/local/bin/rclone', '/bin/rclone']);
const REMOTE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds for probe/test

export class RcloneError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RcloneError';
    this.code = code;
    this.status = status;
  }
}

function normalizeRemoteName(name) {
  if (typeof name !== 'string' || !REMOTE_NAME_PATTERN.test(name)) {
    throw new RcloneError('rclone_remote_name_invalid', 'Remote name must be 1-64 alphanumeric characters, underscores, or hyphens');
  }
  return name;
}

async function findRcloneBinary(customPath, accessFn) {
  if (customPath) {
    try {
      await accessFn(customPath);
      return customPath;
    } catch {
      return null;
    }
  }
  for (const candidate of RCLONE_PATHS) {
    try {
      await accessFn(candidate);
      return candidate;
    } catch {
      // Continue search in fixed allowlist.
    }
  }
  return null;
}

function mapRcloneError(error, context = '') {
  if (error instanceof RcloneError) return error;
  const stderr = (error?.stderr || '').toString();
  const stdout = (error?.stdout || '').toString();
  const raw = `${stderr}\n${stdout}`.trim() || error?.message || '';
  const lower = raw.toLowerCase();

  if (lower.includes('authentication failed') || lower.includes('access denied') || lower.includes('invalid credentials') || lower.includes('bad credentials') || lower.includes('403 forbidden') || lower.includes('401 unauthorized')) {
    return new RcloneError('rclone_remote_auth_failed', `Remote authentication failed: ${stderr.trim() || raw}`, 401);
  }
  if (lower.includes('directory not found') || lower.includes('bucket not found') || lower.includes('not found')) {
    return new RcloneError('rclone_remote_target_not_found', `Remote target not found: ${stderr.trim() || raw}`, 404);
  }
  if (lower.includes('connection refused') || lower.includes('no such host') || lower.includes('i/o timeout') || lower.includes('dial tcp') || lower.includes('failed to make remote')) {
    return new RcloneError('rclone_remote_unreachable', `Remote is unreachable: ${stderr.trim() || raw}`, 502);
  }
  return new RcloneError('rclone_command_failed', `Rclone command failed (${context}): ${stderr.trim() || raw}`, 500);
}

function defaultRunCommand(file, args, { env = {}, timeout = DEFAULT_TIMEOUT } = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin:/usr/local/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      ...env,
    },
    windowsHide: true,
  });
}

function formatIniConfig(remotes) {
  const sections = [];
  for (const remote of remotes) {
    if (!remote || typeof remote !== 'object' || !remote.name || !remote.type) {
      throw new RcloneError('rclone_config_invalid', 'Invalid remote definition for rclone config');
    }
    const lines = [`[${normalizeRemoteName(remote.name)}]`, `type = ${remote.type.trim()}`];
    const props = { ...(remote.parameters ?? {}), ...(remote.credentials ?? {}) };
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined && value !== null && value !== '') {
        lines.push(`${key} = ${String(value).trim()}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n') + '\n';
}

export function createRcloneManager({
  rclonePath = null,
  accessFn = access,
  runCommand = defaultRunCommand,
  now = () => Date.now(),
} = {}) {
  async function requireBinary() {
    const binary = await findRcloneBinary(rclonePath, accessFn);
    if (!binary) {
      throw new RcloneError('rclone_binary_missing', 'Rclone executable not found in allowlisted paths', 503);
    }
    return binary;
  }

  async function execRclone(args, { configFile = null, extraEnv = {}, timeout = DEFAULT_TIMEOUT, context = 'exec' } = {}) {
    const binary = await requireBinary();
    const finalArgs = [...args];
    if (configFile) {
      if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) {
        throw new RcloneError('rclone_config_invalid', 'configFile must be an absolute path');
      }
      finalArgs.push('--config', configFile);
    }
    try {
      return await runCommand(binary, finalArgs, { env: extraEnv, timeout });
    } catch (error) {
      throw mapRcloneError(error, context);
    }
  }

  async function version() {
    let result;
    try {
      result = await execRclone(['version', '--json'], { context: 'version' });
      return Object.freeze(JSON.parse(result.stdout.trim()));
    } catch {
      try {
        result = await execRclone(['version'], { context: 'version' });
        const lines = result.stdout.trim().split('\n').map((l) => l.trim());
        const firstLine = lines[0] || '';
        const versionMatch = firstLine.match(/rclone\s+(v[^\s]+)/i);
        const parsed = {
          version: versionMatch ? versionMatch[1] : firstLine,
          raw: result.stdout.trim(),
        };
        for (const line of lines.slice(1)) {
          const match = line.match(/^-\s*([^:]+):\s*(.+)$/);
          if (match) {
            const key = match[1].trim().replace(/\//g, '_');
            parsed[key] = match[2].trim();
          }
        }
        if (parsed.os_type && !parsed.os) parsed.os = parsed.os_type;
        if (parsed.os_arch && !parsed.arch) parsed.arch = parsed.os_arch;
        return Object.freeze(parsed);
      } catch {
        throw new RcloneError('rclone_command_failed', 'Failed to parse rclone version output', 500);
      }
    }
  }

  async function testRemote({ remoteName, configFile, timeout = DEFAULT_TIMEOUT }) {
    const name = normalizeRemoteName(remoteName);
    const args = ['lsd', `${name}:`, '--contimeout', '10s', '--timeout', '15s'];
    const result = await execRclone(args, { configFile, timeout, context: 'testRemote' });
    return Object.freeze({
      reachable: true,
      remoteName: name,
      output: result.stdout.trim(),
      testedAt: new Date(now()).toISOString(),
    });
  }

  async function listRemotes({ configFile }) {
    const result = await execRclone(['listremotes'], { configFile, context: 'listRemotes' });
    const remotes = result.stdout
      .split('\n')
      .map((line) => line.trim().replace(/:$/, ''))
      .filter(Boolean);
    return Object.freeze(remotes);
  }

  async function obscure(password) {
    if (typeof password !== 'string' || !password) return '';
    const result = await execRclone(['obscure', password], { context: 'obscure' });
    return result.stdout.trim();
  }

  async function writeConfigFile({ remotes, targetPath }) {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
      throw new RcloneError('rclone_config_invalid', 'targetPath must be an absolute path');
    }
    const preparedRemotes = [];
    for (const remote of remotes) {
      if (!remote || typeof remote !== 'object' || !remote.name || !remote.type) {
        throw new RcloneError('rclone_config_invalid', 'Invalid remote definition for rclone config');
      }
      const credentials = { ...(remote.credentials ?? {}) };
      for (const key of ['pass', 'key_file_pass']) {
        if (credentials[key] && typeof credentials[key] === 'string') {
          credentials[key] = await obscure(credentials[key]);
        }
      }
      preparedRemotes.push({
        ...remote,
        credentials,
      });
    }
    const content = formatIniConfig(preparedRemotes);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, targetPath);
    return Object.freeze({
      targetPath,
      writtenAt: new Date(now()).toISOString(),
    });
  }

  return Object.freeze({
    version,
    testRemote,
    listRemotes,
    writeConfigFile,
    obscure,
  });
}

export const rcloneManagerInternals = Object.freeze({
  RCLONE_PATHS,
  findRcloneBinary,
  mapRcloneError,
  normalizeRemoteName,
  formatIniConfig,
});
