import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  createOperationEnvelope,
  isReadOnlyOperation,
  MANAGED_SERVICE_ACTIONS,
  MANAGED_SERVICE_CONTROL_IDS,
  MANAGED_SERVICE_IDS,
  OPERATIONS,
  validateOperationEnvelope,
} from '../src/index.js';

const id = '12345678-1234-4234-8234-123456789012';

function validate(operation, payload) {
  return validateOperationEnvelope({ id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION });
}

test('managed hosting service protocol exposes the fixed supported catalog', () => {
  assert.deepEqual(MANAGED_SERVICE_IDS, ['nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd', 'roundcube']);
  assert.deepEqual(MANAGED_SERVICE_CONTROL_IDS, ['nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd']);
  assert.deepEqual(MANAGED_SERVICE_ACTIONS, ['start', 'stop', 'restart']);
  assert.equal(isReadOnlyOperation(OPERATIONS.SYSTEM_SERVICES_INSPECT), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SYSTEM_SERVICE_INSTALL), false);
  assert.equal(isReadOnlyOperation(OPERATIONS.SYSTEM_SERVICE_CONTROL), false);
});

test('service inspection accepts either the full catalog or one allowlisted service', () => {
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICES_INSPECT, {}).ok, true);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'docker' }).ok, true);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'ssh' }).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'docker', command: 'id' }).ok, false);
});

test('service install accepts exactly one allowlisted service id', () => {
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'mariadb' }).ok, true);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'roundcube' }).ok, true);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_INSTALL, {}).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'openssh-server' }).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'mariadb', packages: ['curl'] }).ok, false);
});

test('service control accepts only start stop and restart without shell arguments', () => {
  for (const action of MANAGED_SERVICE_ACTIONS) {
    const envelope = createOperationEnvelope({ id, operation: OPERATIONS.SYSTEM_SERVICE_CONTROL, payload: { serviceId: 'nginx', action } });
    assert.equal(envelope.payload.action, action);
  }
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'nginx', action: 'enable' }).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'nginx', action: 'restart', args: ['--now'] }).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'ssh', action: 'restart' }).ok, false);
  assert.equal(validate(OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'roundcube', action: 'restart' }).ok, false);
});
