import { spawn } from 'node:child_process';
import {
  createDatabaseCredentialHostStateStore,
  DatabaseCredentialHostStateError,
} from './database-credential-host-state.js';
import { databaseManagerInternals } from './database-manager.js';

const CLIENT_PATHS = Object.freeze(['/usr/bin/mariadb', '/usr/bin/mysql']);
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const USERNAME_PATTERN = /^ydb_[a-f0-9]{24}$/;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_PRIVILEGES = Object.freeze([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX', 'DROP',
  'REFERENCES', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE',
]);
const ALLOWED_PRIVILEGE_SET = new Set(ALLOWED_PRIVILEGES);
const CONNECTION_QUERY = 'SELECT VERSION(), @@version_comment;';
const MAX_OUTPUT = 2 * 1024 * 1024;

export class DatabaseCredentialManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseCredentialManagerError';
    this.code = code;
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function account(value) {
  return `${quote(value.username)}@${quote(value.host)}`;
}

function normalizePrivileges(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ALLOWED_PRIVILEGES.length
    || value.some((entry) => typeof entry !== 'string' || !ALLOWED_PRIVILEGE_SET.has(entry))
    || new Set(value).size !== value.length) {
    throw new DatabaseCredentialManagerError('database_credential_bundle_invalid', 'Database privilege state is invalid');
  }
  return ALLOWED_PRIVILEGES.filter((entry) => value.includes(entry));
}

function normalizeBundle(value, { requirePassword }) {
  const keys = [
    'version', 'databaseCredentialId', 'databaseBindingId', 'credentialRevision', 'bindingRevision',
    'desiredStateSha256', 'databaseName', 'username', 'host', 'privileges',
    ...(requirePassword ? ['password'] : []),
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.version !== 1
    || typeof value.databaseCredentialId !== 'string' || !UUID_PATTERN.test(value.databaseCredentialId)
    || typeof value.databaseBindingId !== 'string' || !UUID_PATTERN.test(value.databaseBindingId)
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || typeof value.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(value.desiredStateSha256)
    || typeof value.databaseName !== 'string' || !DATABASE_NAME_PATTERN.test(value.databaseName)
    || typeof value.username !== 'string' || !USERNAME_PATTERN.test(value.username)
    || value.host !== 'localhost'
    || (requirePassword && (typeof value.password !== 'string' || !PASSWORD_PATTERN.test(value.password)))) {
    throw new DatabaseCredentialManagerError('database_credential_bundle_invalid', 'Database credential bundle is invalid');
  }
  return Object.freeze({ ...value, privileges: Object.freeze(normalizePrivileges(value.privileges)) });
}

function runSqlStdin(file, sql, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--protocol=socket', '--batch', '--skip-column-names', '--raw'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const collect = (target, chunk, bytes, setBytes) => {
      const next = bytes + chunk.length;
      if (next > MAX_OUTPUT) {
        child.kill('SIGKILL');
        finish(new DatabaseCredentialManagerError('database_credential_sql_output_limit', 'Database client output exceeded the safe limit'));
        return;
      }
      target.push(chunk);
      setBytes(next);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, stdoutBytes, (value) => { stdoutBytes = value; }));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, stderrBytes, (value) => { stderrBytes = value; }));
    child.once('error', () => finish(new DatabaseCredentialManagerError('database_credential_client_unavailable', 'Database client could not be started')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new DatabaseCredentialManagerError('database_credential_sql_failed', 'Database client command failed'));
        return;
      }
      finish(null, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DatabaseCredentialManagerError('database_credential_sql_timeout', 'Database client command timed out'));
    }, timeout);
    child.stdin.on('error', () => {});
    child.stdin.end(`${sql}\n`, 'utf8');
  });
}

function parseCount(output, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = String(output ?? '').trim();
  if (!/^\d+$/.test(value)) {
    throw new DatabaseCredentialManagerError('database_credential_evidence_invalid', 'Database count evidence is invalid');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > max) {
    throw new DatabaseCredentialManagerError('database_credential_evidence_invalid', 'Database count evidence is invalid');
  }
  return count;
}

function parsePrivilegeRows(output) {
  if (!String(output ?? '').trim()) return [];
  const rows = [];
  for (const line of String(output).trimEnd().split('\n')) {
    const [schemaHex, privilege, ...extra] = line.split('\t');
    if (extra.length > 0 || !/^[0-9A-Fa-f]{2,128}$/.test(schemaHex ?? '') || schemaHex.length % 2 !== 0
      || typeof privilege !== 'string' || !ALLOWED_PRIVILEGE_SET.has(privilege)) {
      throw new DatabaseCredentialManagerError('database_credential_evidence_invalid', 'Database grant evidence is invalid');
    }
    rows.push({ schema: Buffer.from(schemaHex, 'hex').toString('utf8'), privilege });
  }
  return rows;
}

function parseCreateUser(output) {
  const line = String(output ?? '').trimEnd().split('\n').find(Boolean);
  if (!line) throw new DatabaseCredentialManagerError('database_credential_backup_invalid', 'Database account backup is invalid');
  const fields = line.split('\t');
  const statement = fields.at(-1);
  if (typeof statement !== 'string' || statement.length < 10 || statement.length > 16_384
    || !/^CREATE USER\b/i.test(statement) || /[\u0000\r\n]/.test(statement)) {
    throw new DatabaseCredentialManagerError('database_credential_backup_invalid', 'Database account backup is invalid');
  }
  return statement;
}

function parseGrantStatements(output) {
  if (!String(output ?? '').trim()) return [];
  const statements = String(output).trimEnd().split('\n');
  if (statements.length > 64 || statements.some((statement) => statement.length < 5 || statement.length > 16_384
    || !/^GRANT\b/i.test(statement) || /[\u0000\r]/.test(statement))) {
    throw new DatabaseCredentialManagerError('database_credential_backup_invalid', 'Database grant backup is invalid');
  }
  return statements;
}

function markerMatches(marker, bundle) {
  return marker && marker.databaseCredentialId === bundle.databaseCredentialId
    && marker.databaseBindingId === bundle.databaseBindingId
    && marker.databaseName === bundle.databaseName
    && marker.username === bundle.username && marker.host === bundle.host;
}

export function createDatabaseCredentialManager({
  runSql = runSqlStdin,
  clientPaths = CLIENT_PATHS,
  hostStateStore = createDatabaseCredentialHostStateStore(),
} = {}) {
  if (typeof runSql !== 'function' || !Array.isArray(clientPaths) || clientPaths.length < 1
    || clientPaths.some((entry) => !CLIENT_PATHS.includes(entry))
    || !hostStateStore || typeof hostStateStore.read !== 'function'
    || typeof hostStateStore.write !== 'function' || typeof hostStateStore.remove !== 'function') {
    throw new DatabaseCredentialManagerError('database_credential_dependencies_invalid', 'Database credential manager dependencies are invalid');
  }

  async function connect() {
    for (const client of clientPaths) {
      try {
        const { stdout } = await runSql(client, CONNECTION_QUERY, { timeout: 5_000 });
        return { client, ...databaseManagerInternals.parseConnection(stdout) };
      } catch {
        // Try the next fixed client path. No credential fallback is attempted.
      }
    }
    throw new DatabaseCredentialManagerError('database_connection_unavailable', 'No supported local MySQL/MariaDB socket connection is available');
  }

  async function exists(connection, bundle) {
    const sql = `SELECT COUNT(*) FROM mysql.user WHERE User = ${quote(bundle.username)} AND Host = ${quote(bundle.host)};`;
    const { stdout } = await runSql(connection.client, sql);
    return parseCount(stdout, { max: 1 }) === 1;
  }

  async function snapshotAccount(connection, bundle, accountExists) {
    if (!accountExists) return Object.freeze({ exists: false, createUser: null, grants: Object.freeze([]) });
    const user = account(bundle);
    const [{ stdout: createOutput }, { stdout: grantOutput }] = await Promise.all([
      runSql(connection.client, `SHOW CREATE USER ${user};`),
      runSql(connection.client, `SHOW GRANTS FOR ${user};`),
    ]);
    return Object.freeze({
      exists: true,
      createUser: parseCreateUser(createOutput),
      grants: Object.freeze(parseGrantStatements(grantOutput)),
    });
  }

  async function restoreAccount(connection, bundle, snapshot) {
    const user = account(bundle);
    if (!snapshot.exists) {
      await runSql(connection.client, `DROP USER IF EXISTS ${user};`);
      return;
    }
    const sql = [`DROP USER IF EXISTS ${user};`, `${snapshot.createUser};`, ...snapshot.grants.map((grant) => `${grant};`)].join('\n');
    await runSql(connection.client, sql);
  }

  async function inspectGrants(connection, bundle) {
    const grantee = `'${bundle.username}'@'${bundle.host}'`;
    const schemaSql = `SELECT HEX(TABLE_SCHEMA), PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${quote(grantee)} ORDER BY TABLE_SCHEMA, PRIVILEGE_TYPE;`;
    const globalSql = `SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${quote(grantee)} AND PRIVILEGE_TYPE <> 'USAGE';`;
    const tableSql = `SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`;
    const columnSql = `SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`;
    const routineSql = `SELECT COUNT(*) FROM information_schema.ROUTINE_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`;
    const [schema, global, table, column, routine] = await Promise.all([
      runSql(connection.client, schemaSql),
      runSql(connection.client, globalSql),
      runSql(connection.client, tableSql),
      runSql(connection.client, columnSql),
      runSql(connection.client, routineSql),
    ]);
    return Object.freeze({
      schema: Object.freeze(parsePrivilegeRows(schema.stdout)),
      global: parseCount(global.stdout),
      table: parseCount(table.stdout),
      column: parseCount(column.stdout),
      routine: parseCount(routine.stdout),
    });
  }

  function grantsSafeForManagedMutation(bundle, evidence) {
    return evidence.global === 0 && evidence.table === 0 && evidence.column === 0 && evidence.routine === 0
      && evidence.schema.every((entry) => entry.schema === bundle.databaseName);
  }

  function grantsSatisfied(bundle, evidence) {
    if (!grantsSafeForManagedMutation(bundle, evidence)) return false;
    const actual = evidence.schema.map((entry) => entry.privilege).sort();
    const expected = [...bundle.privileges].sort();
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  }

  async function preflightManagedAccount(connection, bundle, marker, accountExists) {
    if (accountExists && !marker) {
      throw new DatabaseCredentialManagerError('database_credential_account_conflict', 'Database account already exists without YunPanel ownership evidence');
    }
    if (!accountExists) return;
    const evidence = await inspectGrants(connection, bundle);
    if (!grantsSafeForManagedMutation(bundle, evidence)) {
      throw new DatabaseCredentialManagerError('database_credential_grant_drift', 'Database account has grants outside the managed schema boundary');
    }
  }

  async function applyCredential(input) {
    const bundle = normalizeBundle(input, { requirePassword: true });
    const connection = await connect();
    let marker;
    try { marker = await hostStateStore.read(bundle.databaseCredentialId); }
    catch (error) {
      if (error instanceof DatabaseCredentialHostStateError) {
        throw new DatabaseCredentialManagerError('database_credential_host_state_failed', 'Database credential ownership state could not be read');
      }
      throw error;
    }
    if (marker && !markerMatches(marker, bundle)) {
      throw new DatabaseCredentialManagerError('database_credential_host_state_mismatch', 'Database credential ownership marker does not match desired state identity');
    }
    const accountExists = await exists(connection, bundle);
    await preflightManagedAccount(connection, bundle, marker, accountExists);
    const snapshot = await snapshotAccount(connection, bundle, accountExists);
    let mutated = false;
    try {
      const user = account(bundle);
      const grantList = bundle.privileges.join(', ');
      const sql = [
        `CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${quote(bundle.password)};`,
        `ALTER USER ${user} IDENTIFIED BY ${quote(bundle.password)};`,
        `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${user};`,
        `GRANT ${grantList} ON \`${bundle.databaseName}\`.* TO ${user};`,
      ].join('\n');
      mutated = true;
      await runSql(connection.client, sql);
      if (!await exists(connection, bundle)) {
        throw new DatabaseCredentialManagerError('database_credential_apply_unconfirmed', 'Database account creation could not be confirmed');
      }
      const evidence = await inspectGrants(connection, bundle);
      if (!grantsSatisfied(bundle, evidence)) {
        throw new DatabaseCredentialManagerError('database_credential_apply_unconfirmed', 'Database grants do not match desired state');
      }
      await hostStateStore.write({
        databaseCredentialId: bundle.databaseCredentialId,
        databaseBindingId: bundle.databaseBindingId,
        databaseName: bundle.databaseName,
        username: bundle.username,
        host: bundle.host,
        credentialRevision: bundle.credentialRevision,
        bindingRevision: bundle.bindingRevision,
        desiredStateSha256: bundle.desiredStateSha256,
      });
      return Object.freeze({
        version: 1,
        databaseCredentialId: bundle.databaseCredentialId,
        databaseBindingId: bundle.databaseBindingId,
        credentialRevision: bundle.credentialRevision,
        bindingRevision: bundle.bindingRevision,
        databaseName: bundle.databaseName,
        username: bundle.username,
        host: bundle.host,
        desiredStateSha256: bundle.desiredStateSha256,
        applied: true,
        sideEffects: true,
      });
    } catch (error) {
      if (mutated) {
        try {
          await restoreAccount(connection, bundle, snapshot);
          if (marker) await hostStateStore.write(marker); else await hostStateStore.remove(bundle.databaseCredentialId);
        } catch {
          throw new DatabaseCredentialManagerError('database_credential_rollback_failed', 'Database credential apply failed and rollback could not be confirmed');
        }
      }
      if (error instanceof DatabaseCredentialManagerError) throw error;
      throw new DatabaseCredentialManagerError('database_credential_apply_failed', 'Database credential could not be applied');
    }
  }

  async function deleteCredential(input) {
    const bundle = normalizeBundle(input, { requirePassword: false });
    const connection = await connect();
    let marker;
    try { marker = await hostStateStore.read(bundle.databaseCredentialId); }
    catch {
      throw new DatabaseCredentialManagerError('database_credential_host_state_failed', 'Database credential ownership state could not be read');
    }
    if (marker && !markerMatches(marker, bundle)) {
      throw new DatabaseCredentialManagerError('database_credential_host_state_mismatch', 'Database credential ownership marker does not match desired state identity');
    }
    const accountExists = await exists(connection, bundle);
    await preflightManagedAccount(connection, bundle, marker, accountExists);
    const snapshot = await snapshotAccount(connection, bundle, accountExists);
    let mutated = false;
    try {
      if (accountExists) {
        mutated = true;
        await runSql(connection.client, `DROP USER ${account(bundle)};`);
      }
      if (await exists(connection, bundle)) {
        throw new DatabaseCredentialManagerError('database_credential_delete_unconfirmed', 'Database account deletion could not be confirmed');
      }
      await hostStateStore.remove(bundle.databaseCredentialId);
      return Object.freeze({
        version: 1,
        databaseCredentialId: bundle.databaseCredentialId,
        databaseBindingId: bundle.databaseBindingId,
        credentialRevision: bundle.credentialRevision,
        bindingRevision: bundle.bindingRevision,
        databaseName: bundle.databaseName,
        username: bundle.username,
        host: bundle.host,
        desiredStateSha256: bundle.desiredStateSha256,
        deleted: true,
        sideEffects: true,
      });
    } catch (error) {
      if (mutated) {
        try {
          await restoreAccount(connection, bundle, snapshot);
          if (marker) await hostStateStore.write(marker);
        } catch {
          throw new DatabaseCredentialManagerError('database_credential_rollback_failed', 'Database credential delete failed and rollback could not be confirmed');
        }
      }
      if (error instanceof DatabaseCredentialManagerError) throw error;
      throw new DatabaseCredentialManagerError('database_credential_delete_failed', 'Database credential could not be deleted');
    }
  }

  return Object.freeze({ applyCredential, deleteCredential });
}

export const databaseCredentialManagerInternals = Object.freeze({
  clientPaths: CLIENT_PATHS,
  allowedPrivileges: ALLOWED_PRIVILEGES,
  normalizeBundle,
  runSqlStdin,
  parseCount,
  parsePrivilegeRows,
  parseCreateUser,
  parseGrantStatements,
  grantsSafeForManagedMutation,
  grantsSatisfied,
  quote,
  account,
});
