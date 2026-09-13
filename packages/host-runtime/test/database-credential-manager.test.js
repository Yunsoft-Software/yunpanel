import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatabaseCredentialManager,
  DatabaseCredentialManagerError,
} from '../src/database-credential-manager.js';

const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const username = 'ydb_0123456789abcdef01234567';
const secret = Buffer.alloc(32, 4).toString('base64url');
const desired = 'a'.repeat(64);
const dbHex = Buffer.from('app_main').toString('hex').toUpperCase();

function applyBundle(overrides = {}) {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 1,
    desiredStateSha256: desired,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    password: secret,
    ...overrides,
  };
}

function fakeRuntime({ accountExists = false, marker = null, externalSchema = null, failDesiredEvidence = false } = {}) {
  const calls = [];
  let exists = accountExists;
  let currentMarker = marker;
  let desiredApplied = false;
  const previousCreate = `CREATE USER '${username}'@'localhost' IDENTIFIED VIA mysql_native_password USING '*OLDHASH'`;
  const previousGrant = `GRANT SELECT ON \`app_main\`.* TO '${username}'@'localhost'`;

  async function runSql(client, sql) {
    calls.push([client, sql]);
    if (sql === 'SELECT VERSION(), @@version_comment;') {
      return { stdout: '10.11.13-MariaDB\tDebian 12\n', stderr: '' };
    }
    if (sql.startsWith('SELECT COUNT(*) FROM mysql.user')) {
      return { stdout: exists ? '1\n' : '0\n', stderr: '' };
    }
    if (sql.startsWith('SHOW CREATE USER')) {
      return { stdout: `CREATE USER for ${username}@localhost\t${previousCreate}\n`, stderr: '' };
    }
    if (sql.startsWith('SHOW GRANTS FOR')) {
      return { stdout: `${previousGrant}\n`, stderr: '' };
    }
    if (sql.includes('information_schema.SCHEMA_PRIVILEGES')) {
      if (externalSchema) {
        return { stdout: `${Buffer.from(externalSchema).toString('hex').toUpperCase()}\tSELECT\n`, stderr: '' };
      }
      if (!desiredApplied) return { stdout: accountExists ? `${dbHex}\tSELECT\n` : '', stderr: '' };
      if (failDesiredEvidence) return { stdout: `${dbHex}\tSELECT\n`, stderr: '' };
      return { stdout: `${dbHex}\tINSERT\n${dbHex}\tSELECT\n${dbHex}\tUPDATE\n`, stderr: '' };
    }
    if (sql.includes('information_schema.USER_PRIVILEGES')
      || sql.includes('information_schema.TABLE_PRIVILEGES')
      || sql.includes('information_schema.COLUMN_PRIVILEGES')
      || sql.includes('information_schema.ROUTINE_PRIVILEGES')) {
      return { stdout: '0\n', stderr: '' };
    }
    if (sql.includes('CREATE USER IF NOT EXISTS')) {
      exists = true;
      desiredApplied = true;
      return { stdout: '', stderr: '' };
    }
    if (sql.startsWith('DROP USER IF EXISTS') && sql.includes(previousCreate)) {
      exists = true;
      desiredApplied = false;
      return { stdout: '', stderr: '' };
    }
    if (sql.startsWith('DROP USER IF EXISTS')) {
      exists = false;
      desiredApplied = false;
      return { stdout: '', stderr: '' };
    }
    if (sql.startsWith('DROP USER ')) {
      exists = false;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  const hostStateStore = {
    async read() { return currentMarker; },
    async write(value) {
      currentMarker = { version: 1, appliedAt: '2026-09-13T03:00:00.000Z', ...value };
      return currentMarker;
    },
    async remove() { currentMarker = null; return { removed: true }; },
  };
  const manager = createDatabaseCredentialManager({ runSql, clientPaths: ['/usr/bin/mariadb'], hostStateStore });
  return { manager, calls, marker: () => currentMarker, exists: () => exists, previousCreate, previousGrant };
}

test('database credential apply creates one localhost account with only desired schema grants', async () => {
  const state = fakeRuntime();
  const result = await state.manager.applyCredential(applyBundle());
  assert.equal(result.applied, true);
  assert.equal(result.databaseName, 'app_main');
  assert.equal(result.username, username);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(state.exists(), true);
  assert.equal(state.marker().desiredStateSha256, desired);

  const mutation = state.calls.find(([, sql]) => sql.includes('CREATE USER IF NOT EXISTS'))[1];
  assert.match(mutation, /REVOKE ALL PRIVILEGES, GRANT OPTION/);
  assert.match(mutation, /GRANT SELECT, INSERT, UPDATE ON `app_main`\.\*/);
  assert.equal(state.calls.every(([client]) => client === '/usr/bin/mariadb'), true);
});

test('pre-existing unowned or cross-schema account is never modified', async () => {
  const unowned = fakeRuntime({ accountExists: true, marker: null });
  await assert.rejects(
    unowned.manager.applyCredential(applyBundle()),
    (error) => error instanceof DatabaseCredentialManagerError && error.code === 'database_credential_account_conflict',
  );
  assert.equal(unowned.calls.some(([, sql]) => sql.includes('ALTER USER')), false);

  const marker = {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    credentialRevision: 2,
    bindingRevision: 1,
    desiredStateSha256: 'b'.repeat(64),
    appliedAt: '2026-09-13T02:00:00.000Z',
  };
  const drifted = fakeRuntime({ accountExists: true, marker, externalSchema: 'other_db' });
  await assert.rejects(
    drifted.manager.applyCredential(applyBundle()),
    (error) => error instanceof DatabaseCredentialManagerError && error.code === 'database_credential_grant_drift',
  );
  assert.equal(drifted.calls.some(([, sql]) => sql.includes('ALTER USER')), false);
});

test('post-mutation grant mismatch restores previous account snapshot and marker', async () => {
  const marker = {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    credentialRevision: 2,
    bindingRevision: 1,
    desiredStateSha256: 'b'.repeat(64),
    appliedAt: '2026-09-13T02:00:00.000Z',
  };
  const state = fakeRuntime({ accountExists: true, marker, failDesiredEvidence: true });
  await assert.rejects(
    state.manager.applyCredential(applyBundle()),
    (error) => error instanceof DatabaseCredentialManagerError && error.code === 'database_credential_apply_unconfirmed',
  );
  const rollback = state.calls.find(([, sql]) => sql.startsWith('DROP USER IF EXISTS') && sql.includes(state.previousCreate));
  assert.ok(rollback);
  assert.match(rollback[1], /GRANT SELECT ON `app_main`\.\*/);
  assert.equal(state.marker().credentialRevision, 2);
  assert.equal(state.marker().desiredStateSha256, 'b'.repeat(64));
});
