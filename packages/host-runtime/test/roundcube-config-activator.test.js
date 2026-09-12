import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  roundcubeFpmTemplatePolicy,
  roundcubeNginxTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';
import {
  createRoundcubeConfigActivator,
  RoundcubeConfigActivationError,
} from '../src/roundcube-config-activator.js';

const TX = '12345678-1234-4234-8234-123456789012';
const CONFIG = Buffer.from('<?php $config = [];\n');
const FPM = Buffer.from('[yunpanel-roundcube]\n');
const NGINX = Buffer.from('server { listen 443 ssl; }\n');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const CONFIG_SHA = sha256(CONFIG);
const FPM_SHA = sha256(FPM);
const NGINX_SHA = sha256(NGINX);
const PREVIEW_SHA = 'c'.repeat(64);

function preview() {
  return {
    version: 1,
    readyToApply: true,
    sha256: PREVIEW_SHA,
    mailHostname: 'mail.example.com',
    configSha256: CONFIG_SHA,
    fpmSha256: FPM_SHA,
    nginxSha256: NGINX_SHA,
    configuration: {
      version: 1,
      sha256: CONFIG_SHA,
      artifact: {
        path: roundcubeTemplatePolicy.configPath,
        sha256: CONFIG_SHA,
        bytes: CONFIG.length,
        sensitive: true,
        mode: roundcubeTemplatePolicy.configMode,
      },
      databasePath: roundcubeTemplatePolicy.databasePath,
      databaseSchemaPath: roundcubeTemplatePolicy.databaseSchemaPath,
      temporaryDirectory: roundcubeTemplatePolicy.temporaryDirectory,
    },
    fpm: {
      version: 1,
      sha256: FPM_SHA,
      artifact: {
        path: roundcubeFpmTemplatePolicy.poolPath,
        sha256: FPM_SHA,
        bytes: FPM.length,
        sensitive: false,
        mode: roundcubeFpmTemplatePolicy.poolMode,
      },
      socketPath: roundcubeFpmTemplatePolicy.socketPath,
      serviceUnit: roundcubeFpmTemplatePolicy.serviceUnit,
    },
    nginx: {
      version: 1,
      sha256: NGINX_SHA,
      artifact: {
        path: roundcubeNginxTemplatePolicy.configPath,
        sha256: NGINX_SHA,
        bytes: NGINX.length,
        sensitive: false,
        mode: roundcubeNginxTemplatePolicy.configMode,
      },
      webHostname: 'mail.example.com',
      publicRoot: roundcubeNginxTemplatePolicy.publicRoot,
      fpmSocketPath: roundcubeFpmTemplatePolicy.socketPath,
      serviceUnit: roundcubeNginxTemplatePolicy.serviceUnit,
      healthPath: roundcubeNginxTemplatePolicy.healthPath,
      endpoint: 'https://mail.example.com/',
    },
  };
}

function directory({ uid = 0, gid = 0, mode = 0o755 } = {}) {
  return {
    uid, gid, mode,
    isDirectory: () => true,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

function file({ uid = 0, gid = 0, mode = 0o600, size = 1 } = {}) {
  return {
    uid, gid, mode, size,
    isDirectory: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

function socket({ uid = 33, gid = 33, mode = 0o660 } = {}) {
  return {
    uid, gid, mode,
    isDirectory: () => false,
    isFile: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fixture({ existingDatabase = false, failFirstFpmValidation = false, groups = 'yunpanel-roundcube www-data' } = {}) {
  const calls = [];
  const state = {
    databaseExists: existingDatabase,
    databaseUid: 2001,
    databaseGid: 2001,
    databaseMode: 0o600,
    failFpm: failFirstFpmValidation,
    restored: false,
  };
  const manifest = {
    version: 2,
    transactionId: TX,
    databaseExisted: existingDatabase,
    files: [
      { targetPath: roundcubeTemplatePolicy.configPath, exists: false, backupName: null },
      { targetPath: roundcubeFpmTemplatePolicy.poolPath, exists: false, backupName: null },
      { targetPath: roundcubeNginxTemplatePolicy.configPath, exists: false, backupName: null },
    ],
  };
  const configManager = {
    inspectStagedConfiguration: async () => ({ satisfied: true, result: {} }),
    inspectStagedFpmPool: async () => ({ satisfied: true, result: {} }),
    inspectStagedNginxConfig: async () => ({ satisfied: true, result: {} }),
    stagedConfigPath: () => '/stage/config.inc.php',
    stagedFpmPath: () => '/stage/yunpanel-roundcube-fpm.conf',
    stagedNginxPath: () => '/stage/yunpanel-roundcube-nginx.conf',
  };
  const backupManager = {
    async backupConfiguration(id) { calls.push(['backup', id]); return manifest; },
    async loadManifest(id) { calls.push(['manifest', id]); return manifest; },
    async restoreConfiguration(id) {
      calls.push(['restore', id]);
      state.restored = true;
      state.databaseExists = manifest.databaseExisted;
      return manifest;
    },
  };
  const run = async (command, args, options = {}) => {
    calls.push(['run', command, [...args], { uid: options.uid, gid: options.gid }]);
    if (command === '/usr/bin/getent') {
      if (args[1] === 'yunpanel-roundcube') return { stdout: 'yunpanel-roundcube:x:2001:2001::/var/lib/yunpanel/roundcube:/usr/sbin/nologin\n' };
      if (args[1] === 'www-data') return { stdout: 'www-data:x:33:33::/var/www:/usr/sbin/nologin\n' };
    }
    if (command === '/usr/bin/id') return { stdout: `${groups}\n` };
    if (command === '/usr/bin/sqlite3') {
      if (args[1].startsWith('.read ')) {
        state.databaseExists = true;
        state.databaseUid = 0;
        state.databaseGid = 0;
        state.databaseMode = 0o600;
        return { stdout: '' };
      }
      if (args[1] === 'PRAGMA quick_check;') return { stdout: 'ok\n' };
    }
    if (command === '/usr/sbin/php-fpm8.3' && state.failFpm) {
      state.failFpm = false;
      throw new Error('invalid fpm');
    }
    return { stdout: '' };
  };
  const lstatFn = async (target) => {
    if (target === '/var/lib/yunpanel/roundcube' || target === roundcubeTemplatePolicy.temporaryDirectory) {
      return directory({ uid: 2001, gid: 2001, mode: 0o700 });
    }
    if (target === '/etc/roundcube' || target === '/etc/php/8.3/fpm/pool.d' || target === '/etc/nginx/sites-enabled') {
      return directory();
    }
    if (target === '/stage/config.inc.php') return file({ mode: 0o600, size: CONFIG.length });
    if (target === '/stage/yunpanel-roundcube-fpm.conf') return file({ mode: 0o640, size: FPM.length });
    if (target === '/stage/yunpanel-roundcube-nginx.conf') return file({ mode: 0o640, size: NGINX.length });
    if (target === roundcubeTemplatePolicy.databaseSchemaPath) return file({ mode: 0o644, size: 1000 });
    if (target === roundcubeTemplatePolicy.databasePath) {
      if (!state.databaseExists) throw enoent();
      return file({ uid: state.databaseUid, gid: state.databaseGid, mode: state.databaseMode, size: 2048 });
    }
    if (target === roundcubeFpmTemplatePolicy.socketPath) {
      if (state.restored && manifest.files[1].exists === false) throw enoent();
      return socket();
    }
    return file();
  };
  const activator = createRoundcubeConfigActivator({
    configManager,
    backupManager,
    run,
    lstatFn,
    readFileFn: async (target) => {
      if (target.includes('config.inc')) return CONFIG;
      if (target.includes('nginx')) return NGINX;
      return FPM;
    },
    writeFileFn: async () => {},
    renameFn: async () => {},
    rmFn: async (target) => {
      calls.push(['rm', target]);
      if (target === roundcubeTemplatePolicy.databasePath) state.databaseExists = false;
    },
    chownFn: async (target, uid, gid) => {
      calls.push(['chown', target, uid, gid]);
      if (target === roundcubeTemplatePolicy.databasePath) {
        state.databaseUid = uid;
        state.databaseGid = gid;
      }
    },
    chmodFn: async (target, mode) => {
      calls.push(['chmod', target, mode]);
      if (target === roundcubeTemplatePolicy.databasePath) state.databaseMode = mode;
    },
  });
  return { activator, calls, state };
}

test('fresh activation bootstraps SQLite and proves FPM, Nginx and HTTPS endpoint health', async () => {
  const fx = fixture();
  const result = await fx.activator.activateConfiguration(preview(), { transactionId: TX });
  assert.equal(result.applied, true);
  assert.equal(result.databaseCreated, true);
  assert.equal(result.nginxSha256, NGINX_SHA);
  assert.equal(result.httpHealthy, true);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/sqlite3'
    && entry[2][1] === `.read ${roundcubeTemplatePolicy.databaseSchemaPath}`));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/sqlite3'
    && entry[2][1] === 'PRAGMA quick_check;' && entry[3].uid === 2001 && entry[3].gid === 2001));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/id'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/sbin/nginx' && entry[2][0] === '-t'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/curl'
    && entry[2].includes('https://mail.example.com/')));
});

test('existing Roundcube database is integrity checked without schema replay', async () => {
  const fx = fixture({ existingDatabase: true });
  const result = await fx.activator.activateConfiguration(preview(), { transactionId: TX });
  assert.equal(result.databaseCreated, false);
  assert.equal(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/sqlite3'
    && entry[2][1].startsWith('.read ')), false);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/sqlite3'
    && entry[2][1] === 'PRAGMA quick_check;'));
});

test('fresh activation failure removes the newly-created database and restores absent config state', async () => {
  const fx = fixture({ failFirstFpmValidation: true });
  await assert.rejects(
    fx.activator.activateConfiguration(preview(), { transactionId: TX }),
    (error) => error instanceof RoundcubeConfigActivationError
      && error.code === 'roundcube_fpm_config_invalid',
  );
  assert.equal(fx.state.databaseExists, false);
  const restoreIndex = fx.calls.findIndex((entry) => entry[0] === 'restore');
  assert.ok(restoreIndex >= 0);
  assert.equal(fx.calls.slice(restoreIndex + 1).some((entry) => entry[0] === 'run' && entry[1] === '/usr/bin/php'), false);
  assert.ok(fx.calls.slice(restoreIndex + 1).some((entry) => entry[0] === 'run' && entry[1] === '/usr/sbin/nginx'));
});

test('missing www-data supplementary membership fails before backup or live mutation', async () => {
  const fx = fixture({ groups: 'yunpanel-roundcube' });
  await assert.rejects(
    fx.activator.activateConfiguration(preview(), { transactionId: TX }),
    (error) => error instanceof RoundcubeConfigActivationError
      && error.code === 'roundcube_runtime_group_unavailable',
  );
  assert.equal(fx.calls.some((entry) => entry[0] === 'backup'), false);
});