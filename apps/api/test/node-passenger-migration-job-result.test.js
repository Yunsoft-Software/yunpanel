import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sanitizeNodePassengerMigrationResult } from '../src/node-passenger-migration-job-result.js';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const APPLICATION_HASH = createHash('sha256').update(APPLICATION_ID).digest('hex');
const SERVICE_NAME = `yunpanel-node-${APPLICATION_HASH.slice(0, 16)}.service`;
const APPLICATION_USER = `yunapp-${APPLICATION_HASH.slice(0, 12)}`;
const RUNTIME = Object.freeze({
  nodeMajor: 24,
  documentRoot: '.',
  start: Object.freeze({ mode: 'node', entryFile: 'server.js' }),
  mode: 'production',
});
const JOB = Object.freeze({
  payload: {
    node: {
      applicationId: APPLICATION_ID,
      releaseId: RELEASE_ID,
      runtime: RUNTIME,
    },
  },
});
const PASSENGER_TARGET = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${APPLICATION_ID}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${APPLICATION_ID}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: APPLICATION_USER,
  group: APPLICATION_USER,
  appEnv: 'production',
  environmentInclude: `/etc/nginx/yunpanel/passenger-env/${APPLICATION_ID}.conf`,
});
const sha256 = (character) => character.repeat(64);

function migratedResult(overrides = {}) {
  return {
    satisfied: true,
    state: 'migrated',
    applicationId: APPLICATION_ID,
    releaseId: RELEASE_ID,
    targetHealthy: true,
    resumed: false,
    cleanup: {
      complete: true,
      stopped: true,
      disabled: true,
      serviceName: SERVICE_NAME,
    },
    nginx: {
      sourceChecksum: sha256('a'),
      targetChecksum: sha256('b'),
    },
    passengerTarget: PASSENGER_TARGET,
    ...overrides,
  };
}

test('accepts a fully migrated Passenger result', () => {
  const result = sanitizeNodePassengerMigrationResult(JOB, migratedResult());
  assert.equal(result.satisfied, true);
  assert.equal(result.cleanup.serviceName, SERVICE_NAME);
  assert.deepEqual(result.passengerTarget, PASSENGER_TARGET);
});

test('keeps Passenger-active cleanup-required state distinct from migrated success', () => {
  const result = sanitizeNodePassengerMigrationResult(JOB, migratedResult({
    satisfied: false,
    state: 'passenger_active_cleanup_required',
    resumed: true,
    cleanup: {
      complete: false,
      stopped: true,
      disabled: false,
      reason: 'systemd_disable_failed',
      cause: 'command_failed',
    },
  }));
  assert.equal(result.satisfied, false);
  assert.equal(result.state, 'passenger_active_cleanup_required');
});

test('rejects mismatched legacy systemd service evidence', () => {
  assert.throws(() => sanitizeNodePassengerMigrationResult(JOB, migratedResult({
    cleanup: {
      complete: true,
      stopped: true,
      disabled: true,
      serviceName: 'yunpanel-node-deadbeefdeadbeef.service',
    },
  })), /service identity/);
});

test('rejects identical source and target Nginx checksums', () => {
  assert.throws(() => sanitizeNodePassengerMigrationResult(JOB, migratedResult({
    nginx: {
      sourceChecksum: sha256('a'),
      targetChecksum: sha256('a'),
    },
  })), /Nginx evidence/);
});

test('rejects Passenger target evidence that drifts from queued runtime state', () => {
  assert.throws(() => sanitizeNodePassengerMigrationResult(JOB, migratedResult({
    passengerTarget: { ...PASSENGER_TARGET, startupFile: 'other.js' },
  })), /target evidence does not match/);
});
