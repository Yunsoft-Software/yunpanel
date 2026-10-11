import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDockerComposeRemoval } from '../src/docker-compose-removal.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const payload = { projectId, projectName: 'owned-project', expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2, expectedComposeSha256: 'a'.repeat(64), credentialRevisions: [] };
function fixture({ bound = false, absent = true, stale = false, interrupt = false } = {}) {
  const calls = [];
  let project = { id: projectId, serverId, projectName: payload.projectName,
    revision: stale ? 4 : 3, composeSha256: payload.expectedComposeSha256 };
  let environment = true, credentials = true, failOnce = interrupt;
  const service = createDockerComposeRemoval({
    websiteRegistry: { listWebsites: async () => bound ? [{ managedComposeBinding: { projectId } }] : [] },
    observer: { inspectRemoved: async ({ projectName }) => {
      calls.push('observe'); assert.equal(projectName, payload.projectName); return { absent };
    } },
    projectRegistry: { getProject: async () => project, removeProject: async () => { calls.push('project'); project = null; } },
    environmentRegistry: { removeForProject: async () => {
      calls.push('environment'); environment = false;
      if (failOnce) { failOnce = false; throw new Error('lost environment acknowledgement'); }
    } },
    credentialRegistry: { removeForProject: async () => { calls.push('credentials'); credentials = false; } },
  });
  const job = { operation: OPERATIONS.DOCKER_COMPOSE_REMOVE, serverId, payload,
    authorize: async () => { calls.push('authorize'); } };
  return { service, calls, job, get state() { return { project, environment, credentials }; } };
}
test('bound Websites block project removal before any resource or metadata mutation', async () => {
  const f = fixture({ bound: true });
  await assert.rejects(f.service.authorize(payload, f.job), { code: 'docker_compose_project_in_use' });
  assert.deepEqual(f.calls, ['authorize']); assert.ok(f.state.project);
});
test('metadata retirement requires observed container and network absence', async () => {
  const f = fixture({ absent: false });
  await assert.rejects(f.service.finalize(f.job), { code: 'docker_compose_removal_unverified' });
  assert.deepEqual(f.calls, ['authorize', 'observe']);
  assert.ok(f.state.project); assert.equal(f.state.environment, true); assert.equal(f.state.credentials, true);
});
test('a changed project is preserved even after its old runtime is absent', async () => {
  const f = fixture({ stale: true });
  await assert.rejects(f.service.finalize(f.job), { code: 'docker_compose_preview_stale' });
  assert.deepEqual(f.calls, ['authorize', 'observe']); assert.equal(f.state.project.revision, 4);
});
test('interrupted metadata retirement resumes after observation and removes the project last', async () => {
  const f = fixture({ interrupt: true });
  await assert.rejects(f.service.finalize(f.job)); assert.ok(f.state.project); assert.equal(f.state.credentials, true);
  await f.service.finalize(f.job);
  assert.deepEqual(f.calls, ['authorize', 'observe', 'environment', 'authorize', 'observe', 'environment', 'credentials', 'project']);
  assert.deepEqual(f.state, { project: null, environment: false, credentials: false });
});
test('revoked authorization preserves all project metadata', async () => {
  const f = fixture();
  f.job.authorize = async () => { throw Object.assign(new Error('revoked'), { code: 'panel_job_actor_forbidden' }); };
  await assert.rejects(f.service.finalize(f.job), { code: 'panel_job_actor_forbidden' });
  assert.deepEqual(f.calls, []); assert.ok(f.state.project);
});
