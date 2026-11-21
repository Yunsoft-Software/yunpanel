import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createTtydRuntimeManager } from '@yunpanel/host-runtime';
import { resolveTerminalTarget } from './terminal-target-resolver.js';
import {
  assertOwnedTerminalSupport,
  captureOwnedTerminalIdentity,
  createOwnedTerminalLifecycle,
  formatTerminalDrainFailureLine,
  observeTerminalChild,
} from './terminal-process-manager.js';

const TTYD = '/usr/bin/ttyd';
const GETENT = '/usr/bin/getent';
const SOCKET_ROOT = '/run/yunpanel/ttyd';
const SOCKET_OWNER = 'yunpanel:yunpanel';
const AUTH_HEADER = 'X-YunPanel-TTYD-Auth';
const PUBLIC_PREFIX = '/tools/ttyd';
const DEFAULT_STARTUP_MS = 60_000;
const DEFAULT_LIFETIME_MS = 4 * 60 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_USER_SESSIONS = 5;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TtydSessionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TtydSessionError';
    this.code = code;
    this.status = status;
  }
}

function boundedIdentity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TtydSessionError('ttyd_session_identity_invalid', `${field} is invalid`);
  }
  return value;
}

function parsePasswd(value, name) {
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 7 || fields[0] !== name || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) {
    return null;
  }
  const uid = Number.parseInt(fields[2], 10);
  const gid = Number.parseInt(fields[3], 10);
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) return null;
  return Object.freeze({ uid, gid });
}

function parseGroup(value, name) {
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 4 || fields[0] !== name || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  return Number.isSafeInteger(gid) && gid > 0 ? Object.freeze({ gid }) : null;
}

function ttydArgs({ sessionId, socketPath, resolved }) {
  const privilege = resolved.user === 'root'
    ? []
    : ['--uid', String(resolved.uid), '--gid', String(resolved.gid)];
  return Object.freeze([
    '--interface', socketPath,
    '--socket-owner', SOCKET_OWNER,
    '--writable',
    '--check-origin',
    '--max-clients', '1',
    '--once',
    '--signal', '1',
    '--cwd', resolved.cwd,
    '--base-path', `${PUBLIC_PREFIX}/${sessionId}`,
    '--auth-header', AUTH_HEADER,
    '--terminal-type', 'xterm-256color',
    ...privilege,
    resolved.directFile,
    ...resolved.directArgs,
  ]);
}

function publicSession(record) {
  return Object.freeze({
    version: 1,
    protocol: 'yunpanel-ttyd-v1',
    audience: 'terminal',
    sessionId: record.id,
    target: record.target,
    basePath: `${PUBLIC_PREFIX}/${record.id}/`,
    expiresAt: record.expiresAt,
  });
}

export function createTtydSessionManager({
  runtimeManager = createTtydRuntimeManager(),
  liveSessions = null,
  spawnProcess = spawn,
  run = null,
  statFn = stat,
  realpathFn = realpath,
  readPasswd = () => readFile('/etc/passwd', 'utf8'),
  lstatFn = lstat,
  mkdirFn = mkdir,
  rmFn = rm,
  chmodFn = chmod,
  chownFn = chown,
  getuid = process.getuid?.bind(process),
  killProcessGroup = (pid, signal) => process.kill(-pid, signal),
  randomId = randomUUID,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  startupMs = DEFAULT_STARTUP_MS,
  lifetimeMs = DEFAULT_LIFETIME_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxUserSessions = DEFAULT_MAX_USER_SESSIONS,
  onDrainError = null,
} = {}) {
  if (!runtimeManager || typeof runtimeManager.apply !== 'function'
    || typeof spawnProcess !== 'function'
    || typeof statFn !== 'function' || typeof realpathFn !== 'function'
    || typeof readPasswd !== 'function' || typeof lstatFn !== 'function'
    || typeof mkdirFn !== 'function' || typeof rmFn !== 'function'
    || typeof chmodFn !== 'function' || typeof chownFn !== 'function'
    || typeof getuid !== 'function' || typeof killProcessGroup !== 'function'
    || typeof randomId !== 'function' || typeof now !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || (onDrainError !== null && typeof onDrainError !== 'function')
    || (liveSessions !== null && typeof liveSessions?.register !== 'function')
    || !Number.isSafeInteger(startupMs) || startupMs < 5_000 || startupMs > 5 * 60_000
    || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 12 * 60 * 60_000
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 10_000
    || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100
    || !Number.isSafeInteger(maxUserSessions) || maxUserSessions < 1 || maxUserSessions > maxSessions) {
    throw new TypeError('ttyd session dependencies are invalid');
  }

  function reportDrainError(websiteId, error) {
    const line = formatTerminalDrainFailureLine({ backend: 'ttyd', websiteId, error });
    try {
      if (onDrainError) onDrainError({ backend: 'ttyd', websiteId, line });
      else console.error(line);
    } catch {}
  }

  const sessions = new Map();
  let pendingCount = 0;
  const pendingByUser = new Map();

  function totalSessionCount() {
    return sessions.size + pendingCount;
  }

  async function runIdentity(file, args) {
    if (typeof run !== 'function') {
      const { execFile } = await import('node:child_process');
      const result = await new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve({ stdout });
        });
      });
      return String(result.stdout ?? '');
    }
    const result = await run(file, args, { timeout: 10_000 });
    return String(result?.stdout ?? '');
  }

  async function resolveGatewayIdentity() {
    try {
      const [passwd, group] = await Promise.all([
        runIdentity(GETENT, ['passwd', 'yunpanel']),
        runIdentity(GETENT, ['group', 'yunpanel']),
      ]);
      const user = parsePasswd(passwd, 'yunpanel');
      const groupIdentity = parseGroup(group, 'yunpanel');
      if (!user || !groupIdentity || user.gid !== groupIdentity.gid) throw new Error('identity mismatch');
      return Object.freeze({ uid: user.uid, gid: groupIdentity.gid });
    } catch {
      throw new TtydSessionError(
        'ttyd_gateway_identity_unavailable',
        'YunPanel ttyd gateway identity could not be resolved',
        503,
      );
    }
  }

  async function ensureSocketRoot(identity) {
    try {
      const info = await lstatFn(SOCKET_ROOT);
      if (!info?.isDirectory?.() || info.isSymbolicLink?.()
        || info.uid !== 0 || info.gid !== identity.gid) {
        throw new TtydSessionError(
          'ttyd_socket_root_unsafe',
          'ttyd socket root ownership or mode is unsafe',
          503,
        );
      }
      if ((Number(info.mode ?? 0) & 0o7777) !== 0o2770) {
        await chmodFn(SOCKET_ROOT, 0o2770);
        const updated = await lstatFn(SOCKET_ROOT);
        if ((Number(updated?.mode ?? 0) & 0o7777) !== 0o2770) {
          throw new TtydSessionError(
            'ttyd_socket_root_unsafe',
            'ttyd socket root ownership or mode is unsafe',
            503,
          );
        }
      }
    } catch (error) {
      if (error instanceof TtydSessionError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new TtydSessionError(
          'ttyd_socket_root_unavailable',
          'ttyd socket root could not be inspected',
          503,
        );
      }
      await mkdirFn(SOCKET_ROOT, {
        recursive: true,
        mode: 0o2770,
      });
      await chownFn(SOCKET_ROOT, 0, identity.gid);
      await chmodFn(SOCKET_ROOT, 0o2770);
      const created = await lstatFn(SOCKET_ROOT);
      if (!created?.isDirectory?.() || created.isSymbolicLink?.()
        || created.uid !== 0 || created.gid !== identity.gid
        || (Number(created.mode ?? 0) & 0o7777) !== 0o2770) {
        throw new TtydSessionError(
          'ttyd_socket_root_unsafe',
          'ttyd socket root is unsafe',
          503,
        );
      }
    }
  }

  function userSessionCount(userId) {
    let count = pendingByUser.get(userId) ?? 0;
    for (const record of sessions.values()) if (record.userId === userId && !record.closed) count += 1;
    return count;
  }

  function signal(record, signalName) {
    try { killProcessGroup(record.pid, signalName); }
    catch {
      try { record.child.kill(signalName); } catch {}
    }
  }

  function cleanupRecord(record) {
    if (record.startupTimer !== null) clearTimer(record.startupTimer);
    if (record.lifetimeTimer !== null) clearTimer(record.lifetimeTimer);
    if (record.killTimer !== null) clearTimer(record.killTimer);
    record.unregister?.();
    if (!record.lease) {
      sessions.delete(record.id);
      void rmFn(record.socketPath, { force: true }).catch(() => {});
    }
  }

  function terminateRecord(record, reason = 'revoked') {
    if (!record || record.closed) return false;
    record.closed = true;
    record.closeReason = reason;
    if (record.lease) {
      const websiteId = record.target?.scope === 'site' ? record.target.websiteId : null;
      record.drainPromise = record.drain().catch((error) => {
        reportDrainError(websiteId, error);
        throw error;
      });
      record.drainPromise.catch(() => {});
      return true;
    }
    if (record.exited) {
      cleanupRecord(record);
      return true;
    }
    signal(record, 'SIGHUP');
    record.killTimer = setTimer(() => {
      if (!record.exited) signal(record, 'SIGKILL');
    }, killGraceMs);
    record.killTimer?.unref?.();
    return true;
  }

  async function waitForSocket(record, gatewayIdentity) {
    const deadline = now() + 5_000;
    let sawTransientSocket = false;
    while (now() < deadline) {
      if (record.exited) {
        throw new TtydSessionError(
          'ttyd_session_start_failed',
          'ttyd exited before its private socket became ready',
          503,
        );
      }
      try {
        const info = await lstatFn(record.socketPath);
        if (!info?.isSocket?.() || info.isSymbolicLink?.()) {
          throw new TtydSessionError(
            'ttyd_session_socket_unsafe',
            'ttyd session socket ownership or mode is unsafe',
            503,
          );
        }
        if (info.uid === gatewayIdentity.uid && info.gid === gatewayIdentity.gid
          && (Number(info.mode ?? 0) & 0o7777) === 0o660) {
          return;
        }
        // libwebsockets executes bind(), chown(), and chmod() separately; allow only
        // the transient root/gateway startup window to converge before the deadline.
        const transientOwner = (info.uid === 0 || info.uid === gatewayIdentity.uid)
          && (info.gid === 0 || info.gid === gatewayIdentity.gid);
        if (!transientOwner) {
          throw new TtydSessionError(
            'ttyd_session_socket_unsafe',
            'ttyd session socket ownership or mode is unsafe',
            503,
          );
        }
        sawTransientSocket = true;
      } catch (error) {
        if (error instanceof TtydSessionError) throw error;
        if (error?.code !== 'ENOENT') {
          throw new TtydSessionError(
            'ttyd_session_socket_unavailable',
            'ttyd session socket could not be inspected',
            503,
          );
        }
      }
      await new Promise((resolve) => {
        const timer = setTimer(resolve, 25);
        timer?.unref?.();
      });
    }
    if (sawTransientSocket) {
      throw new TtydSessionError(
        'ttyd_session_socket_unsafe',
        'ttyd session socket ownership or mode is unsafe',
        503,
      );
    }
    throw new TtydSessionError(
      'ttyd_session_socket_timeout',
      'ttyd session socket did not become ready',
      503,
    );
  }

  async function start({ ownerSessionId, userId, target } = {}) {
    const normalizedOwnerSessionId = boundedIdentity(ownerSessionId, 'ownerSessionId');
    const normalizedUserId = boundedIdentity(userId, 'userId');
    if (getuid() !== 0) {
      throw new TtydSessionError(
        'ttyd_root_runtime_required',
        'ttyd sessions require the root panel service',
        503,
      );
    }
    if (totalSessionCount() >= maxSessions || userSessionCount(normalizedUserId) >= maxUserSessions) {
      throw new TtydSessionError(
        'ttyd_session_limit',
        'Terminal session limit reached',
        429,
      );
    }

    let slotReserved = true;
    pendingCount += 1;
    pendingByUser.set(normalizedUserId, (pendingByUser.get(normalizedUserId) ?? 0) + 1);
    const releasePendingSlot = () => {
      if (!slotReserved) return;
      slotReserved = false;
      pendingCount -= 1;
      const next = (pendingByUser.get(normalizedUserId) ?? 0) - 1;
      if (next > 0) pendingByUser.set(normalizedUserId, next);
      else pendingByUser.delete(normalizedUserId);
    };

    const websiteId = target?.scope === 'site' ? target.websiteId : null;
    let lease, record, lifecycle, cancelled = false, completeOpen, spawnAttempted = false, pendingUnregister;
    let drainPromise = null;
    const opened = new Promise(resolve => { completeOpen = resolve; });
    const drain = (options) => {
      cancelled = true;
      if (drainPromise) return drainPromise;
      drainPromise = (async () => {
        await lease.awaitRemovalDecision();
        await opened;
        if (!spawnAttempted) return lease.settleWithoutProcess();
        if (!lifecycle) throw new TtydSessionError('terminal_drain_evidence_unavailable', 'Terminal kapatılamadı', 503);
        const result = await lifecycle.drain(options);
        if (record) {
          cleanupRecord(record);
          sessions.delete(record.id);
        }
        return lease.finish(result);
      })();
      drainPromise.catch(() => { drainPromise = null; });
      return drainPromise;
    };
    try {
    if (websiteId !== null) {
      if (!liveSessions?.beginWebsiteOpen) throw new TtydSessionError('terminal_drain_evidence_unavailable', 'Terminal kullanılamıyor', 503);
      try { lease = liveSessions.beginWebsiteOpen({ websiteId, backend: 'ttyd',
        snapshot: async () => {
          if (!spawnAttempted) return { version: 1, started: false };
          await opened;
          if (!lifecycle) throw new TtydSessionError('terminal_drain_evidence_unavailable', 'Terminal kapatılamadı', 503);
          return lifecycle.snapshot();
        }, stop: () => { cancelled = true; if (record) terminateRecord(record, 'website_removal'); }, drain });
      } catch (error) { throw new TtydSessionError(error.code ?? 'terminal_drain_evidence_unavailable', 'Site siliniyor', error.status ?? 503); }
    }
    if (liveSessions) pendingUnregister = liveSessions.register({
      sessionId: normalizedOwnerSessionId, userId: normalizedUserId, websiteId,
      terminate: () => { cancelled = true; if (record) terminateRecord(record, 'session_revoked'); },
    }).unregister;
    if (lease) await assertOwnedTerminalSupport();
    const runtime = await runtimeManager.apply();
    if (!runtime?.satisfied || runtime.binaryPath !== TTYD
      || runtime.distroServiceMasked !== true || runtime.distroServiceActive !== false) {
      throw new TtydSessionError(
        'ttyd_runtime_not_ready',
        'ttyd runtime is not ready',
        503,
      );
    }

    const resolved = await resolveTerminalTarget(target, {
      statFn,
      realpathFn,
      readPasswd,
      errorFactory: (code, message, status) => new TtydSessionError(code, message, status),
    });
    const gatewayIdentity = await resolveGatewayIdentity();
    await ensureSocketRoot(gatewayIdentity);

    const id = randomId().toLowerCase();
    if (!SESSION_ID_PATTERN.test(id) || sessions.has(id)) {
      throw new TtydSessionError(
        'ttyd_session_id_invalid',
        'ttyd session identity could not be allocated',
        503,
      );
    }
    const socketPath = `${SOCKET_ROOT}/${id}.sock`;
    try {
      await lstatFn(socketPath);
      throw new TtydSessionError(
        'ttyd_session_socket_conflict',
        'ttyd session socket already exists',
        409,
      );
    } catch (error) {
      if (error instanceof TtydSessionError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new TtydSessionError(
          'ttyd_session_socket_unavailable',
          'ttyd session socket state could not be inspected',
          503,
        );
      }
    }

    const args = ttydArgs({ sessionId: id, socketPath, resolved });
    if (lease?.isFenced() || cancelled) throw new TtydSessionError('terminal_website_removing', 'Site siliniyor', 409);
    let child, seed, observation;
    try {
      child = spawnProcess(TTYD, args, {
        cwd: resolved.cwd,
        detached: true,
        env: resolved.env,
        stdio: 'ignore',
      });
    } catch {
      throw new TtydSessionError(
        'ttyd_session_spawn_failed',
        'ttyd session could not be started',
        503,
      );
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1
      || typeof child.once !== 'function' || typeof child.on !== 'function' || typeof child.kill !== 'function') {
      if (child && typeof child.on === 'function') child.on('error', () => {});
      if (!lease && Number.isSafeInteger(child?.pid) && child.pid >= 1) {
        try { child.kill('SIGKILL'); } catch {}
      }
      throw new TtydSessionError(
        'ttyd_session_spawn_failed',
        'ttyd session could not be started',
        503,
      );
    }

    spawnAttempted = true;
    try {
      observation = observeTerminalChild(child, {
        onExit: () => {
          if (!record) return;
          record.exited = true; record.closed = true; cleanupRecord(record);
          if (lease) {
            record.drainPromise = drain().catch((error) => {
              reportDrainError(websiteId, error);
              throw error;
            });
            record.drainPromise.catch(() => {});
          }
        },
        onError: ({ spawnFailed }) => {
          cancelled = true;
          if (spawnFailed) lease?.settleWithoutProcess();
          if (record) terminateRecord(record, 'process_error');
        },
      });
      if (lease) seed = captureOwnedTerminalIdentity(child.pid);
    } catch (error) {
      if (error?.name === 'TerminalProcessError') throw error;
      throw new TtydSessionError(
        'ttyd_session_spawn_failed',
        'ttyd session could not be started',
        503,
      );
    }

    if (lease) {
      lifecycle = await createOwnedTerminalLifecycle({ seed, childExit: observation.exit, socketPath });
    }

    record = {
      id,
      ownerSessionId: normalizedOwnerSessionId,
      userId: normalizedUserId,
      target: Object.freeze({ ...target }),
      resolved,
      socketPath,
      pid: child.pid,
      child,
      startedAt: now(),
      expiresAt: now() + lifetimeMs,
      connectedAt: null,
      closed: false,
      exited: observation.hasExited(),
      closeReason: null,
      startupTimer: null,
      lifetimeTimer: null,
      killTimer: null,
      unregister: pendingUnregister,
      lease,
      drain,
      drainPromise: null,
    };
    sessions.set(id, record);
    releasePendingSlot();

    record.startupTimer = setTimer(() => {
      if (record.connectedAt === null) terminateRecord(record, 'connect_timeout');
    }, startupMs);
    record.startupTimer?.unref?.();
    record.lifetimeTimer = setTimer(() => terminateRecord(record, 'lifetime_timeout'), lifetimeMs);
    record.lifetimeTimer?.unref?.();

    try {
      await waitForSocket(record, gatewayIdentity);
      if (lease) await lifecycle.snapshot();
    } catch (error) {
      terminateRecord(record, 'startup_failed');
      throw error;
    }

    completeOpen();
    await lease?.awaitRemovalDecision();
    if (lease?.isFenced() || cancelled) {
      terminateRecord(record, 'website_removal');
      if (lease) await drain();
      throw new TtydSessionError('terminal_website_removing', 'Site siliniyor', 409);
    }
    return publicSession(record);
    } catch (error) {
      completeOpen();
      pendingUnregister?.();
      if (!spawnAttempted) lease?.settleWithoutProcess();
      else if (lease) {
        const drainTask = record?.drainPromise ?? drain().catch((drainError) => {
          reportDrainError(websiteId, drainError);
          throw drainError;
        });
        drainTask.catch(() => {});
      }
      if (error?.name === 'TerminalProcessError') throw new TtydSessionError(error.code, 'Terminal kapatılamadı', error.status);
      throw error;
    } finally {
      releasePendingSlot();
      completeOpen();
    }
  }

  function authorize(sessionId, {
    ownerSessionId,
    userId,
    markConnected = false,
  } = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
    const record = sessions.get(sessionId);
    if (!record || record.closed || record.exited || record.expiresAt <= now()) return null;
    if (record.ownerSessionId !== ownerSessionId || record.userId !== userId) return null;
    if (record.target.scope === 'site') {
      try { liveSessions?.assertWebsiteOpen(record.target.websiteId); } catch { return null; }
    }
    if (markConnected && record.connectedAt === null) {
      record.connectedAt = now();
      if (record.startupTimer !== null) {
        clearTimer(record.startupTimer);
        record.startupTimer = null;
      }
    }
    return Object.freeze({
      ...publicSession(record),
      socketPath: record.socketPath,
      authHeader: AUTH_HEADER,
    });
  }

  function terminate(sessionId, reason = 'owner_closed') {
    const record = sessions.get(sessionId);
    return terminateRecord(record, reason);
  }

  function terminateOwned(sessionId, { ownerSessionId, userId } = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return false;
    const record = sessions.get(sessionId);
    if (!record || record.closed || record.exited
      || record.ownerSessionId !== ownerSessionId || record.userId !== userId) return false;
    return terminateRecord(record, 'owner_closed');
  }

  function closeAll(reason = 'server_shutdown') {
    const drainPromises = [];
    for (const record of [...sessions.values()]) {
      terminateRecord(record, reason);
      if (record.drainPromise) drainPromises.push(record.drainPromise);
    }
    return Promise.allSettled(drainPromises);
  }

  return Object.freeze({
    start,
    authorize,
    terminate,
    terminateOwned,
    closeAll,
    size: () => sessions.size,
  });
}

export const ttydSessionInternals = Object.freeze({
  ttydPath: TTYD,
  getentPath: GETENT,
  socketRoot: SOCKET_ROOT,
  socketOwner: SOCKET_OWNER,
  authHeader: AUTH_HEADER,
  publicPrefix: PUBLIC_PREFIX,
  defaultStartupMs: DEFAULT_STARTUP_MS,
  defaultLifetimeMs: DEFAULT_LIFETIME_MS,
  defaultKillGraceMs: DEFAULT_KILL_GRACE_MS,
  defaultMaxSessions: DEFAULT_MAX_SESSIONS,
  defaultMaxUserSessions: DEFAULT_MAX_USER_SESSIONS,
  sessionIdPattern: SESSION_ID_PATTERN,
  parsePasswd,
  parseGroup,
  ttydArgs,
  publicSession,
});
