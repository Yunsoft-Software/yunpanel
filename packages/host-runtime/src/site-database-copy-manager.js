import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isInfrastructureDatabase } from '@yunpanel/shared';

const DATABASE_NAME = /^[A-Za-z0-9_]{1,64}$/;
const USERNAME = /^ydb_[a-f0-9]{24}$/;
const PASSWORD = /^[A-Za-z0-9_!@#%^*+=.:,-]{16,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TABLE_LIMIT = 256;
const INVENTORY_LIMIT = 128 * 1024;
const DUMP_LIMIT = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const SUPPORTED_PRIVILEGES = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'DROP',
  'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE',
]);
const CLIENT_ENV = Object.freeze({ LC_ALL: 'C', PATH: '/usr/bin:/bin' });

export class SiteDatabaseCopyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SiteDatabaseCopyError';
    this.code = code;
  }
}

function requireLocalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SiteDatabaseCopyError('site_database_copy_paths_invalid', 'MariaDB copy needs fixed local paths');
  }
  return value;
}

function endpoint(value) {
  if (typeof value?.databaseName !== 'string' || !DATABASE_NAME.test(value.databaseName) || isInfrastructureDatabase(value.databaseName)
    || typeof value.username !== 'string' || !USERNAME.test(value.username) || value.host !== 'localhost') {
    throw new SiteDatabaseCopyError('site_database_copy_identity_invalid', 'MariaDB copy requires managed local database identities');
  }
  const { databaseName, username } = value;
  return { databaseName, username };
}

function endpoints(input) {
  const source = endpoint(input?.source);
  const target = endpoint(input?.target);
  if (source.databaseName.toLowerCase() === target.databaseName.toLowerCase() || source.username === target.username) {
    throw new SiteDatabaseCopyError('site_database_copy_identity_invalid', 'Source and target must use different databases and users');
  }
  return { source, target };
}

function run(program, args, input, { timeout, outputLimit }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: CLIENT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    function stop(reason) {
      failure ??= reason;
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => stop('timeout'), timeout);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) stop('output_limit');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) stop('output_limit');
    });
    child.on('error', () => stop('process'));
    child.stdin.on('error', () => stop('input'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new SiteDatabaseCopyError(failure ?? 'process', 'MariaDB client did not complete'));
      else resolve(Buffer.concat(chunks, stdoutBytes));
    });
    child.stdin.end(input);
  });
}

function inventorySql(prefix, { databaseName, username }) {
  const schema = `'${databaseName}'`;
  const grantee = `CONCAT(QUOTE('${username}'), '@', QUOTE('localhost'))`;
  const privileges = `WHERE BINARY GRANTEE = BINARY ${grantee}`;
  return `
SELECT '${prefix}:schema', HEX(DEFAULT_COLLATION_NAME) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = BINARY ${schema};
SELECT '${prefix}:table', HEX(TABLE_NAME), HEX(COALESCE(TABLE_COLLATION, '')),
  IF(TABLE_TYPE = 'BASE TABLE' AND ENGINE = 'InnoDB' AND COALESCE(CREATE_OPTIONS, '') = '', 1, 0),
  COALESCE(UNIX_TIMESTAMP(CREATE_TIME), 0)
FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA = BINARY ${schema}
ORDER BY BINARY TABLE_NAME LIMIT ${TABLE_LIMIT + 1};
SELECT '${prefix}:objects',
  (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA = BINARY ${schema}) +
  (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA = BINARY ${schema}) +
  (SELECT COUNT(*) FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA = BINARY ${schema}) +
  (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
    WHERE BINARY REFERENCED_TABLE_SCHEMA <> BINARY TABLE_SCHEMA AND
      (BINARY TABLE_SCHEMA = BINARY ${schema} OR BINARY REFERENCED_TABLE_SCHEMA = BINARY ${schema}));
SELECT '${prefix}:grant', PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES
  ${privileges} AND BINARY TABLE_SCHEMA = BINARY ${schema} ORDER BY PRIVILEGE_TYPE;
SELECT '${prefix}:boundary',
  ABS(1 - (SELECT COUNT(*) FROM mysql.user WHERE User = '${username}' AND Host = 'localhost' AND is_role = 'N')) +
  (SELECT COUNT(*) FROM mysql.user WHERE User = 'PUBLIC' AND is_role = 'Y') +
  (SELECT COUNT(*) FROM mysql.roles_mapping WHERE User = '${username}' AND Host = 'localhost') +
  (SELECT COUNT(*) FROM mysql.proxies_priv WHERE User = '${username}' AND Host = 'localhost') +
  (SELECT COUNT(*) FROM mysql.procs_priv WHERE User = '${username}' AND Host = 'localhost') +
  (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES ${privileges} AND PRIVILEGE_TYPE <> 'USAGE') +
  (SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES ${privileges} AND BINARY TABLE_SCHEMA <> BINARY ${schema}) +
  (SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES ${privileges}) +
  (SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES ${privileges}) +
  (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME <> BINARY ${schema}
    AND LOWER(SCHEMA_NAME) LIKE LOWER(${schema}));`;
}

function rows(output, key) {
  return output.filter(([tag]) => tag === key).map(([, ...fields]) => fields);
}

function readSchema(output, prefix) {
  const schema = rows(output, `${prefix}:schema`);
  if (!schema.length) throw new SiteDatabaseCopyError('site_database_copy_database_missing', 'Both MariaDB databases must already exist');
  const grants = rows(output, `${prefix}:grant`);
  const privileges = new Set(grants.map(([privilege]) => privilege));
  const required = prefix === 'source' ? ['SELECT'] : ['CREATE', 'INSERT', 'SELECT'];
  if (rows(output, `${prefix}:boundary`).join() !== '0' || grants.some(([privilege, grantable]) => !SUPPORTED_PRIVILEGES.has(privilege) || grantable !== 'NO')
    || required.some((privilege) => !privileges.has(privilege))) {
    throw new SiteDatabaseCopyError('site_database_copy_grants_invalid', 'Database accounts must have only supported privileges on their own database');
  }
  const tableRows = rows(output, `${prefix}:table`);
  if (tableRows.length > TABLE_LIMIT || rows(output, `${prefix}:objects`).join() !== '0'
    || tableRows.some(([hexName, , supported]) => !DATABASE_NAME.test(Buffer.from(hexName, 'hex').toString('utf8')) || supported !== '1')) {
    throw new SiteDatabaseCopyError('site_database_copy_schema_unsupported', 'The database contains unsupported objects or table options');
  }
  return { collation: schema[0][0], tables: tableRows, grants };
}

function inventoryDigest(identities, socketIdentity, source, target) {
  return createHash('sha256').update(JSON.stringify({ identities, socketIdentity, source, target })).digest('hex');
}

async function writeOptions(directory, name, { username, password }) {
  const options = path.join(directory, `${name}.cnf`);
  await writeFile(options, `[client]\nuser=${username}\npassword="${password}"\n`, { flag: 'wx', mode: 0o600 });
  return options;
}

export function createSiteDatabaseCopyManager({
  socketPath = '/run/mysqld/mysqld.sock',
  clientPath = '/usr/bin/mariadb',
  dumpPath = '/usr/bin/mariadb-dump',
} = {}) {
  const socket = requireLocalPath(socketPath);
  const client = requireLocalPath(clientPath);
  const dump = requireLocalPath(dumpPath);
  const connection = ['--protocol=socket', `--socket=${socket}`, '--default-character-set=utf8mb4'];
  const guardedClient = ['--connect-timeout=5', '--batch', '--binary-mode', '--local-infile=0', '--skip-reconnect'];

  async function socketIdentity() {
    const state = await lstat(socket, { bigint: true });
    if (!state.isSocket()) throw new Error('local socket unavailable');
    return `${state.dev}:${state.ino}`;
  }

  async function inventory(identity, { allowTargetTables = false } = {}) {
    const sql = `SELECT 'server', IF(VERSION() LIKE '%MariaDB%' AND BINARY CURRENT_USER() = BINARY 'root@localhost', 1, 0);
${inventorySql('source', identity.source)}
${inventorySql('target', identity.target)}`;
    let output;
    let checkedSocket;
    try {
      checkedSocket = await socketIdentity();
      output = await run(client, ['--no-defaults', ...connection, ...guardedClient, '--user=root', '--skip-column-names', '--raw'], sql,
        { timeout: 15_000, outputLimit: INVENTORY_LIMIT });
      if (await socketIdentity() !== checkedSocket) throw new Error('local socket replaced');
    } catch {
      throw new SiteDatabaseCopyError('site_database_copy_inventory_unavailable', 'Local MariaDB inventory is unavailable');
    }
    const records = output.toString('utf8').trimEnd().split('\n').map((line) => line.split('\t'));
    if (rows(records, 'server').join() !== '1') {
      throw new SiteDatabaseCopyError('site_database_copy_inventory_unavailable', 'Local MariaDB inventory is unavailable');
    }
    const source = readSchema(records, 'source');
    const target = readSchema(records, 'target');
    if (!allowTargetTables && target.tables.length) throw new SiteDatabaseCopyError('site_database_copy_target_occupied', 'The target database must be empty');
    if (!source.tables.length || source.collation !== target.collation) {
      throw new SiteDatabaseCopyError('site_database_copy_schema_unsupported', 'The source needs supported tables and both databases must use the same default collation');
    }
    return { source, target, socket: checkedSocket, digest: inventoryDigest(identity, checkedSocket, source, target) };
  }

  async function inspect(input) {
    const state = await inventory(endpoints(input));
    return Object.freeze({ sourceTables: state.source.tables.length, inventorySha256: state.digest });
  }

  async function copy(input) {
    const identity = endpoints(input);
    const { expectedInventorySha256, authorizeBeforeImport } = input;
    if (typeof expectedInventorySha256 !== 'string' || !SHA256.test(expectedInventorySha256)
      || (authorizeBeforeImport !== undefined && typeof authorizeBeforeImport !== 'function')
      || [input.source.password, input.target.password].some((value) => typeof value !== 'string' || !PASSWORD.test(value))) {
      throw new SiteDatabaseCopyError('site_database_copy_input_invalid', 'A verified inventory and both managed credentials are required');
    }
    const state = await inventory(identity);
    if (state.digest !== expectedInventorySha256) {
      throw new SiteDatabaseCopyError('site_database_copy_inventory_stale', 'MariaDB inventory changed since the preview');
    }

    const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-db-copy-'));
    let exported;
    let importStarted = false;
    try {
      const sourceOptions = await writeOptions(directory, 'source', { ...identity.source, password: input.source.password });
      const tableNames = state.source.tables.map(([hex]) => Buffer.from(hex, 'hex').toString('utf8'));
      try {
        exported = await run(dump, [`--defaults-file=${sourceOptions}`, ...connection, '--skip-opt', '--single-transaction',
          '--quick', '--create-options', '--set-charset', '--extended-insert', '--skip-comments', '--no-tablespaces',
          '--skip-triggers', '--hex-blob', identity.source.databaseName, ...tableNames], null,
        { timeout: 60_000, outputLimit: DUMP_LIMIT });
      } catch (error) {
        if (error.code === 'output_limit') throw new SiteDatabaseCopyError('site_database_copy_dump_limit', 'The database dump exceeds the copy limit');
        throw new SiteDatabaseCopyError('site_database_copy_export_failed', 'The source database could not be exported');
      }
      if (!exported.length) throw new SiteDatabaseCopyError('site_database_copy_export_failed', 'The source database could not be exported');
      if (authorizeBeforeImport && await authorizeBeforeImport() !== true) {
        throw new SiteDatabaseCopyError('site_database_copy_authorization_changed', 'The target is no longer authorized for copy');
      }

      const targetOptions = await writeOptions(directory, 'target', { ...identity.target, password: input.target.password });
      if ((await inventory(identity)).digest !== state.digest) {
        throw new SiteDatabaseCopyError('site_database_copy_inventory_stale', 'MariaDB inventory changed after export');
      }
      try {
        importStarted = true;
        await run(client, [`--defaults-file=${targetOptions}`, ...connection, ...guardedClient, `--database=${identity.target.databaseName}`], exported,
          { timeout: 60_000, outputLimit: INVENTORY_LIMIT });
        const verified = await inventory(identity, { allowTargetTables: true });
        const outline = (schema) => schema.tables.map(([name, collation]) => [name, collation]);
        if (verified.socket !== state.socket || JSON.stringify(outline(verified.target)) !== JSON.stringify(outline(state.source))) {
          throw new Error('target inventory mismatch');
        }
      } catch {
        throw new SiteDatabaseCopyError('site_database_copy_target_uncertain', 'The database copy was interrupted or could not be verified. The target is preserved for inspection');
      }
      return Object.freeze({ tables: tableNames.length, bytes: exported.length });
    } finally {
      exported?.fill(0);
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        if (importStarted) {
          throw new SiteDatabaseCopyError('site_database_copy_target_uncertain', 'Credential cleanup failed after import started. The target is preserved for inspection');
        }
        throw new SiteDatabaseCopyError('site_database_copy_secret_cleanup_failed', 'Temporary credential files could not be cleaned up');
      }
    }
  }

  return Object.freeze({ inspect, copy });
}
