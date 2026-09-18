import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import {
  createTtydSessionManager,
  TtydSessionError,
  ttydSessionInternals,
} from '../src/ttyd-session-manager.js';

const sessionId = '12345678-1234-4234-8234-123456789012';
const applicationId = '22345678-1234-4234-8234-123456789012';
const releaseId = '32345678-1234-4234-8234-123456789012';
const websiteId = '42345678-1234-4234-8234-123456789012';
const siteUser = 'yunapp-123456789abc';
const siteTarget = Object.freeze({
  scope: 'site',
  serverId: 'local',
  websiteId,
  user: siteUser,
  cwd: `/var/lib/yunpanel/apps/${applicationId}/current`,
});
const rootTarget = Object.freeze({
  scope: 'server',
  serverId: 'local',
  user: 'root',
  cwd: '/root',
});

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function directory({ uid = 0, gid = 995, mode = 0o2770 } = {}) {
  return {
    uid, gid, mode,
    isDirectory: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

function socket({ uid = 995, gid = 995, mode = 0o660 } = {}) {
  return {
    uid, gid, mode,
    isDirectory: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

function fixture({
  target = siteTarget,
  liveSessions = null,
  socketRootStat = directory(),
  runtimeReady = true,
  getuid = () => 0,
  maxSessions = 20,
  maxUserSessions = 5,
} = {}) {
  const calls = {
    spawn: [],
    signals: [],
    rm: [],
    timers: [],
  };
  const fs = new Map([
    [ttydSessionInternals.socketRoot, socketRootStat],
  ]);
  let child;
  const runtimeManager = {
    async apply() {
      return runtimeReady
        ? {
            satisfied: true,
            binaryPath: '/usr/bin/ttyd',
            binaryVersion: '1.7.4',
            distroServiceMasked: true,
            distroServiceActive: false,
          }
        : { satisfied: false };
    },
  };
  const run = async (file, args) => {
    if (file !== '/usr/bin/getent') throw new Error('unexpected command');
    if (args[0] === 'passwd') return { stdout: 'yunpanel:x:995:995::/var/lib/yunpanel:/usr/sbin/nologin\n' };
    if (args[0] === 'group') return { stdout: 'yunpanel:x:995:\n' };
    throw new Error('unexpected getent');
  };
  const spawnProcess = (file, args, options) => {
    calls.spawn.push({ file, args: [...args], options });
    child = new EventEmitter();
    child.pid = 4321;
    child.kill = (signal) => calls.signals.push(['fallback', signal]);
    const socketPath = args[args.indexOf('--interface') + 1];
    fs.set(socketPath, socket());
    return child;
  };
  const timers = [];
  const setTimer = (callback, ms) => {
    const timer = { callback, ms, cleared: false, unref() {} };
    timers.push(timer);
    calls.timers.push(ms);
    return timer;
  };
  const clearTimer = (timer) => { if (timer) timer.cleared = true; };
  const manager = createTtydSessionManager({
    runtimeManager,
    liveSessions,
    spawnProcess,
    run,
    statFn: async () => ({ isDirectory: () => true }),
    realpathFn: async (value) => value === '/root'
      ? '/root'
      : `/var/lib/yunpanel/apps/${applicationId}/releases/${releaseId}`,
    readPasswd: async () => `${siteUser}:x:901:902::/var/lib/yunpanel/data/${applicationId}:/usr/sbin/nologin\n`,
    lstatFn: async (targetPath) => {
      const value = fs.get(targetPath);
      if (!value) throw enoent();
      return value;
    },
    mkdirFn: async (targetPath) => {
      fs.set(targetPath, directory());
    },
    rmFn: async (targetPath) => {
      calls.rm.push(targetPath);
      fs.delete(targetPath);
    },
    getuid,
    killProcessGroup: (pid, signal) => calls.signals.push([pid, signal]),
    randomId: () => sessionId,
    setTimer,
    clearTimer,
    startupMs: 60_000,
    lifetimeMs: 4 * 60 * 60_000,
    killGraceMs: 2_000,
    maxSessions,
    maxUserSessions,
  });
  return { manager, calls, fs, timers, get child() { return child; }, target };
}

test('ttyd one-shot site session uses only a private Unix socket and fixed safe argv', async () => {
  const fx = fixture();
  const result = await fx.manager.start({
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    target: siteTarget,
  });

  assert.equal(result.protocol, 'yunpanel-ttyd-v1');
  assert.equal(result.audience, 'terminal');
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.basePath, `/tools/ttyd/${sessionId}/`);
  assert.deepEqual(result.target, siteTarget);

  const spawnCall = fx.calls.spawn[0];
  assert.equal(spawnCall.file, '/usr/bin/ttyd');
  const args = spawnCall.args;
  assert.deepEqual(args.slice(0, 19), [
    '--interface', `/run/yunpanel/ttyd/${sessionId}.sock`,
    '--socket-owner', 'yunpanel:yunpanel',
    '--writable',
    '--check-origin',
    '--max-clients', '1',
    '--once',
    '--signal', '1',
    '--cwd', siteTarget.cwd,
    '--base-path', `/tools/ttyd/${sessionId}`,
    '--auth-header', 'X-YunPanel-TTYD-Auth',
    '--terminal-type', 'xterm-256color',
  ]);
  assert.ok(args.includes('--terminal-type'));
  assert.equal(args[args.indexOf('--uid') + 1], '901');
  assert.equal(args[args.indexOf('--gid') + 1], '902');
  assert.equal(args.includes('/usr/sbin/runuser'), false);
  assert.deepEqual(args.slice(-4), [
    '/bin/bash', '--noprofile', '--norc', '-i',
  ]);
  assert.equal(args.includes('--url-arg'), false);
  assert.equal(args.includes('--credential'), false);
  assert.equal(args.includes('--port'), false);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.cwd, siteTarget.cwd);
  assert.equal(spawnCall.options.env.HOME, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(spawnCall.options.env.YUNPANEL_SECRET_MASTER_KEY, undefined);

  const startupTimer = fx.timers.find((timer) => timer.ms === 60_000);
  const authorized = fx.manager.authorize(sessionId, {
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
  });
  assert.equal(authorized.socketPath, `/run/yunpanel/ttyd/${sessionId}.sock`);
  assert.equal(authorized.authHeader, 'X-YunPanel-TTYD-Auth');
  assert.equal(startupTimer.cleared, false);

  const websocketAuthorized = fx.manager.authorize(sessionId, {
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    markConnected: true,
  });
  assert.equal(websocketAuthorized.sessionId, sessionId);
  assert.equal(startupTimer.cleared, true);
  assert.equal(fx.manager.authorize(sessionId, {
    ownerSessionId: 'other-session',
    userId: 'owner-user',
  }), null);
});

test('ttyd root session runs fixed login shell without caller command arguments', async () => {
  const fx = fixture({ target: rootTarget });
  await fx.manager.start({
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    target: rootTarget,
  });
  const args = fx.calls.spawn[0].args;
  assert.deepEqual(args.slice(-2), ['/bin/bash', '--login']);
  assert.equal(args.includes('--uid'), false);
  assert.equal(args.includes('--gid'), false);
  assert.equal(fx.calls.spawn[0].options.cwd, '/root');
  assert.equal(fx.calls.spawn[0].options.env.HOME, '/root');
  assert.equal(fx.calls.spawn[0].options.env.USER, 'root');
});

test('ttyd session is bound to live Owner session and revocation kills the process group', async () => {
  const liveSessions = createLiveSessionRegistry();
  const fx = fixture({ liveSessions });
  await fx.manager.start({
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    target: siteTarget,
  });

  assert.equal(fx.manager.size(), 1);
  assert.equal(liveSessions.revokeSession('owner-session'), 1);
  assert.deepEqual(fx.calls.signals, [[4321, 'SIGHUP']]);
  assert.equal(fx.manager.authorize(sessionId, {
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
  }), null);

  const killTimer = fx.timers.find((timer) => timer.ms === 2_000);
  killTimer.callback();
  assert.deepEqual(fx.calls.signals, [[4321, 'SIGHUP'], [4321, 'SIGKILL']]);

  fx.child.emit('exit', 0, null);
  assert.equal(fx.manager.size(), 0);
  assert.ok(fx.calls.rm.includes(`/run/yunpanel/ttyd/${sessionId}.sock`));
});

test('ttyd explicit close is bound to the Owner session and user', async () => {
  const fx = fixture();
  await fx.manager.start({
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    target: siteTarget,
  });

  assert.equal(fx.manager.terminateOwned(sessionId, {
    ownerSessionId: 'other-session',
    userId: 'owner-user',
  }), false);
  assert.equal(fx.calls.signals.length, 0);

  assert.equal(fx.manager.terminateOwned(sessionId, {
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
  }), true);
  assert.deepEqual(fx.calls.signals, [[4321, 'SIGHUP']]);
  assert.equal(fx.manager.terminateOwned(sessionId, {
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
  }), false);
});

test('ttyd startup timeout closes a session that never reaches the gateway', async () => {
  const fx = fixture();
  await fx.manager.start({
    ownerSessionId: 'owner-session',
    userId: 'owner-user',
    target: siteTarget,
  });

  const startup = fx.timers.find((timer) => timer.ms === 60_000);
  assert.ok(startup);
  startup.callback();
  assert.deepEqual(fx.calls.signals, [[4321, 'SIGHUP']]);
});

test('ttyd session rejects unsafe runtime, socket root, non-root API and concurrency overflow', async () => {
  {
    const fx = fixture({ runtimeReady: false });
    await assert.rejects(
      fx.manager.start({ ownerSessionId: 'owner-session', userId: 'owner-user', target: siteTarget }),
      (error) => error instanceof TtydSessionError && error.code === 'ttyd_runtime_not_ready',
    );
    assert.equal(fx.calls.spawn.length, 0);
  }
  {
    const fx = fixture({ socketRootStat: directory({ gid: 0, mode: 0o755 }) });
    await assert.rejects(
      fx.manager.start({ ownerSessionId: 'owner-session', userId: 'owner-user', target: siteTarget }),
      (error) => error instanceof TtydSessionError && error.code === 'ttyd_socket_root_unsafe',
    );
    assert.equal(fx.calls.spawn.length, 0);
  }
  {
    const fx = fixture({ getuid: () => 1000 });
    await assert.rejects(
      fx.manager.start({ ownerSessionId: 'owner-session', userId: 'owner-user', target: siteTarget }),
      (error) => error instanceof TtydSessionError && error.code === 'ttyd_root_runtime_required',
    );
  }
  {
    const fx = fixture({ maxSessions: 1, maxUserSessions: 1 });
    await fx.manager.start({ ownerSessionId: 'owner-session', userId: 'owner-user', target: siteTarget });
    await assert.rejects(
      fx.manager.start({ ownerSessionId: 'owner-session-2', userId: 'owner-user', target: siteTarget }),
      (error) => error instanceof TtydSessionError && error.code === 'ttyd_session_limit',
    );
  }
});

test('ttyd argv policy pins one-shot writable origin-checked reverse-proxy mode', () => {
  const resolved = {
    cwd: '/root',
    user: 'root',
    uid: 0,
    gid: 0,
    directFile: '/bin/bash',
    directArgs: ['--login'],
  };
  const args = ttydSessionInternals.ttydArgs({
    sessionId,
    socketPath: `/run/yunpanel/ttyd/${sessionId}.sock`,
    resolved,
  });
  for (const expected of ['--writable', '--check-origin', '--once']) assert.ok(args.includes(expected));
  assert.equal(args[args.indexOf('--max-clients') + 1], '1');
  assert.equal(args[args.indexOf('--auth-header') + 1], 'X-YunPanel-TTYD-Auth');
  assert.equal(ttydSessionInternals.socketOwner, 'yunpanel:yunpanel');
  assert.equal(ttydSessionInternals.publicPrefix, '/tools/ttyd');
});
