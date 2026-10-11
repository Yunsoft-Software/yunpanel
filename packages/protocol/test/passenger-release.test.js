import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS, AGENT_PROTOCOL_VERSION, isKnownOperation, isReadOnlyOperation, validateOperationEnvelope } from '../src/index.js';
const id = '11111111-1111-4111-8111-111111111111', prior = '22222222-2222-4222-8222-222222222222';
function payload() { return { applicationId: id, websiteId: id, unixUser: 'yunapp-111111111111', websiteRevision: 1, configurationRevision: 1,
  environmentRevision: 0, bindingRevision: 1, domains: [{ domainId: id, desiredRevision: 1, nginxChecksum: 'a'.repeat(64) }],
  runtime: { startMode: 'node', entryFile: 'index.js' }, deploymentId: id, previousReleaseId: prior,
  repositoryUrl: 'https://github.com/heroku/node-js-getting-started', branch: 'main', gitTarget: { kind: 'branch', value: 'main' }, retention: 5 }; }
test('Passenger release operations are explicit mutations and preserve legacy systemd contracts', () => {
  for (const operation of [OPERATIONS.APP_NODE_PASSENGER_DEPLOY, OPERATIONS.APP_NODE_PASSENGER_ROLLBACK]) {
    assert.equal(isKnownOperation(operation), true); assert.equal(isReadOnlyOperation(operation), false);
  }
  const envelope = { id, protocolVersion: AGENT_PROTOCOL_VERSION, operation: OPERATIONS.APP_NODE_PASSENGER_DEPLOY, payload: payload() };
  assert.equal(validateOperationEnvelope(envelope).ok, true);
  assert.equal(validateOperationEnvelope({ ...envelope, operation: OPERATIONS.APP_NODE_DEPLOY }).ok, false);
  assert.equal(validateOperationEnvelope({ ...envelope, payload: { ...payload(), runtime: { ...payload().runtime, port: 3100 } } }).ok, false);
});
