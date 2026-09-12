import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  roundcubeFpmTemplatePolicy,
  roundcubeTemplatePolicy,
} from '@yunpanel/config-templates';
import { createRoundcubeConfigEvidenceInspector } from '../src/roundcube-config-evidence-inspector.js';

const CONFIG = Buffer.from('<?php $config = [];\n');
const FPM = Buffer.from('[yunpanel-roundcube]\n');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function preview() {
  return {
    readyToApply: true,
    sha256: 'c'.repeat(64),
    configSha256: sha256(CONFIG),
    fpmSha256: sha256(FPM),
    configuration: {
      artifact: { path: roundcubeTemplatePolicy.configPath, sha256: sha256(CONFIG) },
    },
    fpm: {
      artifact: { path: roundcubeFpmTemplatePolicy.poolPath, sha256: sha256(FPM) },
      socketPath: roundcubeFpmTemplatePolicy.socketPath,
      serviceUnit: roundcubeFpmTemplatePolicy.serviceUnit,
    },
  };
}

function directory({ uid = 2001, gid = 2001, mode = 0o700 } = {}) {
  return {
    uid, gid, mode,
    isDirectory: () => true,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}
function file({ uid, gid, mode, size }) {
  return {
    uid, gid, mode, size,
    isDirectory: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}
function socket() {
  return {
    uid: 33, gid: 33, mode: 0o660,
    isDirectory: () => false,
    isFile: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };
}

function fixture({ databaseMode = 0o600, groups = 'yunpanel-roundcube www-data' } = {}) {
  const calls = [];
  const inspector = createRoundcubeConfigEvidenceInspector({
    run: async (command, args, options = {}) => {
      calls.push([command, [...args], { uid: options.uid, gid: options.gid }]);
      if (command === '/usr/bin/getent') {
        if (args[1] === 'yunpanel-roundcube') return { stdout: 'yunpanel-roundcube:x:2001:2001::/var/lib/yunpanel/roundcube:/usr/sbin/nologin\n' };
        if (args[1] === 'www-data') return { stdout: 'www-data:x:33:33::/var/www:/usr/sbin/nologin\n' };
      }
      if (command === '/usr/bin/id') return { stdout: `${groups}\n` };
      if (command === '/usr/bin/sqlite3') return { stdout: 'ok\n' };
      return { stdout: '' };
    },
    lstatFn: async (target) => {
      if (target === '/var/lib/yunpanel/roundcube' || target === roundcubeTemplatePolicy.temporaryDirectory) return directory();
      if (target === roundcubeTemplatePolicy.configPath) return file({ uid: 0, gid: 2001, mode: 0o640, size: CONFIG.length });
      if (target === roundcubeFpmTemplatePolicy.poolPath) return file({ uid: 0, gid: 0, mode: 0o640, size: FPM.length });
      if (target === roundcubeTemplatePolicy.databasePath) return file({ uid: 2001, gid: 2001, mode: databaseMode, size: 2048 });
      if (target === roundcubeFpmTemplatePolicy.socketPath) return socket();
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readFileFn: async (target) => target === roundcubeTemplatePolicy.configPath ? CONFIG : FPM,
  });
  return { inspector, calls };
}

test('live Roundcube evidence proves only bounded secret-free final state', async () => {
  const fx = fixture();
  const evidence = await fx.inspector.inspect(preview());
  assert.equal(evidence.satisfied, true);
  assert.deepEqual(evidence.result, {
    version: 1,
    previewSha256: 'c'.repeat(64),
    configSha256: sha256(CONFIG),
    fpmSha256: sha256(FPM),
    databaseHealthy: true,
    applied: true,
    sideEffects: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /des_key|privateKey|sqlite:\/\//);
  const quickCheck = fx.calls.find(([command, args]) => command === '/usr/bin/sqlite3' && args[1] === 'PRAGMA quick_check;');
  assert.deepEqual(quickCheck?.[2], { uid: 2001, gid: 2001 });
});

test('live Roundcube evidence fails closed on unsafe database mode or missing package group membership', async () => {
  assert.equal((await fixture({ databaseMode: 0o640 }).inspector.inspect(preview())).satisfied, false);
  assert.equal((await fixture({ groups: 'yunpanel-roundcube' }).inspector.inspect(preview())).satisfied, false);
});
