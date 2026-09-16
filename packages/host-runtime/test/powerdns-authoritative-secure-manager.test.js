import assert from 'node:assert/strict';
import test from 'node:test';
import { powerDnsTemplatePolicy } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeSecureManager,
} from '../src/powerdns-authoritative-secure-manager.js';
import { PowerDnsAuthoritativeManagerError } from '../src/powerdns-authoritative-manager.js';

function missing() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function regular(metadata = {}) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode,
  };
}

function symlink() {
  return { isFile: () => true, isSymbolicLink: () => true };
}

test('PowerDNS secure manager blocks a symlinked SQLite database before host mutation', async () => {
  let applied = false;
  const manager = createPowerDnsAuthoritativeSecureManager({
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() { applied = true; return { satisfied: true }; },
    },
    async lstatFn(target) {
      if (target === powerDnsTemplatePolicy.configPath) return regular();
      if (target === powerDnsTemplatePolicy.databasePath) return symlink();
      return missing();
    },
  });

  await assert.rejects(
    manager.apply({}),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_database_path_drift',
  );
  assert.equal(applied, false);
});

test('PowerDNS secure manager blocks a non-regular managed config before inspection', async () => {
  let inspected = false;
  const manager = createPowerDnsAuthoritativeSecureManager({
    manager: {
      async inspect() { inspected = true; return { satisfied: true }; },
      async apply() { return { satisfied: true }; },
    },
    async lstatFn(target) {
      if (target === powerDnsTemplatePolicy.configPath) return { isFile: () => false, isSymbolicLink: () => false };
      return missing();
    },
  });

  await assert.rejects(
    manager.inspect({}),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_config_path_drift',
  );
  assert.equal(inspected, false);
});

test('PowerDNS secure manager allows missing or regular paths and rechecks after apply', async () => {
  const calls = [];
  let applied = false;
  const manager = createPowerDnsAuthoritativeSecureManager({
    manager: {
      async inspect(value) { calls.push(['inspect', value]); return { satisfied: true }; },
      async apply(value) { calls.push(['apply', value]); applied = true; return { satisfied: true }; },
    },
    async lstatFn(target) {
      calls.push(['lstat', target, applied]);
      if (!applied) return missing();
      return regular();
    },
  });

  const intent = { serverId: 'server' };
  assert.equal((await manager.apply(intent)).satisfied, true);
  assert.equal(calls.filter(([name]) => name === 'apply').length, 1);
  assert.equal(calls.filter(([name]) => name === 'lstat').length, 5);
});

test('PowerDNS secure manager restores the previous managed config after config validation failure', async () => {
  const target = powerDnsTemplatePolicy.configPath;
  const database = powerDnsTemplatePolicy.databasePath;
  const previous = Buffer.from('known-good-powerdns-config\n');
  const candidate = Buffer.from('rejected-powerdns-config\n');
  const files = new Map([[target, previous]]);
  const metadata = { uid: 0, gid: 113, mode: 0o100640 };
  const restoredMetadata = [];

  const manager = createPowerDnsAuthoritativeSecureManager({
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() {
        files.set(target, candidate);
        throw new PowerDnsAuthoritativeManagerError('powerdns_config_invalid', 'candidate rejected');
      },
    },
    async lstatFn(path) {
      if (path === target) return regular(metadata);
      if (path === database) return regular({ uid: 113, gid: 113, mode: 0o100640 });
      return missing();
    },
    async readFileFn(path) {
      if (!files.has(path)) return missing();
      return Buffer.from(files.get(path));
    },
    async writeFileFn(path, content) { files.set(path, Buffer.from(content)); },
    async chownFn(path, uid, gid) { restoredMetadata.push(['chown', path, uid, gid]); },
    async chmodFn(path, mode) { restoredMetadata.push(['chmod', path, mode]); },
    async renameFn(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rmFn(path) { files.delete(path); },
  });

  await assert.rejects(
    manager.apply({ serverId: 'server' }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_config_invalid',
  );
  assert.equal(files.get(target).toString('utf8'), previous.toString('utf8'));
  assert.ok(restoredMetadata.some(([kind, , uid, gid]) => kind === 'chown' && uid === 0 && gid === 113));
  assert.ok(restoredMetadata.some(([kind, , mode]) => kind === 'chmod' && mode === 0o640));
});

test('PowerDNS secure manager removes a rejected first-install config when no previous config existed', async () => {
  const target = powerDnsTemplatePolicy.configPath;
  const database = powerDnsTemplatePolicy.databasePath;
  let configExists = false;

  const manager = createPowerDnsAuthoritativeSecureManager({
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() {
        configExists = true;
        throw new PowerDnsAuthoritativeManagerError('powerdns_config_invalid', 'candidate rejected');
      },
    },
    async lstatFn(path) {
      if (path === target) {
        if (!configExists) return missing();
        return regular({ uid: 0, gid: 113, mode: 0o100640 });
      }
      if (path === database) return regular({ uid: 113, gid: 113, mode: 0o100640 });
      return missing();
    },
    async rmFn(path) {
      if (path === target) configExists = false;
    },
  });

  await assert.rejects(
    manager.apply({ serverId: 'server' }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_config_invalid',
  );
  assert.equal(configExists, false);
});
