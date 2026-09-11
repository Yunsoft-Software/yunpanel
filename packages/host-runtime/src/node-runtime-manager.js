import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MANAGED_NODE_RUNTIME_MAJORS } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = '/opt/yunpanel/node-runtimes';
const PANEL_NODE_PATH = '/usr/local/bin/node';
const SYSTEM_NODE_PATH = '/usr/bin/node';
const CURL_PATH = '/usr/bin/curl';
const TAR_PATH = '/usr/bin/tar';
const SHA256SUM_PATH = '/usr/bin/sha256sum';
const SUPPORTED_MAJORS = MANAGED_NODE_RUNTIME_MAJORS;
const REQUIRED_PACKAGE_MANAGERS = Object.freeze(['npm', 'pnpm', 'yarn']);
const VERSION_PATTERN = /^v(\d{1,2})\.(\d{1,3})\.(\d{1,3})$/;

export class NodeRuntimeManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeRuntimeManagerError';
    this.code = code;
  }
}

function parseVersion(value) {
  const version = String(value ?? '').trim();
  const match = version.match(VERSION_PATTERN);
  return match ? { version, major: Number.parseInt(match[1], 10) } : null;
}

function managedRuntimePath(root, major) {
  return path.join(root, `v${major}`);
}

function managedNodePath(root, major) {
  return path.join(managedRuntimePath(root, major), 'bin', 'node');
}

function requireSupportedMajor(value, supportedMajors) {
  if (!Number.isInteger(value) || !supportedMajors.includes(value)) {
    throw new NodeRuntimeManagerError('node_runtime_unsupported', 'Requested Node.js major is not supported for managed installation');
  }
  return value;
}

function archiveFromShasums(contents, major, architecture) {
  const pattern = new RegExp(`^([a-f0-9]{64})  (node-v(${major}\\.\\d+\\.\\d+)-linux-${architecture}\\.tar\\.xz)$`, 'm');
  const match = String(contents ?? '').match(pattern);
  if (!match) throw new NodeRuntimeManagerError('node_runtime_manifest_invalid', 'Official Node.js checksum manifest does not contain the requested runtime archive');
  return { checksum: match[1], fileName: match[2], version: `v${match[3]}` };
}

function runtimeArchitecture(value) {
  if (value === 'x64' || value === 'arm64') return value;
  throw new NodeRuntimeManagerError('node_runtime_architecture_unsupported', 'Managed Node.js installation supports only x64 and arm64 hosts');
}

export function createNodeRuntimeManager({
  runtimeRoot = RUNTIME_ROOT,
  panelNodePath = PANEL_NODE_PATH,
  systemNodePath = SYSTEM_NODE_PATH,
  supportedMajors = SUPPORTED_MAJORS,
  architecture = process.arch,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8', timeout: options.timeout ?? 10 * 60 * 1000, maxBuffer: options.maxBuffer ?? 1024 * 1024,
    env: options.env,
  }),
  lstatFn = lstat,
  mkdirFn = mkdir,
  mkdtempFn = mkdtemp,
  readFileFn = readFile,
  realpathFn = realpath,
  renameFn = rename,
  rmFn = rm,
} = {}) {
  const majors = Object.freeze([...supportedMajors]);
  if (majors.length < 1 || new Set(majors).size !== majors.length
    || majors.some((major) => !Number.isInteger(major) || major < 20 || major > 40)) {
    throw new Error('supportedMajors must contain unique Node.js major versions');
  }
  const hostArchitecture = runtimeArchitecture(architecture);
  let activeInstall = null;

  async function inspectExecutable(executablePath, source) {
    try {
      const { stdout } = await run(executablePath, ['--version'], { timeout: 5_000, maxBuffer: 4_096 });
      const parsed = parseVersion(stdout);
      return parsed ? { path: executablePath, source, ...parsed } : null;
    } catch {
      return null;
    }
  }

  async function safeManagedRuntime(major) {
    const runtimeDirectory = managedRuntimePath(runtimeRoot, major);
    const nodePath = managedNodePath(runtimeRoot, major);
    try {
      const [directoryInfo, nodeInfo, resolvedDirectory, resolvedNode] = await Promise.all([
        lstatFn(runtimeDirectory), lstatFn(nodePath), realpathFn(runtimeDirectory), realpathFn(nodePath),
      ]);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !nodeInfo.isFile() || nodeInfo.isSymbolicLink()
        || !resolvedNode.startsWith(`${resolvedDirectory}${path.sep}`)) return null;
    } catch {
      return null;
    }
    const executable = await inspectExecutable(nodePath, 'managed');
    if (!executable || executable.major !== major) return null;
    const packageManagers = [];
    for (const name of REQUIRED_PACKAGE_MANAGERS) {
      try {
        const candidate = path.join(runtimeDirectory, 'bin', name);
        const resolved = await realpathFn(candidate);
        const resolvedDirectory = await realpathFn(runtimeDirectory);
        if (resolved.startsWith(`${resolvedDirectory}${path.sep}`)) packageManagers.push(name);
      } catch { /* Missing package-manager shim remains explicit in inventory. */ }
    }
    return { ...executable, packageManagers };
  }

  async function inspect() {
    const [panelRuntime, systemRuntime, ...managed] = await Promise.all([
      inspectExecutable(panelNodePath, 'panel'),
      inspectExecutable(systemNodePath, 'system'),
      ...majors.map(safeManagedRuntime),
    ]);
    return {
      platform: 'linux',
      architecture: hostArchitecture,
      supportedMajors: majors,
      panelRuntime,
      systemRuntime,
      managedRuntimes: majors.map((major, index) => ({
        major,
        installed: Boolean(managed[index]),
        path: managedNodePath(runtimeRoot, major),
        version: managed[index]?.version ?? null,
        packageManagers: managed[index]?.packageManagers ?? [],
      })),
    };
  }

  async function requireSafeRoot() {
    await mkdirFn(runtimeRoot, { recursive: true, mode: 0o755 });
    let info;
    let resolved;
    try { [info, resolved] = await Promise.all([lstatFn(runtimeRoot), realpathFn(runtimeRoot)]); }
    catch { throw new NodeRuntimeManagerError('node_runtime_root_invalid', 'Managed Node.js runtime root is unavailable'); }
    if (!info.isDirectory() || info.isSymbolicLink() || typeof resolved !== 'string' || !path.isAbsolute(resolved)) {
      throw new NodeRuntimeManagerError('node_runtime_root_invalid', 'Managed Node.js runtime root must be a real fixed directory');
    }
  }

  async function requireInstallDependency(executablePath) {
    try { await run(executablePath, ['--version'], { timeout: 5_000, maxBuffer: 16 * 1024 }); }
    catch { throw new NodeRuntimeManagerError('node_runtime_install_dependency_missing', 'A required managed Node.js installation tool is unavailable'); }
  }

  async function performInstall(rawMajor) {
    const major = requireSupportedMajor(rawMajor, majors);
    const panelBefore = await inspectExecutable(panelNodePath, 'panel');
    if (!panelBefore) throw new NodeRuntimeManagerError('panel_node_runtime_unavailable', 'YunPanel packaged Node.js runtime could not be verified');
    const existing = await safeManagedRuntime(major);
    if (existing && REQUIRED_PACKAGE_MANAGERS.every((name) => existing.packageManagers.includes(name))) {
      return { changed: false, runtime: existing, inventory: await inspect() };
    }
    try {
      await lstatFn(managedRuntimePath(runtimeRoot, major));
      throw new NodeRuntimeManagerError('node_runtime_existing_invalid', 'Existing managed Node.js runtime state is invalid and will not be overwritten');
    } catch (error) {
      if (error instanceof NodeRuntimeManagerError) throw error;
      if (error?.code !== 'ENOENT') throw new NodeRuntimeManagerError('node_runtime_existing_invalid', 'Existing managed Node.js runtime state could not be inspected');
    }

    await requireSafeRoot();
    await Promise.all([CURL_PATH, TAR_PATH, SHA256SUM_PATH].map(requireInstallDependency));

    const temporaryRoot = await mkdtempFn(path.join(runtimeRoot, `.install-v${major}-`));
    const shasumsPath = path.join(temporaryRoot, 'SHASUMS256.txt');
    const extractPath = path.join(temporaryRoot, 'runtime');
    const baseUrl = `https://nodejs.org/download/release/latest-v${major}.x`;
    try {
      await run(CURL_PATH, ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--output', shasumsPath, `${baseUrl}/SHASUMS256.txt`]);
      let archive;
      try { archive = archiveFromShasums(await readFileFn(shasumsPath, 'utf8'), major, hostArchitecture); }
      catch (error) { if (error instanceof NodeRuntimeManagerError) throw error; throw new NodeRuntimeManagerError('node_runtime_manifest_invalid', 'Official Node.js checksum manifest could not be read'); }
      const archivePath = path.join(temporaryRoot, archive.fileName);
      await run(CURL_PATH, ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--tlsv1.2', '--output', archivePath, `${baseUrl}/${archive.fileName}`]);
      let checksumOutput;
      try { ({ stdout: checksumOutput } = await run(SHA256SUM_PATH, [archivePath], { timeout: 2 * 60 * 1000, maxBuffer: 4_096 })); }
      catch { throw new NodeRuntimeManagerError('node_runtime_checksum_failed', 'Downloaded Node.js runtime checksum could not be calculated'); }
      if (String(checksumOutput ?? '').trim().split(/\s+/)[0] !== archive.checksum) {
        throw new NodeRuntimeManagerError('node_runtime_checksum_mismatch', 'Downloaded Node.js runtime does not match the official checksum manifest');
      }
      await mkdirFn(extractPath, { mode: 0o755 });
      try {
        await run(TAR_PATH, ['--extract', '--file', archivePath, '--directory', extractPath, '--strip-components=1', '--no-same-owner', '--no-same-permissions'], { timeout: 5 * 60 * 1000 });
      } catch { throw new NodeRuntimeManagerError('node_runtime_extract_failed', 'Verified Node.js runtime archive could not be extracted'); }
      const extractedNode = await inspectExecutable(path.join(extractPath, 'bin', 'node'), 'managed');
      if (!extractedNode || extractedNode.major !== major || extractedNode.version !== archive.version) {
        throw new NodeRuntimeManagerError('node_runtime_version_mismatch', 'Extracted Node.js runtime does not match the requested official release');
      }
      try {
        await run(path.join(extractPath, 'bin', 'corepack'), [
          'enable', '--install-directory', path.join(extractPath, 'bin'), 'pnpm', 'yarn',
        ], { timeout: 30_000, maxBuffer: 64 * 1024 });
      } catch { throw new NodeRuntimeManagerError('node_runtime_corepack_failed', 'Managed pnpm/yarn shims could not be enabled'); }
      try { await renameFn(extractPath, managedRuntimePath(runtimeRoot, major)); }
      catch { throw new NodeRuntimeManagerError('node_runtime_install_failed', 'Managed Node.js runtime could not be activated atomically'); }
      const installed = await safeManagedRuntime(major);
      const panelAfter = await inspectExecutable(panelNodePath, 'panel');
      if (!installed || !REQUIRED_PACKAGE_MANAGERS.every((name) => installed.packageManagers.includes(name))
        || !panelAfter || panelAfter.path !== panelBefore.path || panelAfter.version !== panelBefore.version) {
        throw new NodeRuntimeManagerError('node_runtime_install_unconfirmed', 'Managed Node.js installation or YunPanel runtime isolation could not be confirmed');
      }
      return { changed: true, runtime: installed, inventory: await inspect() };
    } finally {
      await rmFn(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function install(major) {
    if (activeInstall) throw new NodeRuntimeManagerError('node_runtime_install_in_progress', 'Another managed Node.js runtime installation is in progress');
    const operation = performInstall(major);
    activeInstall = operation;
    try { return await operation; }
    finally { if (activeInstall === operation) activeInstall = null; }
  }

  return Object.freeze({ inspect, install });
}

export const nodeRuntimeManager = createNodeRuntimeManager();
export const nodeRuntimePolicy = Object.freeze({
  runtimeRoot: RUNTIME_ROOT,
  panelNodePath: PANEL_NODE_PATH,
  systemNodePath: SYSTEM_NODE_PATH,
  supportedMajors: SUPPORTED_MAJORS,
  requiredPackageManagers: REQUIRED_PACKAGE_MANAGERS,
});
export const nodeRuntimeInternals = Object.freeze({
  parseVersion, managedRuntimePath, managedNodePath, requireSupportedMajor, archiveFromShasums, runtimeArchitecture,
});
