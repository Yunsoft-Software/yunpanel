import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabaseCredentialEvidenceInspector } from '../src/database-credential-evidence-inspector.js';

const credentialId = '12345678-1234-4234-8234-123456789012';
const bindingId = '22345678-1234-4234-8234-123456789012';
const username = 'ydb_0123456789abcdef01234567';
const desired = 'a'.repeat(64);
const dbHex = Buffer.from('app_main').toString('hex').toUpperCase();

function bundle() {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 2,
    desiredStateSha256: desired,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    privileges: ['SELECT', 'INSERT'],
  };
}

function fixture({ present = true, marker = true, markerDigest = desired, externalGrant = false } = {}) {
  async function runSql(file, sql) {
    assert.equal(file, '/usr/bin/mariadb');
    if (sql === 'SELECT VERSION(), @@version_comment;') {
      return { stdout: '10.11.13-MariaDB\tDebian\n', stderr: '' };
    }
    if (sql.startsWith('SELECT COUNT(*) FROM mysql.user')) {
      return { stdout: present ? '1\n' : '0\n', stderr: '' };
    }
    if (sql.includes('information_schema.SCHEMA_PRIVILEGES')) {
      if (externalGrant) {
        const other = Buffer.from('other_db').toString('hex').toUpperCase();
        return { stdout: `${other}\tSELECT\n`, stderr: '' };
      }
      return { stdout: `${dbHex}\tINSERT\n${dbHex}\tSELECT\n`, stderr: '' };
    }
    if (sql.includes('information_schema.USER_PRIVILEGES')
      || sql.includes('information_schema.TABLE_PRIVILEGES')
      || sql.includes('information_schema.COLUMN_PRIVILEGES')
      || sql.includes('information_schema.ROUTINE_PRIVILEGES')) {
      return { stdout: '0\n', stderr: '' };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  const hostStateStore = {
    async read() {
      if (!marker) return null;
      return {
        version: 1,
        databaseCredentialId: credentialId,
        databaseBindingId: bindingId,
        databaseName: 'app_main',
        username,
        host: 'localhost',
        credentialRevision: 3,
        bindingRevision: 2,
        desiredStateSha256: markerDigest,
        appliedAt: '2026-09-13T02:00:00.000Z',
      };
    },
  };
  return createDatabaseCredentialEvidenceInspector({
    runSql,
    clientPaths: ['/usr/bin/mariadb'],
    hostStateStore,
  });
}

test('database credential apply evidence requires exact marker and schema grants', async () => {
  const healthy = await fixture().inspectApplied(bundle());
  assert.equal(healthy.applied, true);
  assert.equal(healthy.markerHealthy, true);
  assert.equal(healthy.grantsHealthy, true);
  assert.equal(healthy.sideEffects, false);

  const stale = await fixture({ markerDigest: 'b'.repeat(64) }).inspectApplied(bundle());
  assert.equal(stale.applied, false);
  assert.equal(stale.markerHealthy, false);

  const crossSchema = await fixture({ externalGrant: true }).inspectApplied(bundle());
  assert.equal(crossSchema.applied, false);
  assert.equal(crossSchema.grantsHealthy, false);
});

test('database credential delete evidence requires account and marker absence', async () => {
  const deleted = await fixture({ present: false, marker: false }).inspectDeleted(bundle());
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.accountPresent, false);
  assert.equal(deleted.markerPresent, false);

  assert.equal((await fixture({ present: true, marker: false }).inspectDeleted(bundle())).deleted, false);
  assert.equal((await fixture({ present: false, marker: true }).inspectDeleted(bundle())).deleted, false);
});
