import assert from 'node:assert/strict';
import test from 'node:test';
import { renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import {
  PowerDnsAuthoritativeManagerError,
  powerDnsAuthoritativeManagerInternals,
} from '../src/powerdns-authoritative-manager.js';
import { configFor, createFakeHost, intent, paths, previousSecondaryDns, serverId } from './powerdns-fake-host.js';

const internals = powerDnsAuthoritativeManagerInternals;

function managerError(code) {
  return (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === code;
}

test('PowerDNS manager intent canonicalizes secondary targets and keeps secret private to host intent', () => {
  const normalized = internals.normalizeIntent(intent({ secondaryDns: ['203.0.113.20', '2001:db8::20'] }));
  assert.equal(normalized.serverId, serverId);
  assert.equal(normalized.apiKey, intent().apiKey);
  assert.equal(normalized.apiKeyRevision, 2);
  assert.deepEqual(normalized.secondaryDns, ['2001:db8::20', '203.0.113.20']);
});

test('PowerDNS manager rejects malformed API keys and secondary DNS addresses', () => {
  assert.throws(() => internals.normalizeIntent(intent({ apiKey: 'short' })), managerError('powerdns_intent_invalid'));
  assert.throws(() => internals.normalizeIntent(intent({ secondaryDns: ['not-an-ip'] })), managerError('powerdns_intent_invalid'));
});

test('PowerDNS manager requires vendor include-dir and parses package state deterministically', () => {
  assert.equal(internals.schemaPaths[0], '/usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql');
  assert.equal(internals.includeDirConfigured('include-dir=/etc/powerdns/pdns.d\n'), true);
  assert.equal(internals.includeDirConfigured('include-dir=/tmp/not-managed\n'), false);
  assert.deepEqual(internals.packageStatus('install ok installed\t4.8.3-1build2'), { installed: true, version: '4.8.3-1build2' });
  assert.deepEqual(internals.packageStatus('deinstall ok config-files\t4.8.3'), { installed: false, version: null });
});

test('PowerDNS managed config requires a non-trivial API key hash', () => {
  assert.equal(internals.apiKeyHashFromConfig('api-key=$scrypt$example-hash-value\n'), '$scrypt$example-hash-value');
  assert.equal(internals.apiKeyHashFromConfig('api-key=short\n'), null);
  assert.equal(internals.apiKeyHashFromConfig('webserver=yes\n'), null);
});

function restoredState() {
  const spec = internals.normalizeIntent(intent());
  const config = renderManagedPowerDnsConfig({
    apiKeyHash: 'restored-managed-api-key-hash-value-0000000000',
    secondaryDns: spec.secondaryDns,
  });
  const receipt = {
    version: 1,
    serverId,
    apiKeyRevision: 2,
    secondaryDns: [...spec.secondaryDns],
    configLength: Buffer.byteLength(config),
    appliedAt: '2026-09-17T11:00:00.000Z',
  };
  return { spec, config, receipt };
}

test('PowerDNS restored state accepts an exact config and receipt pair', () => {
  const { spec, config, receipt } = restoredState();
  assert.doesNotThrow(() => internals.assertRestoredState(spec, config, `${JSON.stringify(receipt)}\n`));
});

test('PowerDNS restored state rejects config drift and a receipt mismatch', () => {
  const { spec, config, receipt } = restoredState();
  const drifted = renderManagedPowerDnsConfig({ apiKeyHash: 'restored-managed-api-key-hash-value-0000000000', secondaryDns: [] });
  assert.throws(() => internals.assertRestoredState(spec, drifted, JSON.stringify(receipt)), managerError('powerdns_rollback_config_invalid'));
  assert.throws(
    () => internals.assertRestoredState(spec, config, JSON.stringify({ ...receipt, apiKeyRevision: 1 })),
    managerError('powerdns_rollback_receipt_invalid'),
  );
  assert.throws(() => internals.assertRestoredState(spec, null, JSON.stringify(receipt)), managerError('powerdns_rollback_config_missing'));
  assert.throws(() => internals.assertRestoredState(spec, config, null), managerError('powerdns_rollback_receipt_missing'));
});

test('PowerDNS first apply installs packages and leaves every managed file with its owner and mode', async () => {
  const host = createFakeHost();
  host.packagesInstalled = false;

  const result = await host.manager().apply(intent());

  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'powerdns-authoritative-gsqlite3');
  assert.equal(host.commands('/usr/bin/apt-get', 'install').length, 1);
  assert.equal(host.text(paths.config), configFor(intent().secondaryDns));
  assert.deepEqual(host.meta(paths.config), { uid: 0, gid: 113, mode: 0o640 });
  assert.deepEqual(host.meta(paths.database), { uid: 113, gid: 113, mode: 0o640 });
  assert.deepEqual(host.meta(paths.receipt), { uid: 0, gid: 0, mode: 0o600 });
  assert.deepEqual(host.meta(paths.journal), { uid: 0, gid: 0, mode: 0o600 });
  assert.deepEqual(host.meta(paths.snapshot), { uid: 0, gid: 0, mode: 0o600 });
  assert.equal([...host.files.keys()].some((target) => target.endsWith('.tmp')), false);
  assert.doesNotMatch(host.text(paths.receipt) + host.text(paths.journal) + host.text(paths.snapshot), new RegExp(intent().apiKey));
});

test('PowerDNS apply is idempotent once the host matches the intent', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent());
  const journal = host.text(paths.journal);

  const repeated = await manager.apply(intent());

  assert.equal(repeated.satisfied, true);
  assert.equal(host.text(paths.journal), journal);
  assert.equal(host.commands('/usr/bin/systemctl', 'enable').length, 1);
  assert.equal(host.configWrites(), 1);
  assert.equal(host.hashes, 1);
});

test('PowerDNS apply refuses a host with pdns-recursor or without the vendor include-dir', async () => {
  const recursor = createFakeHost();
  recursor.recursorInstalled = true;
  await assert.rejects(recursor.manager().apply(intent()), managerError('powerdns_recursor_conflict'));
  assert.equal(recursor.journal().status, 'failed');
  assert.equal(recursor.files.has(paths.config), false);

  const vendor = createFakeHost();
  vendor.put(paths.baseConfig, 'launch=bind\n');
  await assert.rejects(vendor.manager().apply(intent()), managerError('powerdns_include_dir_required'));
  assert.equal(vendor.journal().status, 'failed');
  assert.equal(vendor.files.has(paths.config), false);
});

test('PowerDNS manager blocks a symlinked SQLite database before host mutation', async () => {
  const host = createFakeHost();
  host.put(paths.database, 'sqlite', { uid: 113, gid: 113, mode: 0o640, type: 'symlink' });

  await assert.rejects(host.manager().apply(intent()), managerError('powerdns_database_path_drift'));
  assert.deepEqual(host.calls, []);
  assert.equal(host.files.has(paths.journal), false);
  assert.equal(host.files.has(paths.config), false);
});

test('PowerDNS manager blocks a non-regular managed config before inspection', async () => {
  const host = createFakeHost();
  host.put(paths.config, '', { type: 'directory' });

  await assert.rejects(host.manager().inspect(intent()), managerError('powerdns_config_path_drift'));
  assert.deepEqual(host.calls, []);
});

test('PowerDNS manager rechecks managed paths after apply and keeps the operation blocked', async () => {
  const host = createFakeHost();
  host.databaseAsSymlink = true;

  await assert.rejects(host.manager().apply(intent()), managerError('powerdns_recovery_inspection_unavailable'));
  const journal = host.journal();
  assert.equal(journal.status, 'applying');
  assert.equal(journal.lastError.code, 'powerdns_database_path_drift');
});

test('PowerDNS manager restores the previous managed config after config validation failure', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent({ secondaryDns: [...previousSecondaryDns] }));
  const previous = host.bytes(paths.config);
  host.rejectConfig = true;

  await assert.rejects(manager.apply(intent()), managerError('powerdns_config_invalid'));

  assert.equal(host.bytes(paths.config).equals(previous), true);
  assert.deepEqual(host.meta(paths.config), { uid: 0, gid: 113, mode: 0o640 });
  const journal = host.journal();
  assert.equal(journal.status, 'failed');
  assert.equal(journal.lastError.code, 'powerdns_config_invalid');
});

test('PowerDNS manager removes a rejected first-install config when no previous config existed', async () => {
  const host = createFakeHost();
  host.rejectConfig = true;

  await assert.rejects(host.manager().apply(intent()), managerError('powerdns_config_invalid'));

  assert.equal(host.configWrites(), 1);
  assert.equal(host.files.has(paths.config), false);
  assert.equal(host.journal().status, 'failed');
});

test('PowerDNS manager rotates a stale API key hash once when the drop-in otherwise matches', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  await manager.apply(intent());
  host.put(paths.config, configFor(intent().secondaryDns, 'C'.repeat(43)), { gid: 113, mode: 0o640 });

  const result = await manager.apply(intent());

  assert.equal(result.satisfied, true);
  assert.equal(host.text(paths.config), configFor(intent().secondaryDns));
  assert.equal(host.hashes, 2);
});

test('PowerDNS host stays unconfigured until YunPanel writes state', async () => {
  const host = createFakeHost();
  const manager = host.manager();
  assert.equal(await manager.isUnconfigured(), true);
  await manager.apply(intent());
  assert.equal(await manager.isUnconfigured(), false);
});
