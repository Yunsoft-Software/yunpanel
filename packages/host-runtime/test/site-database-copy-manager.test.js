import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSiteDatabaseCopyManager } from '../src/site-database-copy-manager.js';

const nativeSocket = process.env.YUNPANEL_TEST_MARIADB_SOCKET;
const nativeDatadir = process.env.YUNPANEL_TEST_MARIADB_DATADIR;
const nativeClient = process.env.YUNPANEL_TEST_MARIADB_CLIENT || '/usr/bin/mariadb';
const nativeDump = process.env.YUNPANEL_TEST_MARIADB_DUMP || '/usr/bin/mariadb-dump';
const nativeEnabled = Boolean(nativeSocket || nativeDatadir);

function managedIdentity(kind) {
  const id = randomBytes(12).toString('hex');
  return { databaseName: `t927${kind}_${id}`, username: `ydb_${id}`, host: 'localhost' };
}

test('rejects invalid database identities before opening the client', async () => {
  const manager = createSiteDatabaseCopyManager();
  const source = managedIdentity('s');
  const target = managedIdentity('t');
  for (const invalidTarget of [source, { ...target, databaseName: 'mysql' }, { ...target, host: '127.0.0.1' }, { ...target, username: 'root' }]) {
    await assert.rejects(manager.inspect({ source, target: invalidTarget }), { code: 'site_database_copy_identity_invalid' });
  }
  await assert.rejects(manager.copy({ source, target, expectedInventorySha256: '0'.repeat(64) }), { code: 'site_database_copy_input_invalid' });
  assert.throws(() => createSiteDatabaseCopyManager({ socketPath: 'relative.sock' }), { code: 'site_database_copy_paths_invalid' });
});

function cli(options, sql) {
  const result = spawnSync(nativeClient, [...options, '--protocol=socket', `--socket=${nativeSocket}`, '--batch', '--raw',
    '--skip-column-names', '--local-infile=0', '--binary-mode', '--skip-reconnect', '--connect-timeout=5', '--default-character-set=utf8mb4'],
  { input: sql, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  return { status: result.status, stdout: result.stdout?.trimEnd() };
}

function query(sql, options = ['--no-defaults', '--user=root']) {
  const { status, stdout } = cli(options, sql);
  assert.equal(status, 0, 'fixture MariaDB query must complete');
  return stdout;
}

function schemaTables(identity) {
  return query(`SELECT COUNT(*) FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY '${identity.databaseName}';`);
}

test('copies real isolated MariaDB tables and rows through their own users', {
  skip: nativeEnabled ? false : 'set the socket and datadir of a dedicated, socket-only temporary MariaDB instance',
}, async (t) => {
  assert.ok(path.isAbsolute(nativeSocket ?? '') && path.isAbsolute(nativeDatadir ?? ''), 'the dedicated socket and datadir paths are required');
  const datadir = await realpath(nativeDatadir);
  const directory = path.dirname(datadir);
  assert.match(path.basename(directory), /^yunpanel-t927-[A-Za-z0-9_-]+$/);
  assert.equal(path.dirname(await realpath(nativeSocket)), directory);
  assert.ok((await lstat(nativeSocket)).isSocket());
  const [version, actualData, actualSocket, skipNetworking, user] = query('SELECT VERSION(), @@datadir, @@socket, @@skip_networking, CURRENT_USER();').split('\t');
  assert.match(version, /MariaDB/);
  assert.equal(await realpath(actualData), datadir);
  assert.equal(await realpath(actualSocket), await realpath(nativeSocket));
  assert.equal(skipNetworking, '1');
  assert.equal(user, 'root@localhost');

  const source = { ...managedIdentity('s'), password: `${randomBytes(24).toString('hex')}#Yp!:` };
  const target = { ...managedIdentity('t'), password: `${randomBytes(24).toString('hex')}#Yp!:` };
  const third = managedIdentity('x');
  const secretDirectory = await mkdtemp(path.join(tmpdir(), 'yunpanel-t927-test-options-'));
  t.after(async () => {
    await rm(secretDirectory, { recursive: true, force: true });
  });
  t.after(() => {
    query(`DROP DATABASE IF EXISTS \`${third.databaseName}\`; DROP DATABASE IF EXISTS \`${target.databaseName}\`;
      DROP DATABASE IF EXISTS \`${source.databaseName}\`;
      DROP USER IF EXISTS '${source.username}'@'localhost'; DROP USER IF EXISTS '${target.username}'@'localhost';`);
  });
  const grants = 'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES';
  for (const identity of [source, target]) {
    query(`CREATE DATABASE \`${identity.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER '${identity.username}'@'localhost' IDENTIFIED BY '${identity.password}';
      GRANT ${grants} ON \`${identity.databaseName}\`.* TO '${identity.username}'@'localhost';`);
  }
  query(`CREATE DATABASE \`${third.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);

  const targetOptions = path.join(secretDirectory, 'target.cnf');
  await writeFile(targetOptions, `[client]\nuser=${target.username}\npassword="${target.password}"\n`, { flag: 'wx', mode: 0o600 });
  const asTarget = [`--defaults-file=${targetOptions}`, `--database=${target.databaseName}`];
  const src = `\`${source.databaseName}\``;
  const dst = `\`${target.databaseName}\``;
  query(`CREATE TABLE ${src}.items(id INT PRIMARY KEY AUTO_INCREMENT, note VARCHAR(60) NOT NULL, payload MEDIUMBLOB NOT NULL) ENGINE=InnoDB;
    INSERT INTO ${src}.items(note, payload) VALUES ('Kaynak Türkçe 👋', X'000AFF80000D');`);
  const manager = createSiteDatabaseCopyManager({ socketPath: nativeSocket, clientPath: nativeClient, dumpPath: nativeDump });

  await t.test('rejects changed inventories and occupied destinations without touching the target', async () => {
    const preview = await manager.inspect({ source, target });
    assert.deepEqual(Object.keys(preview).sort(), ['inventorySha256', 'sourceTables']);
    assert.equal(preview.sourceTables, 1);
    query(`CREATE TABLE ${src}.added(id INT) ENGINE=InnoDB;`);
    await assert.rejects(manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_inventory_stale' });
    assert.equal(schemaTables(target), '0');
    query(`DROP TABLE ${src}.added; CREATE TABLE ${dst}.existing(id INT) ENGINE=InnoDB; INSERT INTO ${dst}.existing VALUES(101);`);
    await assert.rejects(manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_target_occupied' });
    assert.equal(query(`SELECT id FROM ${dst}.existing;`), '101');
    query(`DROP TABLE ${dst}.existing;`);
  });

  await t.test('rejects unsupported source objects even when the source user lacks their privileges', async () => {
    for (const [create, remove] of [
      [`CREATE VIEW ${src}.v_items AS SELECT id FROM ${src}.items;`, `DROP VIEW ${src}.v_items;`],
      [`CREATE TABLE ${src}.legacy(id INT) ENGINE=MyISAM;`, `DROP TABLE ${src}.legacy;`],
      [`CREATE TRIGGER ${src}.no_copy BEFORE INSERT ON ${src}.items FOR EACH ROW SET NEW.note = '';`, `DROP TRIGGER ${src}.no_copy;`],
      [`CREATE PROCEDURE ${src}.no_copy() SELECT 1;`, `DROP PROCEDURE ${src}.no_copy;`],
      [`CREATE EVENT ${src}.no_copy ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1;`, `DROP EVENT ${src}.no_copy;`],
      [`CREATE TABLE \`${third.databaseName}\`.reference_item(id INT PRIMARY KEY, FOREIGN KEY(id) REFERENCES ${src}.items(id)) ENGINE=InnoDB;`,
        `DROP TABLE \`${third.databaseName}\`.reference_item;`],
    ]) {
      query(create);
      await assert.rejects(manager.inspect({ source, target }), { code: 'site_database_copy_schema_unsupported' });
      assert.equal(schemaTables(target), '0');
      query(remove);
    }
    query(`CREATE VIEW ${dst}.occupied_view AS SELECT 1 AS n;`);
    await assert.rejects(manager.inspect({ source, target }), { code: 'site_database_copy_schema_unsupported' });
    query(`DROP VIEW ${dst}.occupied_view;`);
  });

  await t.test('stops on excess export data or incorrect source credentials with an empty target', async () => {
    const preview = await manager.inspect({ source, target });
    await assert.rejects(manager.copy({ source: { ...source, password: randomBytes(24).toString('hex') }, target,
      expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_export_failed' });
    query(`INSERT INTO ${src}.items(note, payload) VALUES ('limit', REPEAT(X'AB', 9 * 1024 * 1024));`);
    await assert.rejects(manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_dump_limit' });
    assert.equal(schemaTables(target), '0');
    query(`DELETE FROM ${src}.items WHERE note = 'limit';`);
  });

  await t.test('never substitutes the administrator for unavailable target credentials', async () => {
    const preview = await manager.inspect({ source, target });
    await assert.rejects(manager.copy({ source, target: { ...target, password: randomBytes(24).toString('hex') },
      expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_target_uncertain' });
    assert.equal(schemaTables(target), '0');
  });

  await t.test('rechecks authorization without passing credentials to the hook before any import', async () => {
    const preview = await manager.inspect({ source, target });
    let calls = 0;
    await assert.rejects(manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256, authorizeBeforeImport: (...args) => {
      calls += 1;
      assert.deepEqual(args, []);
      return false;
    } }), { code: 'site_database_copy_authorization_changed' });
    assert.equal(calls, 1);
    assert.equal(schemaTables(target), '0');
  });

  await t.test('preserves UTF-8, binary data and source identity while the target writes independently', async () => {
    query(`CREATE TABLE ${src}.related(id INT PRIMARY KEY, FOREIGN KEY(id) REFERENCES ${src}.items(id)) ENGINE=InnoDB;
      INSERT INTO ${src}.related VALUES (1);`);
    const preview = await manager.inspect({ source, target });
    const result = await manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256 });
    assert.equal(result.tables, 2);
    assert.ok(result.bytes > 0);
    assert.deepEqual(Object.keys(result).sort(), ['bytes', 'tables']);
    assert.equal(query('SELECT CURRENT_USER();', asTarget), `${target.username}@localhost`);
    assert.equal(query('SELECT id, note, HEX(payload) FROM items;', asTarget), '1\tKaynak Türkçe 👋\t000AFF80000D');
    assert.equal(query('SELECT id FROM related;', asTarget), '1');
    assert.equal(query(`SELECT REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = '${target.databaseName}'
      AND TABLE_NAME = 'related' AND REFERENCED_TABLE_NAME = 'items';`), target.databaseName);
    query('INSERT INTO items(note, payload) VALUES (\'Hedef\', X\'11\');', asTarget);
    assert.equal(query('SELECT COUNT(*) FROM items;', asTarget), '2');
    assert.equal(query(`SELECT id, note, HEX(payload) FROM ${src}.items;`), '1\tKaynak Türkçe 👋\t000AFF80000D');
    assert.notEqual(cli(asTarget, `SELECT id FROM ${src}.items;`).status, 0);
    await assert.rejects(manager.copy({ source, target, expectedInventorySha256: preview.inventorySha256 }), { code: 'site_database_copy_target_occupied' });
    assert.equal(query('SELECT COUNT(*) FROM items;', asTarget), '2');
  });
});
