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

function regular() {
  return { isFile: () => true, isSymbolicLink: () => false };
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
  assert.equal(calls.filter(([name]) => name === 'lstat').length, 4);
});
