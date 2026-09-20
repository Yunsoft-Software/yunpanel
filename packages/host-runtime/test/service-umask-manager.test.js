import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createServiceUmaskManager,
  ServiceUmaskManagerError,
  serviceUmaskManagerInternals,
} from '../src/service-umask-manager.js';

function missing(code = 'ENOENT') {
  const error = new Error('missing');
  error.code = code;
  return error;
}

function fakeHost({ active = true, effective = 0o022, processUmask = 0 } = {}) {
  const entries = new Map();
  const calls = [];
  const readFileFn = async (file) => {
    const entry = entries.get(file);
    if (!entry) throw missing();
    return entry.content;
  };
  const writeFileFn = async (file, content, options = {}) => {
    entries.set(file, { content: String(content), mode: (options.mode ?? 0o600) & ~processUmask, uid: 0, gid: 0, type: 'file' });
  };
  const chmodFn = async (file, mode) => {
    const entry = entries.get(file);
    if (!entry) throw missing();
    entry.mode = mode;
  };
  const renameFn = async (source, target) => {
    const entry = entries.get(source);
    if (!entry) throw missing();
    entries.set(target, entry);
    entries.delete(source);
  };
  const rmFn = async (file) => { entries.delete(file); };
  const lstatFn = async (file) => {
    const entry = entries.get(file);
    if (!entry) throw missing();
    return {
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode,
      isFile: () => entry.type === 'file',
      isSymbolicLink: () => false,
    };
  };
  const run = async (file, args) => {
    calls.push([file, [...args]]);
    assert.equal(file, '/usr/bin/systemctl');
    if (args[0] === 'is-active') {
      if (!active) throw missing(3);
      return { stdout: '' };
    }
    if (args[0] === 'show') return { stdout: `00${effective.toString(8)}\n` };
    if (args[0] === 'daemon-reload') return { stdout: '' };
    if (args[0] === 'restart') {
      active = true;
      effective = 0o027;
      return { stdout: '' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { entries, calls, lstatFn, readFileFn, writeFileFn, chmodFn, renameFn, rmFn, mkdirFn: async () => {}, run };
}

function manager(host) {
  return createServiceUmaskManager({
    run: host.run,
    lstatFn: host.lstatFn,
    readFileFn: host.readFileFn,
    writeFileFn: host.writeFileFn,
    chmodFn: host.chmodFn,
    renameFn: host.renameFn,
    rmFn: host.rmFn,
    mkdirFn: host.mkdirFn,
  });
}

test('service umask apply writes root-owned policy and restarts Passenger service once', async () => {
  const host = fakeHost();
  const result = await manager(host).apply('passenger');
  const file = serviceUmaskManagerInternals.dropInPath('nginx.service');

  assert.equal(result.satisfied, true);
  assert.equal(result.serviceUnit, 'nginx.service');
  assert.equal(result.umask, '0027');
  assert.equal(result.created, true);
  assert.equal(host.entries.get(file).mode, 0o644);
  assert.equal(host.entries.get(file).content, '[Service]\nUMask=0027\n');
  assert.equal(host.calls.some(([, args]) => args[0] === 'daemon-reload'), true);
  assert.equal(host.calls.some(([, args]) => args[0] === 'restart' && args[1] === 'nginx.service'), true);
});

test('service umask drop-in keeps exact mode under restrictive root process umask', async () => {
  const host = fakeHost({ processUmask: 0o027 });
  const result = await manager(host).apply('php');
  const file = serviceUmaskManagerInternals.dropInPath('php8.3-fpm.service');
  assert.equal(result.satisfied, true);
  assert.equal(host.entries.get(file).mode, 0o644);
});

test('service umask apply is idempotent when policy is already effective', async () => {
  const host = fakeHost({ effective: 0o027 });
  const file = serviceUmaskManagerInternals.dropInPath('php8.3-fpm.service');
  host.entries.set(file, { content: '[Service]\nUMask=0027\n', mode: 0o644, uid: 0, gid: 0, type: 'file' });

  const result = await manager(host).apply('php');
  assert.equal(result.satisfied, true);
  assert.equal(host.calls.some(([, args]) => args[0] === 'restart'), false);
});

test('service umask refuses to overwrite a foreign drop-in', async () => {
  const host = fakeHost();
  const file = serviceUmaskManagerInternals.dropInPath('nginx.service');
  host.entries.set(file, { content: '[Service]\nUMask=0077\n', mode: 0o644, uid: 0, gid: 0, type: 'file' });

  await assert.rejects(
    manager(host).apply('passenger'),
    (error) => error instanceof ServiceUmaskManagerError && error.code === 'service_umask_config_conflict',
  );
  assert.equal(host.entries.get(file).content, '[Service]\nUMask=0077\n');
});

test('service umask inspect reports inactive services without claiming readiness', async () => {
  const host = fakeHost({ active: false, effective: 0o027 });
  const file = serviceUmaskManagerInternals.dropInPath('nginx.service');
  host.entries.set(file, { content: '[Service]\nUMask=0027\n', mode: 0o644, uid: 0, gid: 0, type: 'file' });

  const result = await manager(host).inspect('passenger');
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'service_umask_service_inactive');
});
