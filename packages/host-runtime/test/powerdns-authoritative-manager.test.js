import assert from 'node:assert/strict';
import test from 'node:test';
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeManager,
  PowerDnsAuthoritativeManagerError,
  powerDnsAuthoritativeManagerInternals,
} from '../src/powerdns-authoritative-manager.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'A'.repeat(43);

function intent(overrides = {}) {
  return {
    serverId,
    apiKey,
    apiKeyRevision: 2,
    secondaryDns: ['203.0.113.20', '2001:db8::20'],
    ...overrides,
  };
}

test('PowerDNS manager intent canonicalizes secondary targets and keeps secret private to host intent', () => {
  const normalized = powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({
    secondaryDns: ['203.0.113.20', '2001:db8::20'],
  }));
  assert.equal(normalized.serverId, serverId);
  assert.equal(normalized.apiKey, apiKey);
  assert.equal(normalized.apiKeyRevision, 2);
  assert.deepEqual(normalized.secondaryDns, ['2001:db8::20', '203.0.113.20']);
});

test('PowerDNS manager rejects malformed API keys and secondary DNS addresses', () => {
  assert.throws(
    () => powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({ apiKey: 'short' })),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_intent_invalid',
  );
  assert.throws(
    () => powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({ secondaryDns: ['not-an-ip'] })),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_intent_invalid',
  );
});

test('PowerDNS manager requires vendor include-dir and parses package state deterministically', () => {
  assert.equal(
    powerDnsAuthoritativeManagerInternals.includeDirConfigured('include-dir=/etc/powerdns/pdns.d\n'),
    true,
  );
  assert.equal(
    powerDnsAuthoritativeManagerInternals.includeDirConfigured('include-dir=/tmp/not-managed\n'),
    false,
  );
  assert.deepEqual(
    powerDnsAuthoritativeManagerInternals.packageStatus('install ok installed\t4.8.3-1build2'),
    { installed: true, version: '4.8.3-1build2' },
  );
  assert.deepEqual(
    powerDnsAuthoritativeManagerInternals.packageStatus('deinstall ok config-files\t4.8.3'),
    { installed: false, version: null },
  );
});

test('PowerDNS managed config requires a non-trivial API key hash', () => {
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('api-key=$scrypt$example-hash-value\n'), '$scrypt$example-hash-value');
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('api-key=short\n'), null);
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('webserver=yes\n'), null);
});

function restoredState(overrides = {}) {
  const config = renderManagedPowerDnsConfig({
    apiKeyHash: 'restored-managed-api-key-hash-value-0000000000',
    secondaryDns: intent().secondaryDns,
  });
  const receipt = `${JSON.stringify({
    version: 1,
    serverId,
    apiKeyRevision: 2,
    secondaryDns: [...intent().secondaryDns].sort(),
    configLength: Buffer.byteLength(config),
    appliedAt: '2026-09-17T11:00:00.000Z',
  })}\n`;
  return {
    config,
    receipt,
    base: 'include-dir=/etc/powerdns/pdns.d\n',
    ...overrides,
  };
}

function restoredManager(state, calls = []) {
  return createPowerDnsAuthoritativeManager({
    async run(file, args) {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') {
        return {
          stdout: args.at(-1) === 'pdns-recursor'
            ? 'deinstall ok config-files\t'
            : 'install ok installed\t4.8.3-1ubuntu1',
        };
      }
      if (file === '/usr/bin/stat') {
        return {
          stdout: args.at(-1) === powerDnsTemplatePolicy.configPath
            ? 'root:pdns:640\n'
            : 'pdns:pdns:640\n',
        };
      }
      return { stdout: '' };
    },
    async fetchFn() {
      return { ok: true, status: 200, async json() { return { id: 'localhost' }; } };
    },
    async readFileFn(target) {
      if (target === powerDnsAuthoritativeManagerInternals.paths.BASE_CONFIG) return state.base;
      if (target === powerDnsTemplatePolicy.configPath) return state.config;
      if (target === powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH) return state.receipt;
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async writeFileFn() { throw new Error('rollback activation must not rewrite restored state'); },
  });
}

test('PowerDNS manager validates and activates an exact restored config and receipt without rewriting them', async () => {
  const calls = [];
  const manager = restoredManager(restoredState(), calls);

  const result = await manager.activateRestored(intent());

  assert.equal(result.satisfied, true);
  assert.equal(result.receipt.appliedAt, '2026-09-17T11:00:00.000Z');
  assert.ok(calls.some(([file, args]) => file === '/usr/sbin/pdns_server' && args[0] === '--config=check'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/systemctl'
    && args[0] === 'enable' && args[1] === '--now'));
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/systemctl'
    && args[0] === 'restart' && args[1] === powerDnsTemplatePolicy.serviceUnit));
  assert.equal(calls.some(([file]) => file === '/usr/bin/apt-get'), false);
});

test('PowerDNS manager rejects restored config drift before configtest or service activation', async () => {
  const calls = [];
  const state = restoredState({
    config: renderManagedPowerDnsConfig({
      apiKeyHash: 'restored-managed-api-key-hash-value-0000000000',
      secondaryDns: [],
    }),
  });
  const manager = restoredManager(state, calls);

  await assert.rejects(
    manager.activateRestored(intent()),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_config_invalid',
  );
  assert.equal(calls.length, 0);
});

test('PowerDNS manager rejects a restored receipt mismatch before service activation', async () => {
  const calls = [];
  const state = restoredState();
  const manager = restoredManager({
    ...state,
    receipt: `${JSON.stringify({ ...JSON.parse(state.receipt), apiKeyRevision: 1 })}\n`,
  }, calls);

  await assert.rejects(
    manager.activateRestored(intent()),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_receipt_invalid',
  );
  assert.equal(calls.length, 0);
});
