import {
  createDatabaseCredentialHostStateStore,
  DatabaseCredentialHostStateError,
} from './database-credential-host-state.js';
import { databaseCredentialManagerInternals } from './database-credential-manager.js';
import { databaseManagerInternals } from './database-manager.js';

const CLIENT_PATHS = Object.freeze(['/usr/bin/mariadb', '/usr/bin/mysql']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const USERNAME_PATTERN = /^ydb_[a-f0-9]{24}$/;

export class DatabaseCredentialEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseCredentialEvidenceError';
    this.code = code;
  }
}

function normalizeBundle(value) {
  const fields = [
    'version', 'databaseCredentialId', 'databaseBindingId', 'credentialRevision', 'bindingRevision',
    'desiredStateSha256', 'databaseName', 'username', 'host', 'privileges',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || value.version !== 1
    || typeof value.databaseCredentialId !== 'string' || !UUID_PATTERN.test(value.databaseCredentialId)
    || typeof value.databaseBindingId !== 'string' || !UUID_PATTERN.test(value.databaseBindingId)
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || typeof value.desiredStateSha256 !== 'string' || !SHA256_PATTERN.test(value.desiredStateSha256)
    || typeof value.databaseName !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(value.databaseName)
    || typeof value.username !== 'string' || !USERNAME_PATTERN.test(value.username)
    || value.host !== 'localhost' || !Array.isArray(value.privileges)) {
    throw new DatabaseCredentialEvidenceError('database_credential_evidence_bundle_invalid', 'Database credential evidence bundle is invalid');
  }
  return value;
}

function markerMatches(marker, bundle) {
  return Boolean(marker)
    && marker.databaseCredentialId === bundle.databaseCredentialId
    && marker.databaseBindingId === bundle.databaseBindingId
    && marker.databaseName === bundle.databaseName
    && marker.username === bundle.username
    && marker.host === bundle.host
    && marker.credentialRevision === bundle.credentialRevision
    && marker.bindingRevision === bundle.bindingRevision
    && marker.desiredStateSha256 === bundle.desiredStateSha256;
}

export function createDatabaseCredentialEvidenceInspector({
  runSql = databaseCredentialManagerInternals.runSqlStdin,
  clientPaths = CLIENT_PATHS,
  hostStateStore = createDatabaseCredentialHostStateStore(),
} = {}) {
  if (typeof runSql !== 'function' || !Array.isArray(clientPaths) || clientPaths.length < 1
    || clientPaths.some((entry) => !CLIENT_PATHS.includes(entry))
    || !hostStateStore || typeof hostStateStore.read !== 'function') {
    throw new DatabaseCredentialEvidenceError('database_credential_evidence_dependencies_invalid', 'Database credential evidence dependencies are invalid');
  }

  async function connect() {
    for (const client of clientPaths) {
      try {
        const { stdout } = await runSql(client, 'SELECT VERSION(), @@version_comment;', { timeout: 5_000 });
        return { client, ...databaseManagerInternals.parseConnection(stdout) };
      } catch {
        // Try the next fixed client path. No credential fallback is attempted.
      }
    }
    throw new DatabaseCredentialEvidenceError('database_connection_unavailable', 'No supported local MySQL/MariaDB socket connection is available');
  }

  async function accountPresent(connection, bundle) {
    const quote = databaseCredentialManagerInternals.quote;
    const { stdout } = await runSql(connection.client, `SELECT COUNT(*) FROM mysql.user WHERE User = ${quote(bundle.username)} AND Host = ${quote(bundle.host)};`);
    return databaseCredentialManagerInternals.parseCount(stdout, { max: 1 }) === 1;
  }

  async function inspectGrants(connection, bundle) {
    const quote = databaseCredentialManagerInternals.quote;
    const grantee = `'${bundle.username}'@'${bundle.host}'`;
    const results = await Promise.all([
      runSql(connection.client, `SELECT HEX(TABLE_SCHEMA), PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${quote(grantee)} ORDER BY TABLE_SCHEMA, PRIVILEGE_TYPE;`),
      runSql(connection.client, `SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${quote(grantee)} AND PRIVILEGE_TYPE <> 'USAGE';`),
      runSql(connection.client, `SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`),
      runSql(connection.client, `SELECT COUNT(*) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`),
      runSql(connection.client, `SELECT COUNT(*) FROM information_schema.ROUTINE_PRIVILEGES WHERE GRANTEE = ${quote(grantee)};`),
    ]);
    return Object.freeze({
      schema: Object.freeze(databaseCredentialManagerInternals.parsePrivilegeRows(results[0].stdout)),
      global: databaseCredentialManagerInternals.parseCount(results[1].stdout),
      table: databaseCredentialManagerInternals.parseCount(results[2].stdout),
      column: databaseCredentialManagerInternals.parseCount(results[3].stdout),
      routine: databaseCredentialManagerInternals.parseCount(results[4].stdout),
    });
  }

  async function marker(bundle) {
    try { return await hostStateStore.read(bundle.databaseCredentialId); }
    catch (error) {
      if (error instanceof DatabaseCredentialHostStateError) {
        throw new DatabaseCredentialEvidenceError('database_credential_evidence_marker_failed', 'Database credential ownership marker could not be read');
      }
      throw error;
    }
  }

  async function inspectApplied(input) {
    const bundle = normalizeBundle(input);
    const connection = await connect();
    const liveMarker = await marker(bundle);
    const present = await accountPresent(connection, bundle);
    const grantEvidence = present ? await inspectGrants(connection, bundle) : null;
    const markerHealthy = markerMatches(liveMarker, bundle);
    const grantsHealthy = present && databaseCredentialManagerInternals.grantsSatisfied(bundle, grantEvidence);
    return Object.freeze({
      version: 1,
      engine: connection.engine,
      databaseCredentialId: bundle.databaseCredentialId,
      databaseBindingId: bundle.databaseBindingId,
      databaseName: bundle.databaseName,
      username: bundle.username,
      host: bundle.host,
      desiredStateSha256: bundle.desiredStateSha256,
      accountPresent: present,
      markerHealthy,
      grantsHealthy,
      applied: present && markerHealthy && grantsHealthy,
      sideEffects: false,
    });
  }

  async function inspectDeleted(input) {
    const bundle = normalizeBundle(input);
    const connection = await connect();
    const liveMarker = await marker(bundle);
    const present = await accountPresent(connection, bundle);
    return Object.freeze({
      version: 1,
      engine: connection.engine,
      databaseCredentialId: bundle.databaseCredentialId,
      databaseBindingId: bundle.databaseBindingId,
      databaseName: bundle.databaseName,
      username: bundle.username,
      host: bundle.host,
      desiredStateSha256: bundle.desiredStateSha256,
      accountPresent: present,
      markerPresent: Boolean(liveMarker),
      deleted: !present && !liveMarker,
      sideEffects: false,
    });
  }

  return Object.freeze({ inspectApplied, inspectDeleted });
}

export const databaseCredentialEvidenceInternals = Object.freeze({
  normalizeBundle,
  markerMatches,
});
