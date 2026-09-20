import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GOACCESS_DEFAULT_REPORTS_ROOT,
  GOACCESS_DEFAULT_SOCKET_ROOT,
  GOACCESS_LOG_FORMAT,
} from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class GoAccessManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GoAccessManagerError';
    this.code = code;
  }
}

function assertSafeId(value, label = 'id') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new GoAccessManagerError('invalid_id', `${label} must be a safe identifier`);
  }
  return value;
}

function assertSafePath(value, label = 'path') {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) {
    throw new GoAccessManagerError('invalid_path', `${label} must be a safe absolute path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new GoAccessManagerError('invalid_path', `${label} must not contain traversal segments`);
  }
  return value;
}

function execFileSafe(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

export function createGoAccessManager({
  goaccessPath = '/usr/bin/goaccess',
  socketRoot = GOACCESS_DEFAULT_SOCKET_ROOT,
  reportsDir = GOACCESS_DEFAULT_REPORTS_ROOT,
  nginxLogDir = '/var/log/nginx',
  mkdirFn = mkdir,
  readFileFn = readFile,
  writeFileFn = writeFile,
  statFn = stat,
  unlinkFn = unlink,
  chmodFn = chmod,
  execFn = execFileSafe,
  killFn = (pid, signal) => process.kill(pid, signal),
} = {}) {
  async function inspectGoAccess() {
    try {
      const { stdout } = await execFn(goaccessPath, ['--version']);
      const versionMatch = stdout.match(/GoAccess\s*-\s*([0-9]+(?:\.[0-9]+)+)/i);
      return {
        satisfied: true,
        binaryPath: goaccessPath,
        version: versionMatch ? versionMatch[1] : null,
      };
    } catch {
      return {
        satisfied: false,
        binaryPath: goaccessPath,
        version: null,
      };
    }
  }

  async function ensureLogFile(logPath) {
    try {
      await statFn(logPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        await mkdirFn(path.dirname(logPath), { recursive: true, mode: 0o755 });
        await writeFileFn(logPath, '', { mode: 0o640 });
      } else {
        throw err;
      }
    }
  }

  function resolvePaths({ websiteId, primaryDomain, logPath, outputPath, socketPath, pidPath, wsUrl }) {
    const validWebsiteId = assertSafeId(websiteId, 'websiteId');
    const effectiveDomain = primaryDomain ? assertSafeId(primaryDomain.replace(/\./g, '_'), 'primaryDomain') : validWebsiteId;
    const effectiveLogPath = logPath ? assertSafePath(logPath, 'logPath') : path.join(nginxLogDir, `${primaryDomain ?? validWebsiteId}.access.log`);
    const effectiveOutputPath = outputPath ? assertSafePath(outputPath, 'outputPath') : path.join(reportsDir, `${validWebsiteId}.html`);
    const effectiveSocketPath = socketPath ? assertSafePath(socketPath, 'socketPath') : path.join(socketRoot, `${validWebsiteId}.sock`);
    const effectivePidPath = pidPath ? assertSafePath(pidPath, 'pidPath') : path.join(socketRoot, `${validWebsiteId}.pid`);
    const effectiveWsUrl = wsUrl ?? `/tools/goaccess/${validWebsiteId}/ws`;

    return {
      websiteId: validWebsiteId,
      effectiveDomain,
      effectiveLogPath,
      effectiveOutputPath,
      effectiveSocketPath,
      effectivePidPath,
      effectiveWsUrl,
    };
  }

  async function inspectDaemon({ websiteId, pidPath = null, socketPath = null }) {
    const validWebsiteId = assertSafeId(websiteId, 'websiteId');
    const effectivePidPath = pidPath ? assertSafePath(pidPath, 'pidPath') : path.join(socketRoot, `${validWebsiteId}.pid`);
    const effectiveSocketPath = socketPath ? assertSafePath(socketPath, 'socketPath') : path.join(socketRoot, `${validWebsiteId}.sock`);

    let pid = null;
    let running = false;
    let socketExists = false;

    try {
      const pidContent = await readFileFn(effectivePidPath, 'utf8');
      const parsedPid = Number.parseInt(pidContent.trim(), 10);
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        pid = parsedPid;
        try {
          killFn(pid, 0);
          running = true;
        } catch {
          running = false;
        }
      }
    } catch {
      running = false;
    }

    try {
      const socketStat = await statFn(effectiveSocketPath);
      socketExists = Boolean(socketStat);
    } catch {
      socketExists = false;
    }

    return {
      websiteId: validWebsiteId,
      running,
      pid: running ? pid : null,
      socketExists,
      socketPath: effectiveSocketPath,
      pidPath: effectivePidPath,
    };
  }

  async function ensureDirMode(dirPath, mode = 0o755) {
    await mkdirFn(dirPath, { recursive: true, mode });
    let current = path.resolve(dirPath);
    while (current && current !== '/' && current !== '.') {
      try { await chmodFn(current, mode); } catch {}
      const parent = path.dirname(current);
      if (parent === current || parent === '/var/lib/yunpanel' || parent === '/var/lib' || parent === '/run/yunpanel' || parent === '/run') {
        try { await chmodFn(current, mode); } catch {}
        break;
      }
      current = parent;
    }
  }

  async function generateStaticReport({
    websiteId,
    primaryDomain,
    logPath = null,
    outputPath = null,
  }) {
    const paths = resolvePaths({ websiteId, primaryDomain, logPath, outputPath });
    await ensureLogFile(paths.effectiveLogPath);
    await ensureDirMode(path.dirname(paths.effectiveOutputPath), 0o755);

    try {
      await execFn(goaccessPath, [
        paths.effectiveLogPath,
        '-o', paths.effectiveOutputPath,
        `--log-format=${GOACCESS_LOG_FORMAT}`,
      ]);
      try { await chmodFn(paths.effectiveOutputPath, 0o644); } catch {}

      return {
        satisfied: true,
        websiteId: paths.websiteId,
        primaryDomain: primaryDomain ?? null,
        logPath: paths.effectiveLogPath,
        outputPath: paths.effectiveOutputPath,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new GoAccessManagerError('report_generation_failed', `Failed to generate GoAccess report: ${error.message}`);
    }
  }

  async function startRealtimeDaemon({
    websiteId,
    primaryDomain,
    logPath = null,
    outputPath = null,
    socketPath = null,
    pidPath = null,
    wsUrl = null,
  }) {
    const paths = resolvePaths({
      websiteId, primaryDomain, logPath, outputPath, socketPath, pidPath, wsUrl,
    });

    const status = await inspectDaemon({
      websiteId: paths.websiteId,
      pidPath: paths.effectivePidPath,
      socketPath: paths.effectiveSocketPath,
    });

    if (status.running && status.socketExists) {
      try { await chmodFn(paths.effectiveSocketPath, 0o666); } catch {}
      return {
        running: true,
        alreadyRunning: true,
        pid: status.pid,
        websiteId: paths.websiteId,
        socketPath: paths.effectiveSocketPath,
        outputPath: paths.effectiveOutputPath,
        pidPath: paths.effectivePidPath,
        wsUrl: paths.effectiveWsUrl,
      };
    }

    // Clean up any stale socket or pid file
    if (!status.running) {
      try { await unlinkFn(paths.effectiveSocketPath); } catch {}
      try { await unlinkFn(paths.effectivePidPath); } catch {}
    }

    await ensureLogFile(paths.effectiveLogPath);
    await ensureDirMode(path.dirname(paths.effectiveOutputPath), 0o755);
    await ensureDirMode(socketRoot, 0o755);

    try {
      await execFn(goaccessPath, [
        paths.effectiveLogPath,
        '-o', paths.effectiveOutputPath,
        '--real-time-html',
        `--unix-socket=${paths.effectiveSocketPath}`,
        `--ws-url=${paths.effectiveWsUrl}`,
        `--log-format=${GOACCESS_LOG_FORMAT}`,
        '--daemonize',
        `--pid-file=${paths.effectivePidPath}`,
      ]);
    } catch (error) {
      throw new GoAccessManagerError('daemon_start_failed', `Failed to start GoAccess daemon: ${error.message}`);
    }

    // Verify daemon started
    let verified = false;
    let pid = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const check = await inspectDaemon({
        websiteId: paths.websiteId,
        pidPath: paths.effectivePidPath,
        socketPath: paths.effectiveSocketPath,
      });
      if (check.running && check.socketExists) {
        verified = true;
        pid = check.pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!verified) {
      throw new GoAccessManagerError('daemon_verify_failed', 'GoAccess daemon started but socket or pid file did not become ready');
    }

    try { await chmodFn(paths.effectiveOutputPath, 0o644); } catch {}
    try { await chmodFn(paths.effectiveSocketPath, 0o666); } catch {}

    return {
      running: true,
      alreadyRunning: false,
      pid,
      websiteId: paths.websiteId,
      socketPath: paths.effectiveSocketPath,
      outputPath: paths.effectiveOutputPath,
      pidPath: paths.effectivePidPath,
      wsUrl: paths.effectiveWsUrl,
    };
  }

  async function stopRealtimeDaemon({
    websiteId,
    pidPath = null,
    socketPath = null,
  }) {
    const validWebsiteId = assertSafeId(websiteId, 'websiteId');
    const effectivePidPath = pidPath ? assertSafePath(pidPath, 'pidPath') : path.join(socketRoot, `${validWebsiteId}.pid`);
    const effectiveSocketPath = socketPath ? assertSafePath(socketPath, 'socketPath') : path.join(socketRoot, `${validWebsiteId}.sock`);

    const status = await inspectDaemon({
      websiteId: validWebsiteId,
      pidPath: effectivePidPath,
      socketPath: effectiveSocketPath,
    });

    if (status.running && status.pid) {
      try {
        killFn(status.pid, 'SIGTERM');
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    }

    try { await unlinkFn(effectiveSocketPath); } catch {}
    try { await unlinkFn(effectivePidPath); } catch {}

    return {
      stopped: true,
      websiteId: validWebsiteId,
      pid: status.pid,
    };
  }

  async function restartRealtimeDaemon(args) {
    await stopRealtimeDaemon(args);
    return startRealtimeDaemon(args);
  }

  async function readReport({ websiteId, outputPath = null }) {
    const validWebsiteId = assertSafeId(websiteId, 'websiteId');
    const effectiveOutputPath = outputPath ? assertSafePath(outputPath, 'outputPath') : path.join(reportsDir, `${validWebsiteId}.html`);

    try {
      const stats = await statFn(effectiveOutputPath);
      const content = await readFileFn(effectiveOutputPath, 'utf8');
      return {
        websiteId: validWebsiteId,
        content,
        outputPath: effectiveOutputPath,
        mtime: stats.mtime.toISOString(),
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new GoAccessManagerError('report_read_failed', `Failed to read GoAccess report: ${error.message}`);
    }
  }

  return Object.freeze({
    inspectGoAccess,
    inspectDaemon,
    generateStaticReport,
    startRealtimeDaemon,
    stopRealtimeDaemon,
    restartRealtimeDaemon,
    readReport,
  });
}
