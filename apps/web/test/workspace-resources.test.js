import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceResources } from '../src/workspace/workspace-resources.js';
const selected = (path, options) => Object.entries(workspaceResources(path, options)).filter(([, enabled]) => enabled).map(([key]) => key).sort();
test('dashboard requests all summary sources, server/settings/database pages only servers', () => {
  assert.equal(selected('/dashboard').length, 5);
  assert.deepEqual(selected('/settings'), ['servers']);
  assert.deepEqual(selected('/servers/'), ['servers']);
  assert.deepEqual(selected('/databases'), ['servers']);
});
test('remaining unimplemented modules and unknown routes do not poll unrelated data', () => {
  for (const path of ['/mail', '/docker', '/backups', '/audit', '/invalid', '/settings/unknown', null]) assert.deepEqual(selected(path), []);
});
test('website list and creation request their dependencies without a job inventory', () => {
  assert.deepEqual(selected('/websites'), ['applications', 'certificates', 'domains', 'servers']);
  assert.deepEqual(selected('/websites/new'), ['applications', 'domains', 'servers']);
});
test('site operation tabs retain required locks and job history', () => {
  for (const tab of ['overview', 'node', 'deploy', 'domains', 'ssl', 'logs']) assert.equal(workspaceResources(`/websites/example/${tab}`).jobs, true);
  assert.equal(workspaceResources('/websites/example').jobs, true);
  assert.equal(workspaceResources('/websites/example/mail').jobs, false);
  assert.equal(workspaceResources('/websites/example/settings').jobs, false);
});
test('application forms and advanced tools retain actual resource dependencies', () => {
  assert.deepEqual(selected('/applications'), ['applications', 'jobs', 'servers']);
  assert.deepEqual(selected('/applications/new'), ['applications', 'servers']);
  assert.deepEqual(selected('/domains'), ['certificates', 'domains', 'servers']);
  assert.deepEqual(selected('/jobs'), ['jobs']);
});
test('observed or active jobs keep monitoring after navigation, without unrelated reads', () => {
  assert.deepEqual(selected('/mail', { observingJob: true }), ['jobs']);
  assert.deepEqual(selected('/mail', { activeJob: true }), ['jobs']);
  assert.deepEqual(selected('/mail', { activeJob: false, observingJob: false }), []);
});
