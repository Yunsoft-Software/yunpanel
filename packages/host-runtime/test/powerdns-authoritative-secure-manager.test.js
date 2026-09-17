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
