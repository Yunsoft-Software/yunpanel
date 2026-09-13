import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDockerAction,
  getDockerDiagnosis,
  getDockerLogs,
  getDockerProject,
  listDockerProjects,
  previewDockerAction,
  replaceDockerEnvironment,
  setDockerCredential,
} from '../src/workspace/docker-compose-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

 test('Docker Compose client uses same-origin panel routes and exact operation preview confirmation', async (t) => {
  setSession({ csrfToken: 'csrf-docker' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok(url.includes('/preview')
      ? { previewDigest: 'a'.repeat(64), confirmation: `docker-compose:restart:shop:${'a'.repeat(64)}` }
      : {});
  });

  await listDockerProjects();
  await getDockerProject('project/one');
  await getDockerDiagnosis('project/one', { service: 'web', targetPort: 3000 });
  await getDockerLogs('project/one', { service: 'web', tail: 50 });
  await replaceDockerEnvironment('project/one', { expectedRevision: 2, variables: { NODE_ENV: 'production' } });
  await setDockerCredential('project/one', { registryHost: 'ghcr.io', expectedRevision: 1, username: 'yunsoft', secret: 'token-value' });
  const preview = await previewDockerAction('project/one', 'restart');
  await applyDockerAction('project/one', 'restart', preview);

  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    ['/api/panel/docker/projects', 'GET'],
    ['/api/panel/docker/projects/project%2Fone', 'GET'],
    ['/api/panel/docker/projects/project%2Fone/diagnosis?service=web&targetPort=3000', 'GET'],
    ['/api/panel/docker/projects/project%2Fone/logs?tail=50&service=web', 'GET'],
    ['/api/panel/docker/projects/project%2Fone/environment', 'PUT'],
    ['/api/panel/docker/projects/project%2Fone/credentials', 'PUT'],
    ['/api/panel/docker/projects/project%2Fone/operations/restart/preview', 'POST'],
    ['/api/panel/docker/projects/project%2Fone/operations/restart', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    expectedPreviewDigest: 'a'.repeat(64),
    confirmation: `docker-compose:restart:shop:${'a'.repeat(64)}`,
  });
  for (const call of calls.filter((item) => item.options.method !== 'GET')) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-docker');
  }
  setSession(null);
});

test('Docker Compose client rejects invalid project identities and unsafe operation inputs before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => getDockerProject(''), /dockerProjectId is required/);
  assert.throws(() => getDockerDiagnosis('project-1', { service: '', targetPort: 3000 }), /service is required/);
  assert.throws(() => getDockerDiagnosis('project-1', { service: 'web', targetPort: 0 }), /targetPort is invalid/);
  assert.throws(() => getDockerLogs('project-1', { tail: 10000 }), /tail is invalid/);
  assert.throws(() => previewDockerAction('project-1', 'delete'), /Unsupported Docker Compose action/);
  assert.throws(() => applyDockerAction('project-1', 'restart', {}), /preview is required/);
  assert.equal(calls, 0);
});
