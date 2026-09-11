import { readFile, realpath, stat } from 'node:fs/promises';
import * as nodePty from 'node-pty';

const SHELL_PATH = '/bin/bash';
const RUNUSER_PATH = '/usr/sbin/runuser';
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const APPLICATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RELEASE_ID = APPLICATION_ID;
const SITE_CURRENT_PATTERN = new RegExp(`^(/(?:var/www|var/lib)/yunpanel/apps/(${APPLICATION_ID}))/current$`, 'i');
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

function terminalEnvironment({ user, home }) {
  return Object.freeze({
    COLORTERM: 'truecolor',
    HOME: home,
    LANG: 'C.UTF-8',
    LOGNAME: user,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: SHELL_PATH,
    TERM: 'xterm-256color',
    USER: user,
  });
}

function parseManagedAccount(passwdText, user) {
  if (typeof passwdText !== 'string' || !APP_USER_PATTERN.test(user)) {
    throw new TerminalProcessError('site_terminal_account_invalid', 'Website terminal account is invalid', 409);
  }
  const matching = passwdText.split('\n').filter((line) => line.startsWith(`${user}:`));
  if (matching.length !== 1) {
    throw new TerminalProcessError('site_terminal_account_missing', 'Website terminal account is unavailable', 409);
  }
  const fields = matching[0].split(':');
  const numericId = /^[1-9][0-9]{0,9}$/;
  const uid = numericId.test(fields[2] ?? '') ? Number(fields[2]) : null;
  const gid = numericId.test(fields[3] ?? '') ? Number(fields[3]) : null;
  const home = fields[5];
  if (fields.length !== 7 || !Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647
    || !Number.isSafeInteger(gid) || gid < 1 || gid > 2_147_483_647
    || typeof home !== 'string' || !home.startsWith('/') || /[\u0000-\u001f\u007f]/.test(home)) {
    throw new TerminalProcessError('site_terminal_account_invalid', 'Website terminal account is invalid', 409);
  }
  return Object.freeze({ user, home });
}

function validateTargetShape(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TerminalProcessError('terminal_target_invalid', 'Terminal target is invalid');
  }
  if (target.scope === 'server' && target.user === 'root' && target.cwd === '/root') return;
  if (target.scope === 'site' && APP_USER_PATTERN.test(target.user ?? '') && SITE_CURRENT_PATTERN.test(target.cwd ?? '')) return;
  throw new TerminalProcessError('terminal_target_invalid', 'Terminal target is invalid');
}

async function resolveTarget(target, { statFn, realpathFn, readPasswd }) {
  validateTargetShape(target);
  let info;
  try { info = await statFn(target.cwd); }
  catch { throw new TerminalProcessError('terminal_directory_unavailable', 'Terminal directory is unavailable', 409); }
  if (!info.isDirectory()) {
    throw new TerminalProcessError('terminal_directory_unavailable', 'Terminal directory is unavailable', 409);
  }
  let resolved;
  try { resolved = await realpathFn(target.cwd); }
  catch { throw new TerminalProcessError('terminal_directory_unavailable', 'Terminal directory is unavailable', 409); }

  if (target.scope === 'server') {
    if (resolved !== '/root') throw new TerminalProcessError('terminal_directory_invalid', 'Server terminal directory is invalid', 409);
    return Object.freeze({ file: SHELL_PATH, args: ['--login'], user: 'root', home: '/root', cwd: '/root' });
  }

  const match = SITE_CURRENT_PATTERN.exec(target.cwd);
  const releasePattern = new RegExp(`^${match[1]}/releases/${RELEASE_ID}$`, 'i');
  if (!releasePattern.test(resolved)) {
    throw new TerminalProcessError('site_terminal_directory_escape', 'Website terminal directory escaped managed storage', 409);
  }
  const account = parseManagedAccount(await readPasswd(), target.user);
  return Object.freeze({
    file: RUNUSER_PATH,
    args: ['-u', account.user, '--', SHELL_PATH, '--noprofile', '--norc', '-i'],
    user: account.user,
    home: account.home,
    cwd: target.cwd,
  });
}

export function createTerminalProcessManager({
  spawnPty = nodePty.spawn,
  statFn = stat,
  realpathFn = realpath,
  readPasswd = () => readFile('/etc/passwd', 'utf8'),
  getuid = process.getuid?.bind(process),
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
    if (getuid() !== 0) {
      throw new TerminalProcessError('terminal_root_runtime_required', 'Terminal runtime requires the root panel service', 503);
    }
    const size = dimensions(cols, rows);
    const resolved = await resolveTarget(target, { statFn, realpathFn, readPasswd });
    let child;
    try {
      child = spawnPty(resolved.file, resolved.args, {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: resolved.cwd,
        env: terminalEnvironment(resolved),
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
  shellPath: SHELL_PATH,
  runuserPath: RUNUSER_PATH,
  maxInputBytes: MAX_INPUT_BYTES,
  dimensions,
  terminalEnvironment,
  parseManagedAccount,
  resolveTarget,
});
