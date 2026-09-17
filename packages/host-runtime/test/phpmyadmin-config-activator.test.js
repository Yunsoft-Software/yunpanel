import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  phpMyAdminFpmTemplatePolicy,
  phpMyAdminNginxTemplatePolicy,
  phpMyAdminSignonTemplatePolicy,
} from '@yunpanel/config-templates';
import {
  createPhpMyAdminConfigActivator,
  PhpMyAdminConfigActivationError,
} from '../src/phpmyadmin-config-activator.js';

const TX = '12345678-1234-4234-8234-123456789012';
const FPM = Buffer.from('[yunpanel-phpmyadmin]\nlisten = /run/php/yunpanel-phpmyadmin.sock\n');
const NGINX = Buffer.from('server { listen unix:/run/yunpanel/phpmyadmin-http.sock; }\n');
const SIGNON_CONFIG = Buffer.from("<?php $cfg['Servers'][$i]['auth_type'] = 'signon';\n");
const SIGNON_BRIDGE = Buffer.from("<?php echo 'bridge';\n");
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const FPM_SHA = sha256(FPM);
const NGINX_SHA = sha256(NGINX);
const SIGNON_CONFIG_SHA = sha256(SIGNON_CONFIG);
const SIGNON_BRIDGE_SHA = sha256(SIGNON_BRIDGE);

function preview() {
  return {
    version: 1,
    fpm: {
      version: 1,
      sha256: FPM_SHA,
      artifact: {
        path: phpMyAdminFpmTemplatePolicy.poolPath,
        sha256: FPM_SHA,
        bytes: FPM.length,
        sensitive: false,
        mode: phpMyAdminFpmTemplatePolicy.poolMode,
      },
      socketPath: phpMyAdminFpmTemplatePolicy.socketPath,
      serviceUnit: phpMyAdminFpmTemplatePolicy.serviceUnit,
      runtimeUser: phpMyAdminFpmTemplatePolicy.runtimeUser,
      runtimeGroup: phpMyAdminFpmTemplatePolicy.runtimeGroup,
      temporaryDirectory: phpMyAdminFpmTemplatePolicy.temporaryDirectory,
      sessionDirectory: phpMyAdminFpmTemplatePolicy.sessionDirectory,
    },
    nginx: {
      version: 1,
      sha256: NGINX_SHA,
      artifact: {
        path: phpMyAdminNginxTemplatePolicy.configPath,
        sha256: NGINX_SHA,
        bytes: NGINX.length,
        sensitive: false,
        mode: phpMyAdminNginxTemplatePolicy.configMode,
      },
      documentRoot: phpMyAdminNginxTemplatePolicy.documentRoot,
      fpmSocketPath: phpMyAdminNginxTemplatePolicy.fpmSocketPath,
      gatewaySocketPath: phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
      gatewaySocketMode: phpMyAdminNginxTemplatePolicy.gatewaySocketMode,
      gatewaySocketOwner: phpMyAdminNginxTemplatePolicy.gatewaySocketOwner,
      gatewaySocketGroup: phpMyAdminNginxTemplatePolicy.gatewaySocketGroup,
      signonBridgePath: phpMyAdminNginxTemplatePolicy.signonBridgePath,
      internalSignonPath: phpMyAdminNginxTemplatePolicy.internalSignonPath,
      healthPath: phpMyAdminNginxTemplatePolicy.healthPath,
      serviceUnit: phpMyAdminNginxTemplatePolicy.serviceUnit,
    },
    signonConfig: {
      version: 1,
      sha256: SIGNON_CONFIG_SHA,
      artifact: {
        path: phpMyAdminSignonTemplatePolicy.configPath,
        sha256: SIGNON_CONFIG_SHA,
        bytes: SIGNON_CONFIG.length,
        sensitive: false,
        mode: phpMyAdminSignonTemplatePolicy.configMode,
      },
      signonSession: phpMyAdminSignonTemplatePolicy.signonSession,
      gatewayBasePath: phpMyAdminSignonTemplatePolicy.gatewayBasePath,
    },
    signonBridge: {
      version: 1,
      sha256: SIGNON_BRIDGE_SHA,
      artifact: {
        path: phpMyAdminSignonTemplatePolicy.bridgePath,
        sha256: SIGNON_BRIDGE_SHA,
        bytes: SIGNON_BRIDGE.length,
        sensitive: false,
        mode: phpMyAdminSignonTemplatePolicy.bridgeMode,
      },
      handoffSocketPath: phpMyAdminSignonTemplatePolicy.handoffSocketPath,
      signonSession: phpMyAdminSignonTemplatePolicy.signonSession,
      internalSignonPath: phpMyAdminSignonTemplatePolicy.internalSignonPath,
      gatewayBasePath: phpMyAdminSignonTemplatePolicy.gatewayBasePath,
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

function file({ uid = 0, gid = 0, mode = 0o640, size = 1 } = {}) {
  return {
    uid, gid, mode, size,
    isDirectory: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

function socket({ uid = 0, gid = 0, mode = 0o660 } = {}) {
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

function fixture({
  failFirstFpmValidation = false,
  groups = 'yunpanel-phpmyadmin www-data',
  changedStage = false,
  fpmExisted = false,
  nginxExisted = false,
} = {}) {
  const calls = [];
  const state = {
    failFpm: failFirstFpmValidation,
    restored: false,
    gatewayUid: 0,
    gatewayGid: 0,
    gatewayMode: 0o755,
    gatewayDirectoryExists: true,
  };
  const manifest = {
    version: 2,
    transactionId: TX,
    files: [
      {
        targetPath: phpMyAdminFpmTemplatePolicy.poolPath,
        exists: fpmExisted,
        backupName: fpmExisted ? 'yunpanel-phpmyadmin-fpm.conf' : null,
      },
      {
        targetPath: phpMyAdminNginxTemplatePolicy.configPath,
        exists: nginxExisted,
        backupName: nginxExisted ? 'yunpanel-phpmyadmin-nginx.conf' : null,
      },
      {
        targetPath: phpMyAdminSignonTemplatePolicy.configPath,
        exists: false,
        backupName: null,
      },
      {
        targetPath: phpMyAdminSignonTemplatePolicy.bridgePath,
        exists: false,
        backupName: null,
      },
    ],
  };
  const configManager = {
    inspectStagedFpmPool: async () => ({ satisfied: true, result: {} }),
    inspectStagedNginxConfig: async () => ({ satisfied: true, result: {} }),
    inspectStagedSignonConfig: async () => ({ satisfied: true, result: {} }),
    inspectStagedSignonBridge: async () => ({ satisfied: true, result: {} }),
    stagedFpmPath: () => '/stage/yunpanel-phpmyadmin-fpm.conf',
    stagedNginxPath: () => '/stage/yunpanel-phpmyadmin-nginx.conf',
    stagedSignonConfigPath: () => '/stage/zz-yunpanel.php',
    stagedSignonBridgePath: () => '/stage/yunpanel-phpmyadmin-signon.php',
  };
  const backupManager = {
    async backupConfiguration(id) {
      calls.push(['backup', id]);
      return manifest;
    },
    async loadManifest(id) {
      calls.push(['manifest', id]);
      return manifest;
    },
    async restoreConfiguration(id) {
      calls.push(['restore', id]);
      state.restored = true;
      return { version: 2, transactionId: id, restored: true };
    },
  };
  const run = async (command, args) => {
    calls.push(['run', command, [...args]]);
    if (command === '/usr/bin/getent' && args[0] === 'passwd') {
      if (args[1] === 'yunpanel-phpmyadmin') {
        return { stdout: 'yunpanel-phpmyadmin:x:2002:2002::/var/lib/yunpanel/phpmyadmin:/usr/sbin/nologin\n' };
      }
      if (args[1] === 'www-data') {
        return { stdout: 'www-data:x:33:33::/var/www:/usr/sbin/nologin\n' };
      }
    }
    if (command === '/usr/bin/getent' && args[0] === 'group' && args[1] === 'yunpanel') {
      return { stdout: 'yunpanel:x:995:\n' };
    }
    if (command === '/usr/bin/id') return { stdout: `${groups}\n` };
    if (command === '/usr/sbin/php-fpm8.3' && state.failFpm) {
      state.failFpm = false;
      throw new Error('invalid FPM');
    }
    return { stdout: '' };
  };
  const lstatFn = async (target) => {
    if (target === '/var/lib/yunpanel/phpmyadmin'
      || target === phpMyAdminFpmTemplatePolicy.temporaryDirectory
      || target === phpMyAdminFpmTemplatePolicy.sessionDirectory) {
      return directory({ uid: 2002, gid: 2002, mode: 0o700 });
    }
    if (target === '/etc/php/8.3/fpm/pool.d'
      || target === '/etc/nginx/sites-enabled'
      || target === '/etc/phpmyadmin/conf.d'
      || target === phpMyAdminNginxTemplatePolicy.documentRoot) {
      return directory();
    }
    if (target === phpMyAdminSignonTemplatePolicy.bridgeDirectory) {
      return directory({ uid: 0, gid: 2002, mode: 0o750 });
    }
    if (target === '/run/yunpanel') {
      if (!state.gatewayDirectoryExists) throw enoent();
      return directory({ uid: 0, gid: 995, mode: 0o2770 });
    }
    if (target === '/stage/yunpanel-phpmyadmin-fpm.conf') {
      return file({ mode: 0o640, size: FPM.length });
    }
    if (target === '/stage/yunpanel-phpmyadmin-nginx.conf') {
      return file({ mode: 0o640, size: NGINX.length });
    }
    if (target === '/stage/zz-yunpanel.php') {
      return file({ mode: 0o640, size: SIGNON_CONFIG.length });
    }
    if (target === '/stage/yunpanel-phpmyadmin-signon.php') {
      return file({ mode: 0o640, size: SIGNON_BRIDGE.length });
    }
    if (target === phpMyAdminFpmTemplatePolicy.socketPath) {
      if (state.restored && !fpmExisted) throw enoent();
      return socket({ uid: 33, gid: 33, mode: 0o660 });
    }
    if (target === phpMyAdminNginxTemplatePolicy.gatewaySocketPath) {
      if (state.restored && !nginxExisted) throw enoent();
      return socket({
        uid: state.gatewayUid,
        gid: state.gatewayGid,
        mode: state.gatewayMode,
      });
    }
    return file();
  };
  const activator = createPhpMyAdminConfigActivator({
    configManager,
    backupManager,
    run,
    lstatFn,
    mkdirFn: async (target) => {
      calls.push(['mkdir', target]);
      if (target === '/run/yunpanel') state.gatewayDirectoryExists = true;
    },
    readFileFn: async (target) => {
      if (changedStage && target.includes('fpm')) return Buffer.from('changed');
      if (target.includes('nginx')) return NGINX;
      if (target.endsWith('/zz-yunpanel.php')) return SIGNON_CONFIG;
      if (target.includes('signon')) return SIGNON_BRIDGE;
      return FPM;
    },
    writeFileFn: async () => {},
    renameFn: async () => {},
    rmFn: async () => {},
    chownFn: async (target, uid, gid) => {
      calls.push(['chown', target, uid, gid]);
      if (target === phpMyAdminNginxTemplatePolicy.gatewaySocketPath) {
        state.gatewayUid = uid;
        state.gatewayGid = gid;
      }
    },
    chmodFn: async (target, mode) => {
      calls.push(['chmod', target, mode]);
      if (target === phpMyAdminNginxTemplatePolicy.gatewaySocketPath) state.gatewayMode = mode;
    },
  });
  return { activator, calls, state };
}

test('activation installs staged configs and proves private FPM and HTTP sockets', async () => {
  const fx = fixture();
  const result = await fx.activator.activateConfiguration(preview(), { transactionId: TX });
  assert.equal(result.applied, true);
  assert.equal(result.fpmSha256, FPM_SHA);
  assert.equal(result.nginxSha256, NGINX_SHA);
  assert.equal(result.signonConfigSha256, SIGNON_CONFIG_SHA);
  assert.equal(result.signonBridgeSha256, SIGNON_BRIDGE_SHA);
  assert.equal(result.fpmSocketHealthy, true);
  assert.equal(result.gatewaySocketHealthy, true);
  assert.equal(result.httpHealthy, true);
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/php' && entry[2][0] === '-l'
    && entry[2][1] === '/stage/zz-yunpanel.php'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/php' && entry[2][0] === '-l'
    && entry[2][1] === '/stage/yunpanel-phpmyadmin-signon.php'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/php-fpm8.3' && entry[2][0] === '-t'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/nginx' && entry[2][0] === '-t'));
  assert.ok(fx.calls.some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/bin/curl'
    && entry[2].includes('--unix-socket')
    && entry[2].includes(phpMyAdminNginxTemplatePolicy.gatewaySocketPath)));
  assert.ok(fx.calls.some((entry) => entry[0] === 'chown'
    && entry[1] === phpMyAdminNginxTemplatePolicy.gatewaySocketPath
    && entry[2] === 0 && entry[3] === 995));
  assert.equal(fx.state.gatewayMode, 0o660);
});

test('configuration failure restores the previous FPM and Nginx presence state', async () => {
  const fx = fixture({ failFirstFpmValidation: true });
  await assert.rejects(
    fx.activator.activateConfiguration(preview(), { transactionId: TX }),
    (error) => error instanceof PhpMyAdminConfigActivationError
      && error.code === 'phpmyadmin_fpm_config_invalid',
  );
  assert.ok(fx.calls.some((entry) => entry[0] === 'restore' && entry[1] === TX));
  const restoreIndex = fx.calls.findIndex((entry) => entry[0] === 'restore');
  assert.ok(fx.calls.slice(restoreIndex + 1).some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/php-fpm8.3'));
  assert.ok(fx.calls.slice(restoreIndex + 1).some((entry) => entry[0] === 'run'
    && entry[1] === '/usr/sbin/nginx'));
});

test('changed staged material fails before backup or live mutation', async () => {
  const fx = fixture({ changedStage: true });
  await assert.rejects(
    fx.activator.activateConfiguration(preview(), { transactionId: TX }),
    (error) => error instanceof PhpMyAdminConfigActivationError
      && error.code === 'phpmyadmin_stage_changed',
  );
  assert.equal(fx.calls.some((entry) => entry[0] === 'backup'), false);
});

test('missing package group membership fails before backup or live mutation', async () => {
  const fx = fixture({ groups: 'yunpanel-phpmyadmin' });
  await assert.rejects(
    fx.activator.activateConfiguration(preview(), { transactionId: TX }),
    (error) => error instanceof PhpMyAdminConfigActivationError
      && error.code === 'phpmyadmin_runtime_group_unavailable',
  );
  assert.equal(fx.calls.some((entry) => entry[0] === 'backup'), false);
});
