import { readFile, realpath, stat } from 'node:fs/promises';
import * as nodePty from 'node-pty';
import {
  resolveTerminalTarget,
  terminalTargetInternals,
} from './terminal-target-resolver.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const MAX_INPUT_BYTES = 16 * 1024;

export class TerminalProcessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TerminalProcessError';
    this.code = code;
    this.status = status;
  }
}

function dimensions(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  if (!Number.isSafeInteger(cols) || cols < 20 || cols > 500
    || !Number.isSafeInteger(rows) || rows < 5 || rows > 200) {
    throw new TerminalProcessError('terminal_dimensions_invalid', 'Terminal dimensions are invalid');
  }
  return { cols, rows };
}

export function createTerminalProcessManager({
  spawnPty = nodePty.spawn ?? nodePty.default?.spawn,
  statFn = stat,
  realpathFn = realpath,
  readPasswd = () => readFile('/etc/passwd', 'utf8'),
  getuid = process.getuid?.bind(process) ?? (() => 1000),
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  killGraceMs = 2_000,
} = {}) {
  if (typeof spawnPty !== 'function' || typeof statFn !== 'function' || typeof realpathFn !== 'function'
    || typeof readPasswd !== 'function' || typeof getuid !== 'function' || typeof killProcessGroup !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 10_000) {
    throw new TypeError('Terminal process dependencies are invalid');
  }

  async function open({ target, cols, rows, onData, onExit } = {}) {
    if (typeof onData !== 'function' || typeof onExit !== 'function') {
      throw new TypeError('Terminal process callbacks are required');
    }
    const isRoot = getuid() === 0;
    if (!isRoot && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      throw new TerminalProcessError('terminal_root_runtime_required', 'Terminal runtime requires the root panel service', 503);
    }
    const size = dimensions(cols, rows);
    const resolved = await resolveTerminalTarget(target, {
      statFn,
      realpathFn,
      readPasswd,
      errorFactory: (code, message, status) => new TerminalProcessError(code, message, status),
    });

    const fileToSpawn = isRoot ? resolved.file : (resolved.directFile ?? resolved.file);
    const argsToSpawn = isRoot ? resolved.args : (resolved.directArgs ?? resolved.args);

    let child;
    try {
      child = spawnPty(fileToSpawn, argsToSpawn, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: resolved.cwd,
        env: resolved.env,
      });
    } catch {
      throw new TerminalProcessError('terminal_spawn_failed', 'Terminal process could not be started', 503);
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1
      || typeof child.onData !== 'function' || typeof child.onExit !== 'function'
      || typeof child.write !== 'function' || typeof child.resize !== 'function') {
      try { child?.kill?.('SIGKILL'); } catch {}
      throw new TerminalProcessError('terminal_spawn_failed', 'Terminal process could not be started', 503);
    }

    let closed = false;
    let exited = false;
    let forceTimer = null;
    let dataSubscription;
    let exitSubscription;
    dataSubscription = child.onData((data) => {
      if (!closed && typeof data === 'string') onData(data);
    });
    exitSubscription = child.onExit((event) => {
      if (exited) return;
      exited = true;
      closed = true;
      if (forceTimer !== null) clearTimer(forceTimer);
      dataSubscription?.dispose?.();
      exitSubscription?.dispose?.();
      onExit({ exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null, signal: Number.isInteger(event?.signal) ? event.signal : null });
    });

    function signal(signalName) {
      try { killProcessGroup(child.pid, signalName); }
      catch {
        try { child.kill?.(signalName); } catch {}
      }
    }

    function close() {
      if (closed) return false;
      closed = true;
      signal('SIGHUP');
      if (!exited) {
        forceTimer = setTimer(() => { if (!exited) signal('SIGKILL'); }, killGraceMs);
        forceTimer?.unref?.();
      }
      return true;
    }

    return Object.freeze({
      pid: child.pid,
      target,
      write(data) {
        if (closed) throw new TerminalProcessError('terminal_closed', 'Terminal process is closed', 409);
        if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
          throw new TerminalProcessError('terminal_input_invalid', 'Terminal input is invalid');
        }
        child.write(data);
      },
      resize(nextCols, nextRows) {
        if (closed) throw new TerminalProcessError('terminal_closed', 'Terminal process is closed', 409);
        const next = dimensions(nextCols, nextRows);
        child.resize(next.cols, next.rows);
      },
      close,
    });
  }

  return Object.freeze({ open });
}

export const terminalProcessInternals = Object.freeze({
  shellPath: terminalTargetInternals.shellPath,
  runuserPath: terminalTargetInternals.runuserPath,
  maxInputBytes: MAX_INPUT_BYTES,
  dimensions,
  terminalEnvironment: terminalTargetInternals.terminalEnvironment,
  parseManagedAccount: (passwdText, user) => terminalTargetInternals.parseManagedAccount(
    passwdText,
    user,
    (code, message, status) => new TerminalProcessError(code, message, status),
  ),
  resolveTarget: (target, dependencies) => resolveTerminalTarget(target, {
    ...dependencies,
    errorFactory: (code, message, status) => new TerminalProcessError(code, message, status),
  }),
});
