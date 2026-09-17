import assert from 'node:assert/strict';
import test from 'node:test';
import { powerDnsTemplatePolicy, renderManagedPowerDnsConfig } from '@yunpanel/config-templates/powerdns';
import {
  createPowerDnsAuthoritativeSecureManager,
  powerDnsAuthoritativeSecureManagerInternals,
} from '../src/powerdns-authoritative-secure-manager.js';
import {
  powerDnsAuthoritativeManagerInternals,
  PowerDnsAuthoritativeManagerError,
} from '../src/powerdns-authoritative-manager.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'A'.repeat(43);

function authoritativeIntent(overrides = {}) {
  return {
    serverId,
    apiKey,
    apiKeyRevision: 2,
    secondaryDns: ['203.0.113.20'],
    ...overrides,
  };
}

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

function rollbackFilesystem({ receipt = true } = {}) {
  const configPath = powerDnsTemplatePolicy.configPath;
  const databasePath = powerDnsTemplatePolicy.databasePath;
  const receiptPath = powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH;
  const snapshotPath = powerDnsAuthoritativeSecureManagerInternals.rollbackSnapshotPath;
  const previousSecondaryDns = ['198.51.100.53'];
  const config = renderManagedPowerDnsConfig({
    apiKeyHash: 'previous-managed-api-key-hash-value-000000000000',
    secondaryDns: previousSecondaryDns,
  });
  const files = new Map([[configPath, Buffer.from(config)]]);
  if (receipt) {
    files.set(receiptPath, Buffer.from(`${JSON.stringify({
      version: 1,
      serverId,
      apiKeyRevision: 2,
      secondaryDns: previousSecondaryDns,
      configLength: Buffer.byteLength(config),
      appliedAt: '2026-09-17T09:00:00.000Z',
    })}\n`));
  }
  const metadata = new Map([
    [configPath, { uid: 0, gid: 113, mode: 0o100640 }],
    [databasePath, { uid: 113, gid: 113, mode: 0o100640 }],
    [receiptPath, { uid: 0, gid: 0, mode: 0o100600 }],
  ]);
  return {
    files,
    snapshotPath,
    previousSecondaryDns,
    async chmodFn(target, mode) {
      const current = metadata.get(target);
      if (current) metadata.set(target, { ...current, mode: 0o100000 | mode });
    },
    async chownFn(target, uid, gid) {
      const current = metadata.get(target) ?? { mode: 0o100600 };
      metadata.set(target, { ...current, uid, gid });
    },
    async lstatFn(target) {
      if (!files.has(target) && target !== databasePath) return missing();
      const state = metadata.get(target) ?? { uid: 0, gid: 0, mode: 0o100600 };
      return regular(state);
    },
    async mkdirFn() {},
    async readFileFn(target, encoding) {
      if (!files.has(target)) return missing();
      const content = Buffer.from(files.get(target));
      return encoding ? content.toString(encoding) : content;
    },
    async renameFn(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      metadata.set(to, metadata.get(from) ?? { uid: 0, gid: 0, mode: 0o100600 });
      metadata.delete(from);
    },
    async rmFn(target) { files.delete(target); metadata.delete(target); },
    async writeFileFn(target, content, options = {}) {
      files.set(target, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, options.encoding ?? 'utf8'));
      metadata.set(target, { uid: 0, gid: 0, mode: 0o100000 | (options.mode ?? 0o600) });
    },
  };
}

function secureManagerWithFilesystem(filesystem, manager, overrides = {}) {
  return createPowerDnsAuthoritativeSecureManager({
    rollbackSnapshotPath: filesystem.snapshotPath,
    chmodFn: filesystem.chmodFn,
    chownFn: filesystem.chownFn,
    lstatFn: filesystem.lstatFn,
    mkdirFn: filesystem.mkdirFn,
    readFileFn: filesystem.readFileFn,
    renameFn: filesystem.renameFn,
    rmFn: filesystem.rmFn,
    writeFileFn: filesystem.writeFileFn,
    manager,
    ...overrides,
  });
}

function rollbackHost(filesystem, {
  failPreviousActivation = false,
  failCurrentActivation = false,
} = {}) {
  const configPath = powerDnsTemplatePolicy.configPath;
  const receiptPath = powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH;
  const previousConfig = Buffer.from(filesystem.files.get(configPath));
  const previousReceipt = Buffer.from(filesystem.files.get(receiptPath));
  const currentConfigText = renderManagedPowerDnsConfig({
    apiKeyHash: 'current-managed-api-key-hash-value-0000000000000',
    secondaryDns: authoritativeIntent().secondaryDns,
  });
  const currentConfig = Buffer.from(currentConfigText);
  const currentReceipt = Buffer.from(`${JSON.stringify({
    version: 1,
    serverId,
    apiKeyRevision: 2,
    secondaryDns: authoritativeIntent().secondaryDns,
    configLength: Buffer.byteLength(currentConfigText),
    appliedAt: '2026-09-17T12:00:00.000Z',
  })}\n`);
  const activations = [];

  function isPrevious(value) {
    return JSON.stringify(value.secondaryDns) === JSON.stringify(filesystem.previousSecondaryDns);
  }

  const manager = {
    async inspect(value) {
      const expectedConfig = isPrevious(value) ? previousConfig : currentConfig;
      const expectedReceipt = isPrevious(value) ? previousReceipt : currentReceipt;
      return {
        satisfied: filesystem.files.get(configPath)?.equals(expectedConfig) === true
          && filesystem.files.get(receiptPath)?.equals(expectedReceipt) === true,
        serverId,
        apiKeyRevision: 2,
        secondaryDns: value.secondaryDns,
        receipt: { appliedAt: isPrevious(value) ? '2026-09-17T09:00:00.000Z' : '2026-09-17T12:00:00.000Z' },
      };
    },
    async apply(value) {
      filesystem.files.set(configPath, Buffer.from(currentConfig));
      filesystem.files.set(receiptPath, Buffer.from(currentReceipt));
      return this.inspect(value);
    },
    async activateRestored(value) {
      const previous = isPrevious(value);
      activations.push(previous ? 'previous' : 'current');
      if ((previous && failPreviousActivation) || (!previous && failCurrentActivation)) {
        throw new PowerDnsAuthoritativeManagerError(
          'powerdns_rollback_api_unhealthy',
          'activation health check failed',
        );
      }
      return this.inspect(value);
    },
  };
  return { manager, activations, previousConfig, previousReceipt, currentConfig, currentReceipt };
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

test('PowerDNS secure manager persists a private operation-bound rollback snapshot before apply', async () => {
  const filesystem = rollbackFilesystem();
  let applied = false;
  const dependencies = {
    rollbackSnapshotPath: filesystem.snapshotPath,
    chmodFn: filesystem.chmodFn,
    chownFn: filesystem.chownFn,
    lstatFn: filesystem.lstatFn,
    mkdirFn: filesystem.mkdirFn,
    readFileFn: filesystem.readFileFn,
    renameFn: filesystem.renameFn,
    rmFn: filesystem.rmFn,
    writeFileFn: filesystem.writeFileFn,
    now: () => Date.parse('2026-09-17T10:00:00.000Z'),
  };
  const manager = createPowerDnsAuthoritativeSecureManager({
    ...dependencies,
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() { applied = true; return { satisfied: true }; },
    },
  });

  await manager.apply(authoritativeIntent(), { operationId: 'operation-snapshot' });

  assert.equal(applied, true);
  const status = await manager.rollbackStatus({
    operationId: 'operation-snapshot',
    serverId,
    credentialRevision: 2,
  });
  assert.deepEqual(status.previousSecondaryDns, filesystem.previousSecondaryDns);
  assert.equal(status.available, true);
  assert.equal(status.reason, null);
  assert.match(status.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(status.createdAt, '2026-09-17T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(status), /content|apiKey|previous-managed-api-key-hash/);

  const persisted = JSON.parse(filesystem.files.get(filesystem.snapshotPath).toString('utf8'));
  assert.equal(persisted.operationId, 'operation-snapshot');
  assert.equal(typeof persisted.config.content, 'string');
  assert.equal(typeof persisted.receipt.content, 'string');
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(apiKey));

  const restarted = createPowerDnsAuthoritativeSecureManager({
    ...dependencies,
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() { return { satisfied: true }; },
    },
  });
  assert.deepEqual(
    await restarted.rollbackStatus({ operationId: 'operation-snapshot', serverId, credentialRevision: 2 }),
    status,
  );
});

test('PowerDNS secure manager reuses the original rollback snapshot when an operation is retried', async () => {
  const filesystem = rollbackFilesystem();
  const receiptPath = powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH;
  let applyCount = 0;
  const manager = createPowerDnsAuthoritativeSecureManager({
    rollbackSnapshotPath: filesystem.snapshotPath,
    chmodFn: filesystem.chmodFn,
    chownFn: filesystem.chownFn,
    lstatFn: filesystem.lstatFn,
    mkdirFn: filesystem.mkdirFn,
    readFileFn: filesystem.readFileFn,
    renameFn: filesystem.renameFn,
    rmFn: filesystem.rmFn,
    writeFileFn: filesystem.writeFileFn,
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() {
        applyCount += 1;
        if (applyCount === 1) {
          filesystem.files.set(powerDnsTemplatePolicy.configPath, Buffer.from('candidate-config\n'));
          filesystem.files.set(receiptPath, Buffer.from('candidate-receipt\n'));
        }
        return { satisfied: true };
      },
    },
  });

  const intent = authoritativeIntent();
  const context = { operationId: 'operation-retry' };
  await manager.apply(intent, context);
  const original = filesystem.files.get(filesystem.snapshotPath).toString('utf8');
  await manager.apply(intent, context);

  assert.equal(applyCount, 2);
  assert.equal(filesystem.files.get(filesystem.snapshotPath).toString('utf8'), original);
});

test('PowerDNS secure manager records an unavailable rollback when no previous receipt exists', async () => {
  const filesystem = rollbackFilesystem({ receipt: false });
  let applied = false;
  const manager = createPowerDnsAuthoritativeSecureManager({
    rollbackSnapshotPath: filesystem.snapshotPath,
    chmodFn: filesystem.chmodFn,
    chownFn: filesystem.chownFn,
    lstatFn: filesystem.lstatFn,
    mkdirFn: filesystem.mkdirFn,
    readFileFn: filesystem.readFileFn,
    renameFn: filesystem.renameFn,
    rmFn: filesystem.rmFn,
    writeFileFn: filesystem.writeFileFn,
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() { applied = true; return { satisfied: true }; },
    },
  });

  await manager.apply(authoritativeIntent(), { operationId: 'operation-first-install' });

  assert.equal(applied, true);
  const status = await manager.rollbackStatus({
    operationId: 'operation-first-install',
    serverId,
    credentialRevision: 2,
  });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'powerdns_rollback_previous_receipt_missing');
  assert.equal(status.snapshotDigest, null);
  assert.equal(status.previousSecondaryDns, null);
  assert.equal(Number.isFinite(Date.parse(status.createdAt)), true);
});

test('PowerDNS secure manager keeps credential rotation possible but marks its previous secret unrecoverable', async () => {
  const filesystem = rollbackFilesystem();
  const receiptPath = powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH;
  const receipt = JSON.parse(filesystem.files.get(receiptPath).toString('utf8'));
  filesystem.files.set(receiptPath, Buffer.from(`${JSON.stringify({ ...receipt, apiKeyRevision: 1 })}\n`));
  let applied = false;
  const manager = createPowerDnsAuthoritativeSecureManager({
    rollbackSnapshotPath: filesystem.snapshotPath,
    chmodFn: filesystem.chmodFn,
    chownFn: filesystem.chownFn,
    lstatFn: filesystem.lstatFn,
    mkdirFn: filesystem.mkdirFn,
    readFileFn: filesystem.readFileFn,
    renameFn: filesystem.renameFn,
    rmFn: filesystem.rmFn,
    writeFileFn: filesystem.writeFileFn,
    manager: {
      async inspect() { return { satisfied: true }; },
      async apply() { applied = true; return { satisfied: true }; },
    },
  });

  await manager.apply(authoritativeIntent(), { operationId: 'operation-credential-mismatch' });

  assert.equal(applied, true);
  const status = await manager.rollbackStatus({
    operationId: 'operation-credential-mismatch',
    serverId,
    credentialRevision: 2,
  });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'powerdns_rollback_previous_credential_unavailable');
});

test('PowerDNS secure manager restores an exact snapshot after restart and keeps rollback idempotent', async () => {
  const filesystem = rollbackFilesystem();
  const host = rollbackHost(filesystem);
  const firstProcess = secureManagerWithFilesystem(filesystem, host.manager);
  await firstProcess.apply(authoritativeIntent(), { operationId: 'operation-rollback' });
  const status = await firstProcess.rollbackStatus({
    operationId: 'operation-rollback',
    serverId,
    credentialRevision: 2,
  });

  const restarted = secureManagerWithFilesystem(filesystem, host.manager);
  const result = await restarted.rollback(authoritativeIntent(), {
    operationId: 'operation-rollback',
    snapshotDigest: status.snapshotDigest,
  });

  assert.equal(result.satisfied, true);
  assert.deepEqual(result.rollback, {
    operationId: 'operation-rollback',
    snapshotDigest: status.snapshotDigest,
    alreadyRestored: false,
  });
  assert.equal(filesystem.files.get(powerDnsTemplatePolicy.configPath).equals(host.previousConfig), true);
  assert.equal(filesystem.files.get(powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH).equals(host.previousReceipt), true);

  const repeated = await restarted.rollback(authoritativeIntent(), {
    operationId: 'operation-rollback',
    snapshotDigest: status.snapshotDigest,
  });
  assert.equal(repeated.rollback.alreadyRestored, true);
  assert.deepEqual(host.activations, ['previous']);
});

test('PowerDNS secure manager rejects a stale snapshot digest before filesystem mutation', async () => {
  const filesystem = rollbackFilesystem();
  const host = rollbackHost(filesystem);
  const manager = secureManagerWithFilesystem(filesystem, host.manager);
  await manager.apply(authoritativeIntent(), { operationId: 'operation-stale-digest' });
  const status = await manager.rollbackStatus({
    operationId: 'operation-stale-digest',
    serverId,
    credentialRevision: 2,
  });
  const staleDigest = `${status.snapshotDigest[0] === 'a' ? 'b' : 'a'}${status.snapshotDigest.slice(1)}`;

  await assert.rejects(
    manager.rollback(authoritativeIntent(), {
      operationId: 'operation-stale-digest',
      snapshotDigest: staleDigest,
    }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_snapshot_stale',
  );
  assert.equal(filesystem.files.get(powerDnsTemplatePolicy.configPath).equals(host.currentConfig), true);
  assert.deepEqual(host.activations, []);
});

test('PowerDNS secure manager compensates a failed rollback activation to the verified current state', async () => {
  const filesystem = rollbackFilesystem();
  const host = rollbackHost(filesystem, { failPreviousActivation: true });
  const manager = secureManagerWithFilesystem(filesystem, host.manager);
  await manager.apply(authoritativeIntent(), { operationId: 'operation-compensated' });
  const status = await manager.rollbackStatus({
    operationId: 'operation-compensated',
    serverId,
    credentialRevision: 2,
  });

  await assert.rejects(
    manager.rollback(authoritativeIntent(), {
      operationId: 'operation-compensated',
      snapshotDigest: status.snapshotDigest,
    }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_api_unhealthy',
  );
  assert.equal(filesystem.files.get(powerDnsTemplatePolicy.configPath).equals(host.currentConfig), true);
  assert.equal(filesystem.files.get(powerDnsAuthoritativeManagerInternals.paths.RECEIPT_PATH).equals(host.currentReceipt), true);
  assert.deepEqual(host.activations, ['previous', 'current']);
});

test('PowerDNS secure manager reports explicit failure when rollback compensation cannot reactivate current state', async () => {
  const filesystem = rollbackFilesystem();
  const host = rollbackHost(filesystem, { failPreviousActivation: true, failCurrentActivation: true });
  const manager = secureManagerWithFilesystem(filesystem, host.manager);
  await manager.apply(authoritativeIntent(), { operationId: 'operation-compensation-failed' });
  const status = await manager.rollbackStatus({
    operationId: 'operation-compensation-failed',
    serverId,
    credentialRevision: 2,
  });

  await assert.rejects(
    manager.rollback(authoritativeIntent(), {
      operationId: 'operation-compensation-failed',
      snapshotDigest: status.snapshotDigest,
    }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_compensation_failed',
  );
  assert.equal(filesystem.files.get(powerDnsTemplatePolicy.configPath).equals(host.currentConfig), true);
  assert.deepEqual(host.activations, ['previous', 'current']);
});

test('PowerDNS secure manager refuses to overwrite unverified current drift', async () => {
  const filesystem = rollbackFilesystem();
  const host = rollbackHost(filesystem);
  const manager = secureManagerWithFilesystem(filesystem, host.manager);
  await manager.apply(authoritativeIntent(), { operationId: 'operation-current-drift' });
  const status = await manager.rollbackStatus({
    operationId: 'operation-current-drift',
    serverId,
    credentialRevision: 2,
  });
  const drift = Buffer.from('manual-current-drift\n');
  filesystem.files.set(powerDnsTemplatePolicy.configPath, drift);

  await assert.rejects(
    manager.rollback(authoritativeIntent(), {
      operationId: 'operation-current-drift',
      snapshotDigest: status.snapshotDigest,
    }),
    (error) => error instanceof PowerDnsAuthoritativeManagerError
      && error.code === 'powerdns_rollback_current_state_unverified',
  );
  assert.equal(filesystem.files.get(powerDnsTemplatePolicy.configPath).equals(drift), true);
  assert.deepEqual(host.activations, []);
});
