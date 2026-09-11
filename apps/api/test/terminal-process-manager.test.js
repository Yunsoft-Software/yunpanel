import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalProcessManager } from '../src/terminal-process-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce8';
const RELEASE_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const siteTarget = Object.freeze({
  scope: 'site', serverId: 'local', websiteId: 'website-1', user: 'yunapp-123456789abc',
  cwd: `/var/lib/yunpanel/apps/${APPLICATION_ID}/current`,
});

function fixture(overrides = {}) {
  const calls = { spawn: [], writes: [], resizes: [], signals: [] };
  let dataHandler;
  let exitHandler;
  const child = {
    pid: 321,
    onData(handler) { dataHandler = handler; return { dispose() {} }; },
    onExit(handler) { exitHandler = handler; return { dispose() {} }; },
    write(data) { calls.writes.push(data); },
    resize(cols, rows) { calls.resizes.push([cols, rows]); },
    kill(signal) { calls.signals.push(['fallback', signal]); },
  };
  const manager = createTerminalProcessManager({
    spawnPty(file, args, options) { calls.spawn.push({ file, args, options }); return child; },
    statFn: async () => ({ isDirectory: () => true }),
    realpathFn: async (value) => (value === '/root' ? '/root' : `/var/lib/yunpanel/apps/${APPLICATION_ID}/releases/${RELEASE_ID}`),
    readPasswd: async () => 'yunapp-123456789abc:x:901:902::/var/lib/yunpanel/data/application:/usr/sbin/nologin\n',
    getuid: () => 0,
    killProcessGroup: (pid, signal) => calls.signals.push([pid, signal]),
    setTimer: overrides.setTimer ?? (() => ({ unref() {} })),
    clearTimer() {},
    ...overrides,
  });
  return { manager, calls, emitData: (data) => dataHandler(data), emitExit: (event) => exitHandler(event) };
}

test('root terminal starts a login shell with a fixed secret-free environment', async () => {
  const fx = fixture();
  const output = [];
  const exits = [];
  const terminal = await fx.manager.open({
    target: { scope: 'server', serverId: 'local', user: 'root', cwd: '/root' },
    onData: (data) => output.push(data), onExit: (event) => exits.push(event),
  });
  assert.equal(terminal.pid, 321);
  assert.deepEqual(fx.calls.spawn[0], {
    file: '/bin/bash',
    args: ['--login'],
    options: {
      name: 'xterm-256color', cols: 120, rows: 30, cwd: '/root',
      env: {
        COLORTERM: 'truecolor', HOME: '/root', LANG: 'C.UTF-8', LOGNAME: 'root',
        PATH: '/usr/local/bin:/usr/bin:/bin', SHELL: '/bin/bash', TERM: 'xterm-256color', USER: 'root',
      },
    },
  });
  assert.equal(fx.calls.spawn[0].options.env.YUNPANEL_SECRET_MASTER_KEY, undefined);
  fx.emitData('\u001b[31mmerhaba 世界\u001b[0m');
  assert.deepEqual(output, ['\u001b[31mmerhaba 世界\u001b[0m']);
  fx.emitExit({ exitCode: 0, signal: 0 });
  assert.deepEqual(exits, [{ exitCode: 0, signal: 0 }]);
});

test('site terminal resolves the managed release and uses runuser to establish Unix groups', async () => {
  const fx = fixture();
  const terminal = await fx.manager.open({ target: siteTarget, cols: 90, rows: 25, onData() {}, onExit() {} });
  assert.deepEqual(fx.calls.spawn[0].args, [
    '-u', 'yunapp-123456789abc', '--', '/bin/bash', '--noprofile', '--norc', '-i',
  ]);
  assert.equal(fx.calls.spawn[0].file, '/usr/sbin/runuser');
  assert.equal(fx.calls.spawn[0].options.cwd, siteTarget.cwd);
  assert.equal(fx.calls.spawn[0].options.env.HOME, '/var/lib/yunpanel/data/application');
  terminal.write('printf "çalıştı\\n"\r');
  terminal.write('\u0003');
  terminal.resize(132, 44);
  assert.deepEqual(fx.calls.writes, ['printf "çalıştı\\n"\r', '\u0003']);
  assert.deepEqual(fx.calls.resizes, [[132, 44]]);
});

test('site symlink escape, malformed account and non-root panel runtime fail closed before spawn', async () => {
  const escaped = fixture({ realpathFn: async () => '/etc' });
  await assert.rejects(escaped.manager.open({ target: siteTarget, onData() {}, onExit() {} }), { code: 'site_terminal_directory_escape' });
  assert.equal(escaped.calls.spawn.length, 0);

  const missing = fixture({ readPasswd: async () => '' });
  await assert.rejects(missing.manager.open({ target: siteTarget, onData() {}, onExit() {} }), { code: 'site_terminal_account_missing' });
  const ordinary = fixture({ getuid: () => 1000 });
  await assert.rejects(ordinary.manager.open({ target: siteTarget, onData() {}, onExit() {} }), { code: 'terminal_root_runtime_required' });
});

test('input and resize limits are enforced and close terminates the whole process group', async () => {
  let forceKill;
  const fx = fixture({ setTimer: (callback) => { forceKill = callback; return { unref() {} }; } });
  const terminal = await fx.manager.open({ target: siteTarget, onData() {}, onExit() {} });
  assert.throws(() => terminal.write('x'.repeat(16 * 1024 + 1)), { code: 'terminal_input_invalid' });
  assert.throws(() => terminal.resize(1, 1), { code: 'terminal_dimensions_invalid' });
  assert.equal(terminal.close(), true);
  assert.equal(terminal.close(), false);
  assert.deepEqual(fx.calls.signals, [[321, 'SIGHUP']]);
  forceKill();
  assert.deepEqual(fx.calls.signals, [[321, 'SIGHUP'], [321, 'SIGKILL']]);
  assert.throws(() => terminal.write('id\r'), { code: 'terminal_closed' });
});
