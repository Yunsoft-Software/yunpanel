import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePassengerNodeDeploySpec, normalizePassengerNodeRollbackSpec } from '../src/index.js';
const app = '11111111-1111-4111-8111-111111111111', before = '22222222-2222-4222-8222-222222222222', job = '33333333-3333-4333-8333-333333333333';
function common() { return { applicationId: app, websiteId: app, unixUser: 'yunapp-111111111111', websiteRevision: 1,
  configurationRevision: 2, environmentRevision: 0, bindingRevision: 1,
  domains: [{ domainId: app, desiredRevision: 1, nginxChecksum: 'a'.repeat(64) }], runtime: { startMode: 'node', entryFile: 'index.js' } }; }
function deploy() { return { ...common(), deploymentId: job, previousReleaseId: before, repositoryUrl: 'https://github.com/heroku/node-js-getting-started', branch: 'main', gitTarget: { kind: 'branch', value: 'main' }, retention: 5 }; }
function rollback() { return { ...common(), releaseId: before, currentReleaseId: job, commitSha: 'b'.repeat(40), releaseConfigurationRevision: 1 }; }
test('Passenger release snapshots carry exact site, runtime and routing revisions without a port', () => {
  const d = normalizePassengerNodeDeploySpec(deploy()), r = normalizePassengerNodeRollbackSpec(rollback());
  assert.equal(d.runtime.port, null); assert.equal(d.previousReleaseId, before); assert.equal(d.deploymentId, job);
  assert.equal(r.runtime.port, null); assert.equal(r.configurationRevision, 2); assert.equal(r.releaseConfigurationRevision, 1);
});
test('Passenger release snapshots reject systemd ports, arbitrary commands and public secrets', () => {
  for (const mutation of [x => { x.runtime.port = 3100; }, x => { x.runtime.startMode = 'npm'; x.runtime.startScript = 'start'; },
    x => { x.sessionId = 'private'; }, x => { x.password = 'private'; }, x => { x.unixUser = 'root'; }, x => { x.runtime.entryFile = '../other.js'; }]) {
    const input = deploy(); mutation(input); assert.throws(() => normalizePassengerNodeDeploySpec(input));
  }
});
test('Passenger snapshots reject missing or ambiguous authorities and unsupported revisions', () => {
  for (const mutation of [x => { x.previousReleaseId = null; }, x => { x.bindingRevision = 0; }, x => { x.websiteRevision = -1; },
    x => { x.domains.push({ ...x.domains[0] }); }, x => { x.domains[0].nginxChecksum = 'unknown'; }, x => { x.environmentRevision = 1.5; },
    x => { x.domains = []; }, x => { x.retention = 21; }]) {
    const input = deploy(); mutation(input); assert.throws(() => normalizePassengerNodeDeploySpec(input));
  }
  assert.throws(() => normalizePassengerNodeRollbackSpec({ ...rollback(), releaseId: job }));
  assert.throws(() => normalizePassengerNodeRollbackSpec({ ...rollback(), commitSha: 'invalid' }));
});
