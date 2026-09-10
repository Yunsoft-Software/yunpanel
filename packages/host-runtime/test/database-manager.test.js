import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatabaseManager,
  DatabaseManagerError,
  databaseManagerInternals,
} from '../src/database-manager.js';

const hex = (value) => Buffer.from(value, 'utf8').toString('hex').toUpperCase();

function fixture({ mariadb = true } = {}) {
  const calls = [];
  const databases = new Map([['app_main', 1024], ['analytics', 4096]]);
  const run = async (file, args) => {
    const sql = args.find((arg) => arg.startsWith('--execute='))?.slice('--execute='.length) ?? '';
    calls.push({ file, args, sql });
    if (sql === databaseManagerInternals.connectionQuery) {
      if (file === '/usr/bin/mariadb' && !mariadb) throw new Error('client unavailable');
      return file === '/usr/bin/mariadb'
        ? { stdout: '10.11.13-MariaDB-0ubuntu0.24.04.1\tUbuntu 24.04\n' }
        : { stdout: '8.0.43\tMySQL Community Server - GPL\n' };
    }
    if (sql === databaseManagerInternals.inventoryQuery) {
      return { stdout: [...databases].sort(([a], [b]) => a.localeCompare(b)).map(([name, size]) => `${hex(name)}\t${size}`).join('\n') + '\n' };
    }
    const create = sql.match(/^CREATE DATABASE `([A-Za-z0-9_]{1,64})` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;$/);
    if (create) { databases.set(create[1], 0); return { stdout: '' }; }
    const drop = sql.match(/^DROP DATABASE `([A-Za-z0-9_]{1,64})`;$/);
    if (drop) { databases.delete(drop[1]); return { stdout: '' }; }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { calls, databases, manager: createDatabaseManager({ run }) };
}

test('inspect uses the local socket and returns non-system schema sizes', async () => {
  const fx = fixture();
  const result = await fx.manager.inspect();
  assert.equal(result.engine, 'mariadb');
  assert.equal(result.version, '10.11.13-MariaDB-0ubuntu0.24.04.1');
  assert.deepEqual(result.databases, [
    { name: 'analytics', sizeBytes: 4096 },
    { name: 'app_main', sizeBytes: 1024 },
  ]);
  assert.ok(fx.calls.every((call) => call.args.includes('--protocol=socket')));
  assert.equal(fx.calls.some((call) => call.args.some((arg) => arg.includes('password'))), false);
});

test('client discovery falls back from MariaDB CLI to MySQL CLI without credentials', async () => {
  const fx = fixture({ mariadb: false });
  const result = await fx.manager.inspect();
  assert.equal(result.engine, 'mysql');
  assert.equal(result.version, '8.0.43');
  assert.deepEqual(fx.calls.slice(0, 2).map((call) => call.file), ['/usr/bin/mariadb', '/usr/bin/mysql']);
});

test('create and delete verify the resulting server inventory', async () => {
  const fx = fixture();
  const created = await fx.manager.createDatabase('customer_42');
  assert.deepEqual(created.database, { name: 'customer_42', sizeBytes: 0 });
  assert.equal(created.created, true);
  assert.equal(fx.databases.has('customer_42'), true);
  assert.ok(fx.calls.some((call) => call.sql === databaseManagerInternals.createSql('customer_42')));

  const deleted = await fx.manager.dropDatabase('customer_42');
  assert.equal(deleted.database.name, 'customer_42');
  assert.equal(deleted.deleted, true);
  assert.equal(fx.databases.has('customer_42'), false);
  assert.ok(fx.calls.some((call) => call.sql === databaseManagerInternals.dropSql('customer_42')));
});

test('unsafe, system and shell-like database names are rejected before host execution', async () => {
  const calls = [];
  const manager = createDatabaseManager({ run: async (...args) => { calls.push(args); return { stdout: '' }; } });
  for (const name of ['mysql', 'information_schema', '../etc', 'name-with-dash', 'db;DROP TABLE x', '', 'a'.repeat(65)]) {
    await assert.rejects(
      manager.createDatabase(name),
      (error) => error instanceof DatabaseManagerError && error.code === 'invalid_database_name',
    );
  }
  assert.equal(calls.length, 0);
});

test('malformed inventory fails closed instead of exposing ambiguous schema metadata', () => {
  assert.throws(
    () => databaseManagerInternals.parseDatabaseInventory('NOT-HEX\t12\n'),
    (error) => error instanceof DatabaseManagerError && error.code === 'database_inventory_invalid',
  );
  assert.throws(
    () => databaseManagerInternals.parseDatabaseInventory(`${hex('app_main')}\tnot-a-number\n`),
    (error) => error instanceof DatabaseManagerError && error.code === 'database_inventory_invalid',
  );
});

test('database mutations are serialized within the host manager', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inventoryCalls = 0;
  const manager = createDatabaseManager({
    run: async (_file, args) => {
      const sql = args.find((arg) => arg.startsWith('--execute='))?.slice('--execute='.length) ?? '';
      if (sql === databaseManagerInternals.connectionQuery) return { stdout: '10.11.13-MariaDB\tMariaDB\n' };
      if (sql === databaseManagerInternals.inventoryQuery) {
        inventoryCalls += 1;
        if (inventoryCalls === 1) return { stdout: `${hex('app_main')}\t1\n` };
        return { stdout: `${hex('app_main')}\t1\n${hex('held_db')}\t0\n` };
      }
      if (sql === databaseManagerInternals.createSql('held_db')) { await gate; return { stdout: '' }; }
      throw new Error('unexpected query');
    },
  });
  const first = manager.createDatabase('held_db');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    manager.createDatabase('second_db'),
    (error) => error instanceof DatabaseManagerError && error.code === 'database_operation_in_progress',
  );
  release();
  await first;
});
