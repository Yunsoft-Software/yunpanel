import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elFinderNginxTemplatePolicy,
  renderElFinderNginxConfig,
} from '@yunpanel/config-templates';
import {
  createElFinderNginxGatewayManager,
  ElFinderNginxGatewayError,
  elFinderNginxGatewayInternals,
} from '../src/elfinder-nginx-gateway-manager.js';

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function record(type, { content = Buffer.alloc(0), uid = 0, gid = 0, mode } = {}) {
  return {
    type,
    content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content)),
    uid,
    gid,
    mode: mode ?? (type === 'dir' ? 0o755 : type === 'socket' ? 0o660 : 0o644),
  };
}

function statOf(item) {
  return {
    uid: item.uid,
    gid: item.gid,
    mode: item.mode,
    isFile: () => item.type === 'file',
    isDirectory: () => item.type === 'dir',
    isSocket: () => item.type === 'socket',
    isSymbolicLink: () => item.type === 'symlink',
  };
}

function fixture({
  previousConfig = null,
  missingAsset = null,
  failFirstConfigTest = false,
  healthFails = false,
  delayedSocket = false,
} = {}) {
  const calls = [];
  const fs = new Map();
  let active = true;
  let failConfig = failFirstConfigTest;
  let socketPending = false;

  fs.set('/etc/nginx/sites-enabled', record('dir', { mode: 0o755 }));
  fs.set('/run/yunpanel', record('dir', { gid: 995, mode: 0o2770 }));
  for (const asset of elFinderNginxGatewayInternals.requiredAssets) {
    if (asset !== missingAsset) fs.set(asset, record('file', { mode: 0o644 }));
  }
  if (previousConfig !== null) {
    fs.set(elFinderNginxTemplatePolicy.configPath, record('file', {
      content: previousConfig,
      mode: elFinderNginxTemplatePolicy.configMode,
    }));
  }

  const run = async (file, args) => {
    calls.push(['run', file, [...args]]);
    if (file === '/usr/bin/getent') return { stdout: 'yunpanel:x:995:\n', stderr: '' };
    if (file === '/usr/sbin/nginx') {
      if (failConfig) {
        failConfig = false;
        throw new Error('invalid config');
      }
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/systemctl' && args[0] === 'is-active') {
      if (!active) throw new Error('inactive');
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/systemctl' && ['reload', 'enable'].includes(args[0])) {
      active = true;
      if (delayedSocket) socketPending = true;
      else fs.set(elFinderNginxTemplatePolicy.gatewaySocketPath, record('socket', {
        uid: 0, gid: 0, mode: 0o755,
      }));
      return { stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/curl') {
      if (healthFails) throw new Error('health failed');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };

  const lstatFn = async (target) => {
    const item = fs.get(target);
    if (!item) throw enoent();
    return statOf(item);
  };
  const readFileFn = async (target, encoding) => {
    const item = fs.get(target);
    if (!item || item.type !== 'file') throw enoent();
    return encoding ? item.content.toString(encoding) : Buffer.from(item.content);
  };
  const mkdirFn = async (target, options = {}) => {
    calls.push(['mkdir', target, options.mode]);
    fs.set(target, record('dir', { mode: options.mode ?? 0o755 }));
  };
  const writeFileFn = async (target, value, options = {}) => {
    if (options.flag === 'wx' && fs.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    calls.push(['write', target, options.mode]);
    fs.set(target, record('file', { content: value, mode: options.mode ?? 0o666 }));
  };
  const renameFn = async (from, to) => {
    const item = fs.get(from);
    if (!item) throw enoent();
    fs.set(to, item);
    fs.delete(from);
  };
  const rmFn = async (target) => {
    fs.delete(target);
  };
  const chmodFn = async (target, mode) => {
    const item = fs.get(target);
    if (!item) throw enoent();
    item.mode = mode;
  };
  const chownFn = async (target, uid, gid) => {
    const item = fs.get(target);
    if (!item) throw enoent();
    item.uid = uid;
    item.gid = gid;
  };
  const sleepFn = async (milliseconds) => {
    calls.push(['sleep', milliseconds]);
    if (socketPending) {
      fs.set(elFinderNginxTemplatePolicy.gatewaySocketPath, record('socket', {
        uid: 0, gid: 0, mode: 0o755,
      }));
      socketPending = false;
    }
  };

  const manager = createElFinderNginxGatewayManager({
    stateRoot: '/state/elfinder-nginx',
    run,
    lstatFn,
    readFileFn,
    mkdirFn,
    writeFileFn,
    renameFn,
    rmFn,
    chmodFn,
    chownFn,
    sleepFn,
  });
  return { manager, fs, calls };
}

test('elFinder gateway apply atomically installs generated Nginx config and proves private socket health', async () => {
  const fx = fixture();
  const result = await fx.manager.apply();

  assert.equal(result.satisfied, true);
  assert.equal(result.applied, true);
  assert.equal(result.gatewaySocketPath, '/run/yunpanel/elfinder-http.sock');
  assert.equal(
    fx.fs.get(elFinderNginxTemplatePolicy.configPath).content.toString(),
    renderElFinderNginxConfig(),
  );
  const socket = fx.fs.get(elFinderNginxTemplatePolicy.gatewaySocketPath);
  assert.equal(socket.type, 'socket');
  assert.equal(socket.uid, 0);
  assert.equal(socket.gid, 995);
  assert.equal(socket.mode, 0o660);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/nginx' && entry[2][0] === '-t'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/systemctl' && entry[2][0] === 'reload'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/curl' && entry[2].includes('--unix-socket')));

  const stateDirectories = [...fx.fs.keys()].filter((item) => item.startsWith('/state/elfinder-nginx/'));
  assert.ok(stateDirectories.some((item) => item.endsWith('/manifest.json')));
});

test('elFinder gateway waits for Nginx reload to bind the private Unix listener', async () => {
  const fx = fixture({ delayedSocket: true });
  const result = await fx.manager.apply();
  assert.equal(result.satisfied, true);
  assert.ok(fx.calls.some((entry) => entry[0] === 'sleep' && entry[1] === 100));
  assert.equal(fx.fs.get(elFinderNginxTemplatePolicy.gatewaySocketPath).mode, 0o660);
});

test('elFinder gateway configtest failure restores exact previous config before returning failure', async () => {
  const previous = 'server { listen unix:/run/yunpanel/old-elfinder.sock; }\n';
  const fx = fixture({ previousConfig: previous, failFirstConfigTest: true });

  await assert.rejects(
    fx.manager.apply(),
    (error) => error instanceof ElFinderNginxGatewayError
      && error.code === 'elfinder_gateway_config_invalid',
  );

  const restored = fx.fs.get(elFinderNginxTemplatePolicy.configPath);
  assert.equal(restored.content.toString(), previous);
  assert.equal(restored.mode, elFinderNginxTemplatePolicy.configMode);
  const reloads = fx.calls.filter((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/systemctl' && entry[2][0] === 'reload');
  assert.equal(reloads.length, 1);
});

test('elFinder gateway rejects unsafe snapshot directories before live config mutation', async () => {
  const fx = fixture();
  fx.fs.set('/state/elfinder-nginx', record('symlink', { mode: 0o777 }));

  await assert.rejects(
    fx.manager.apply(),
    (error) => error instanceof ElFinderNginxGatewayError
      && error.code === 'elfinder_gateway_state_directory_unsafe',
  );
  assert.equal(fx.fs.has(elFinderNginxTemplatePolicy.configPath), false);
});

test('elFinder gateway missing shared asset fails before Nginx config mutation', async () => {
  const missingAsset = elFinderNginxGatewayInternals.requiredAssets[0];
  const fx = fixture({ missingAsset });

  await assert.rejects(
    fx.manager.apply(),
    (error) => error instanceof ElFinderNginxGatewayError
      && error.code === 'elfinder_gateway_asset_missing',
  );
  assert.equal(fx.fs.has(elFinderNginxTemplatePolicy.configPath), false);
  assert.equal(fx.calls.some((entry) => entry[0] === 'write'
    && entry[1].includes('yunpanel-elfinder.conf')), false);
});

test('elFinder gateway health failure rolls a fresh install back to previous absence', async () => {
  const fx = fixture({ healthFails: true });

  await assert.rejects(
    fx.manager.apply(),
    (error) => error instanceof ElFinderNginxGatewayError
      && error.code === 'elfinder_gateway_health_failed',
  );

  assert.equal(fx.fs.has(elFinderNginxTemplatePolicy.configPath), false);
  assert.ok(fx.calls.filter((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/systemctl' && entry[2][0] === 'reload').length >= 2);
});
