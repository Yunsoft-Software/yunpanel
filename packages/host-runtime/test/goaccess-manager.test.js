import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoAccessManager, GoAccessManagerError } from '../src/index.js';

test('inspectGoAccess returns version when goaccess binary is available', async () => {
  const manager = createGoAccessManager({
    execFn: async (file, args) => {
      assert.equal(file, '/usr/bin/goaccess');
      assert.deepEqual(args, ['--version']);
      return { stdout: 'GoAccess - 1.8.1.\nFor more details visit: https://goaccess.io/\n' };
    },
  });

  const result = await manager.inspectGoAccess();
  assert.equal(result.satisfied, true);
  assert.equal(result.version, '1.8.1');
  assert.equal(result.binaryPath, '/usr/bin/goaccess');
});

test('inspectGoAccess returns satisfied=false when binary is missing or fails', async () => {
  const manager = createGoAccessManager({
    execFn: async () => {
      throw new Error('command not found');
    },
  });

  const result = await manager.inspectGoAccess();
  assert.equal(result.satisfied, false);
  assert.equal(result.version, null);
});

test('generateStaticReport generates point-in-time report for a website', async () => {
  const calls = [];
  const files = new Map();

  const manager = createGoAccessManager({
    reportsDir: '/var/lib/yunpanel/reports/goaccess',
    nginxLogDir: '/var/log/nginx',
    statFn: async (target) => {
      if (files.has(target)) return { isFile: () => true };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    mkdirFn: async (dir) => { calls.push(['mkdir', dir]); },
    writeFileFn: async (target, content) => { files.set(target, content); calls.push(['writeFile', target]); },
    execFn: async (file, args) => {
      calls.push(['exec', file, args]);
      return { stdout: '' };
    },
  });

  const result = await manager.generateStaticReport({
    websiteId: 'site-alpha',
    primaryDomain: 'example.com',
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.websiteId, 'site-alpha');
  assert.equal(result.primaryDomain, 'example.com');
  assert.equal(result.logPath, '/var/log/nginx/example.com.access.log');
  assert.equal(result.outputPath, '/var/lib/yunpanel/reports/goaccess/site-alpha.html');

  // Should have ensured log file exists and executed goaccess
  assert.equal(calls.some(([op, target]) => op === 'writeFile' && target === '/var/log/nginx/example.com.access.log'), true);
  assert.equal(calls.some(([op, , args]) => op === 'exec' && args[0] === '/var/log/nginx/example.com.access.log' && args[1] === '-o' && args[2] === '/var/lib/yunpanel/reports/goaccess/site-alpha.html'), true);
});

test('startRealtimeDaemon, inspectDaemon and stopRealtimeDaemon manage daemon lifecycle', async () => {
  const calls = [];
  const files = new Map();
  const activePids = new Set();

  const manager = createGoAccessManager({
    socketRoot: '/run/yunpanel/goaccess',
    reportsDir: '/var/lib/yunpanel/reports/goaccess',
    nginxLogDir: '/var/log/nginx',
    statFn: async (target) => {
      if (files.has(target)) return { isFile: () => true };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    mkdirFn: async (dir) => { calls.push(['mkdir', dir]); },
    writeFileFn: async (target, content) => { files.set(target, content); calls.push(['writeFile', target]); },
    readFileFn: async (target) => {
      if (files.has(target)) return files.get(target);
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    unlinkFn: async (target) => {
      files.delete(target);
      calls.push(['unlink', target]);
    },
    execFn: async (file, args) => {
      calls.push(['exec', file, args]);
      // Simulate daemonizing: write pid and socket
      const pidArg = args.find((a) => a.startsWith('--pid-file='));
      const sockArg = args.find((a) => a.startsWith('--unix-socket='));
      const pidPath = pidArg.split('=')[1];
      const sockPath = sockArg.split('=')[1];
      files.set(pidPath, '12345\n');
      files.set(sockPath, '');
      activePids.add(12345);
      return { stdout: 'Daemonized GoAccess: 12345\n' };
    },
    killFn: (pid, signal) => {
      calls.push(['kill', pid, signal]);
      if (signal === 0) {
        if (!activePids.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return true;
      }
      if (signal === 'SIGTERM') {
        activePids.delete(pid);
        return true;
      }
    },
  });

  // Start daemon
  const startResult = await manager.startRealtimeDaemon({
    websiteId: 'site-beta',
    primaryDomain: 'beta.example.com',
  });

  assert.equal(startResult.running, true);
  assert.equal(startResult.alreadyRunning, false);
  assert.equal(startResult.pid, 12345);
  assert.equal(startResult.socketPath, '/run/yunpanel/goaccess/site-beta.sock');
  assert.equal(startResult.outputPath, '/var/lib/yunpanel/reports/goaccess/site-beta.html');

  // Inspect daemon
  const status = await manager.inspectDaemon({ websiteId: 'site-beta' });
  assert.equal(status.running, true);
  assert.equal(status.pid, 12345);
  assert.equal(status.socketExists, true);

  // Stop daemon
  const stopResult = await manager.stopRealtimeDaemon({ websiteId: 'site-beta' });
  assert.equal(stopResult.stopped, true);
  assert.equal(stopResult.pid, 12345);

  // Inspect daemon after stop
  const statusAfter = await manager.inspectDaemon({ websiteId: 'site-beta' });
  assert.equal(statusAfter.running, false);
  assert.equal(statusAfter.pid, null);
});

test('createGoAccessManager validates inputs and rejects invalid paths/ids', async () => {
  const manager = createGoAccessManager();

  await assert.rejects(
    () => manager.generateStaticReport({ websiteId: '../bad' }),
    (error) => error instanceof GoAccessManagerError && error.code === 'invalid_id',
  );
  await assert.rejects(
    () => manager.startRealtimeDaemon({ websiteId: 'site-1', logPath: 'relative/log.log' }),
    (error) => error instanceof GoAccessManagerError && error.code === 'invalid_path',
  );
  await assert.rejects(
    () => manager.inspectDaemon({ websiteId: 'site-1', socketPath: '/tmp/../etc/bad.sock' }),
    (error) => error instanceof GoAccessManagerError && error.code === 'invalid_path',
  );
});
