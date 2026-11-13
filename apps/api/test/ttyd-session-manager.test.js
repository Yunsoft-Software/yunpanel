import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';
import {
  createTtydSessionManager,
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
    chmodFn: async (targetPath, mode) => {
      const item = fs.get(targetPath);
      if (item) item.mode = mode;
    },
    chownFn: async (targetPath, uid, gid) => {
      const item = fs.get(targetPath);
      if (item) {
        item.uid = uid;
        item.gid = gid;
      }
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

test('T898 pure ttyd site argv retains one private socket, site UID and fixed shell without caller commands', () => {
  const args = ttydSessionInternals.ttydArgs({ sessionId,
    socketPath: `/run/yunpanel/ttyd/${sessionId}.sock`,
    resolved: { cwd: siteTarget.cwd, user: siteUser, uid: 901, gid: 902,
      directFile: '/bin/bash', directArgs: ['--noprofile', '--norc', '-i'] } });
  assert.deepEqual(args.slice(0, 19), [
    '--interface', `/run/yunpanel/ttyd/${sessionId}.sock`, '--socket-owner', 'yunpanel:yunpanel',
    '--writable', '--check-origin', '--max-clients', '1', '--once', '--signal', '1',
    '--cwd', siteTarget.cwd, '--base-path', `/tools/ttyd/${sessionId}`,
    '--auth-header', 'X-YunPanel-TTYD-Auth', '--terminal-type', 'xterm-256color',
  ]);
  assert.equal(args[args.indexOf('--uid') + 1], '901');
  assert.equal(args[args.indexOf('--gid') + 1], '902');
  assert.deepEqual(args.slice(-4), ['/bin/bash', '--noprofile', '--norc', '-i']);
  for (const flag of ['--url-arg', '--credential', '--port', '/usr/sbin/runuser']) assert.equal(args.includes(flag), false);
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

// Real child, connected/unconnected socket, revocation, explicit close and real
// 60-second startup expiration acceptance lives in native20. The removed fake
// PID4321/EventEmitter/fs-map site outcomes cannot attest any of those results.
test('T898 real runtime admission rejects a fenced site before any dependency or process starts', async () => {
  const liveSessions = createLiveSessionRegistry();
  liveSessions.reserveWebsiteRemoval(websiteId);
  const manager = createTtydSessionManager({ liveSessions });
  await assert.rejects(manager.start({ ownerSessionId: 'owner-session', userId: 'owner-user', target: siteTarget }),
    { code: process.getuid?.() === 0 ? 'terminal_website_removing' : 'ttyd_root_runtime_required' });
  assert.equal(manager.size(), 0);
  assert.equal(liveSessions.websiteLifecycleSize(websiteId), 0);
  assert.equal(manager.authorize(sessionId, { ownerSessionId: 'owner-session', userId: 'owner-user' }), null);
  assert.equal(manager.terminateOwned(sessionId, { ownerSessionId: 'other-session', userId: 'owner-user' }), false);
});

test('T898 identity policy rejects root gateway accounts and malformed UID/GID values', () => {
  assert.equal(ttydSessionInternals.parsePasswd('yunpanel:x:0:995::/var/lib/yunpanel:/usr/sbin/nologin', 'yunpanel'), null);
  assert.equal(ttydSessionInternals.parsePasswd('foreign:x:995:995::/var/lib/yunpanel:/usr/sbin/nologin', 'yunpanel'), null);
  assert.equal(ttydSessionInternals.parseGroup('yunpanel:x:0:', 'yunpanel'), null);
  assert.equal(ttydSessionInternals.parseGroup('yunpanel:x:not-a-gid:', 'yunpanel'), null);
  assert.deepEqual(ttydSessionInternals.parsePasswd('yunpanel:x:995:995::/var/lib/yunpanel:/usr/sbin/nologin', 'yunpanel'), { uid: 995, gid: 995 });
  assert.deepEqual(ttydSessionInternals.parseGroup('yunpanel:x:995:', 'yunpanel'), { gid: 995 });
  assert.throws(() => createTtydSessionManager({ maxSessions: 1, maxUserSessions: 2 }), TypeError);
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
