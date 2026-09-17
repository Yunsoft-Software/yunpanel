import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLIENT_PATHS = Object.freeze(['/usr/bin/mariadb', '/usr/bin/mysql']);
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const RESERVED_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const CONNECTION_QUERY = 'SELECT VERSION(), @@version_comment;';
const SECURITY_QUERY = `
SELECT HEX(CURRENT_USER()), HEX(USER()),
  HEX(COALESCE((SELECT plugin FROM mysql.user WHERE CONCAT(User, '@', Host) = CURRENT_USER() LIMIT 1), '')),
  (SELECT COUNT(*) FROM mysql.user WHERE User = ''),
  (SELECT COUNT(*) FROM mysql.user WHERE User = 'root' AND Host <> 'localhost'),
  (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'test');
`.trim();
const INHERITED_CREDENTIAL_ENV = Object.freeze([
  'MYSQL_PWD', 'MARIADB_PWD', 'MYSQL_HOST', 'MYSQL_TCP_PORT', 'MYSQL_UNIX_PORT',
]);
const INVENTORY_QUERY = `
SELECT HEX(s.SCHEMA_NAME), COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0)
FROM information_schema.SCHEMATA AS s
LEFT JOIN information_schema.TABLES AS t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
WHERE s.SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
GROUP BY s.SCHEMA_NAME
ORDER BY s.SCHEMA_NAME;
`.trim();

export class DatabaseManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseManagerError';
    this.code = code;
  }
}

function queryArgs(sql) {
  return ['--no-defaults', '--protocol=socket', '--user=root', '--batch', '--skip-column-names', '--raw', `--execute=${sql}`];
}

function socketAdminEnvironment(base = process.env) {
  const environment = { ...base, LC_ALL: 'C' };
  for (const name of INHERITED_CREDENTIAL_ENV) delete environment[name];
  return environment;
}

function requireDatabaseName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!DATABASE_NAME_PATTERN.test(name) || RESERVED_DATABASES.has(name.toLowerCase())) {
    throw new DatabaseManagerError('invalid_database_name', 'Database name must use 1 to 64 letters, numbers or underscores and cannot be a system schema');
  }
  return name;
}

function inferEngine(version, comment) {
  const identity = `${version ?? ''} ${comment ?? ''}`;
  return /mariadb/i.test(identity) ? 'mariadb' : 'mysql';
}

function parseConnection(output) {
  const line = String(output ?? '').split('\n').find((entry) => entry.trim()) ?? '';
  const [version = '', comment = ''] = line.split('\t');
  if (!version || version.length > 120 || /[\u0000-\u001f\u007f]/.test(version)) {
    throw new DatabaseManagerError('database_connection_invalid', 'Database server returned invalid version metadata');
  }
  return { engine: inferEngine(version, comment), version };
}

function parseDatabaseInventory(output) {
  if (!String(output ?? '').trim()) return [];
  const databases = [];
  const names = new Set();
  for (const line of String(output).trimEnd().split('\n')) {
    const [nameHex, sizeText, ...extra] = line.split('\t');
    if (extra.length > 0 || !/^[0-9A-Fa-f]{2,1024}$/.test(nameHex ?? '') || (nameHex.length % 2) !== 0 || !/^\d+$/.test(sizeText ?? '')) {
      throw new DatabaseManagerError('database_inventory_invalid', 'Database inventory returned malformed metadata');
    }
    const name = Buffer.from(nameHex, 'hex').toString('utf8');
    if (!name || name.length > 64 || RESERVED_DATABASES.has(name.toLowerCase()) || names.has(name)) {
      throw new DatabaseManagerError('database_inventory_invalid', 'Database inventory returned an invalid schema identity');
    }
    const size = BigInt(sizeText);
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DatabaseManagerError('database_inventory_invalid', 'Database size exceeds the supported numeric range');
    }
    names.add(name);
    databases.push({ name, sizeBytes: Number(size) });
  }
  return databases;
}

function parseHexText(value, { allowEmpty = false, maxLength = 120 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || value.length > maxLength * 2 || value.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(value)) {
    throw new DatabaseManagerError('database_security_evidence_invalid', 'Database security evidence is invalid');
  }
  const text = Buffer.from(value, 'hex').toString('utf8');
  if ((!allowEmpty && !text) || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new DatabaseManagerError('database_security_evidence_invalid', 'Database security evidence is invalid');
  }
  return text;
}

function parseSecurityBaseline(output, connection) {
  const line = String(output ?? '').trimEnd();
  const fields = line.split('\t');
  if (fields.length !== 6 || fields.slice(3).some((value) => !/^\d+$/.test(value))) {
    throw new DatabaseManagerError('database_security_evidence_invalid', 'Database security evidence is invalid');
  }
  const effectiveAccount = parseHexText(fields[0]);
  const loginAccount = parseHexText(fields[1]);
  const authPlugin = parseHexText(fields[2], { allowEmpty: true, maxLength: 64 });
  const counts = fields.slice(3).map(Number);
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100_000)) {
    throw new DatabaseManagerError('database_security_evidence_invalid', 'Database security evidence is invalid');
  }
  const nativeSocketAuth = effectiveAccount === 'root@localhost'
    && loginAccount === 'root@localhost'
    && ['unix_socket', 'auth_socket'].includes(authPlugin.toLowerCase());
  const hygiene = Object.freeze({
    anonymousAccountsAbsent: counts[0] === 0,
    remoteRootAccountsAbsent: counts[1] === 0,
    testSchemaAbsent: counts[2] === 0,
  });
  const ready = nativeSocketAuth && Object.values(hygiene).every(Boolean);
  const reason = !nativeSocketAuth
    ? 'database_native_socket_admin_auth_required'
    : !hygiene.anonymousAccountsAbsent
      ? 'database_anonymous_accounts_present'
      : !hygiene.remoteRootAccountsAbsent
        ? 'database_remote_root_accounts_present'
        : !hygiene.testSchemaAbsent
          ? 'database_test_schema_present'
          : null;
  return Object.freeze({
    engine: connection.engine,
    version: connection.version,
    connection: Object.freeze({
      protocol: 'socket',
      adminAccount: effectiveAccount,
      loginAccount,
      authPlugin,
      nativeSocketAuth,
    }),
    hygiene,
    ready,
    reason,
  });
}

function createSql(name) {
  return `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
}

function dropSql(name) {
  return `DROP DATABASE \`${name}\`;`;
}

export function createDatabaseManager({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    ...options,
  }),
  clientPaths = CLIENT_PATHS,
} = {}) {
  if (!Array.isArray(clientPaths) || clientPaths.length < 1 || clientPaths.some((entry) => !CLIENT_PATHS.includes(entry))) {
    throw new Error('database client paths must use the fixed supported allowlist');
  }
  let activeMutation = null;

  async function runClient(client, sql, { timeout = 30_000 } = {}) {
    return run(client, queryArgs(sql), {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: socketAdminEnvironment(),
    });
  }

  async function connect() {
    for (const client of clientPaths) {
      try {
        const { stdout } = await runClient(client, CONNECTION_QUERY, { timeout: 5_000 });
        return { client, ...parseConnection(stdout) };
      } catch {
        // A missing client, stopped server or unavailable local socket all move
        // to the next fixed client path. No credential fallback is attempted.
      }
    }
    throw new DatabaseManagerError('database_connection_unavailable', 'No supported local MySQL/MariaDB socket connection is available');
  }

  async function inventory(connection = null) {
    const active = connection ?? await connect();
    let stdout;
    try {
      ({ stdout } = await runClient(active.client, INVENTORY_QUERY));
    } catch {
      throw new DatabaseManagerError('database_inventory_failed', 'Database inventory could not be read from the local server');
    }
    return {
      engine: active.engine,
      version: active.version,
      databases: parseDatabaseInventory(stdout),
    };
  }

  async function inspect() {
    return inventory();
  }

  async function inspectSecurityBaseline() {
    const connection = await connect();
    let stdout;
    try {
      ({ stdout } = await runClient(connection.client, SECURITY_QUERY, { timeout: 5_000 }));
    } catch {
      throw new DatabaseManagerError('database_security_inspection_failed', 'Database security baseline could not be inspected');
    }
    return parseSecurityBaseline(stdout, connection);
  }

  async function withMutation(operation) {
    if (activeMutation) {
      throw new DatabaseManagerError('database_operation_in_progress', 'Another database operation is already running');
    }
    const pending = Promise.resolve().then(operation);
    activeMutation = pending;
    try {
      return await pending;
    } finally {
      if (activeMutation === pending) activeMutation = null;
    }
  }

  async function createDatabase(value) {
    const name = requireDatabaseName(value);
    return withMutation(async () => {
      const connection = await connect();
      const before = await inventory(connection);
      if (before.databases.some((database) => database.name.toLowerCase() === name.toLowerCase())) {
        throw new DatabaseManagerError('database_exists', 'A database with this name already exists');
      }
      try {
        await runClient(connection.client, createSql(name));
      } catch {
        throw new DatabaseManagerError('database_create_failed', 'Database could not be created');
      }
      const after = await inventory(connection);
      const database = after.databases.find((entry) => entry.name === name);
      if (!database) throw new DatabaseManagerError('database_create_unconfirmed', 'Database creation could not be confirmed');
      return { engine: after.engine, version: after.version, database, created: true };
    });
  }

  async function dropDatabase(value) {
    const name = requireDatabaseName(value);
    return withMutation(async () => {
      const connection = await connect();
      const before = await inventory(connection);
      const existing = before.databases.find((database) => database.name === name);
      if (!existing) throw new DatabaseManagerError('database_not_found', 'Database was not found');
      try {
        await runClient(connection.client, dropSql(name));
      } catch {
        throw new DatabaseManagerError('database_drop_failed', 'Database could not be deleted');
      }
      const after = await inventory(connection);
      if (after.databases.some((database) => database.name === name)) {
        throw new DatabaseManagerError('database_drop_unconfirmed', 'Database deletion could not be confirmed');
      }
      return { engine: after.engine, version: after.version, database: existing, deleted: true };
    });
  }

  return { inspect, inspectSecurityBaseline, createDatabase, dropDatabase };
}

export const databaseManager = createDatabaseManager();
export const databaseManagerPolicy = Object.freeze({
  clientPaths: CLIENT_PATHS,
  reservedDatabases: Object.freeze([...RESERVED_DATABASES]),
});
export const databaseManagerInternals = Object.freeze({
  queryArgs,
  requireDatabaseName,
  inferEngine,
  parseConnection,
  parseDatabaseInventory,
  parseSecurityBaseline,
  createSql,
  dropSql,
  socketAdminEnvironment,
  inventoryQuery: INVENTORY_QUERY,
  connectionQuery: CONNECTION_QUERY,
  securityQuery: SECURITY_QUERY,
});
