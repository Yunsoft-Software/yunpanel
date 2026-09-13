import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDockerComposeMaterializer,
  DockerComposeMaterializerError,
} from '../src/docker-compose-materializer.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const sha = 'a'.repeat(64);
const request = Object.freeze({
  projectId,
  expectedProjectRevision: 3,
  expectedEnvironmentRevision: 2,
  expectedComposeSha256: sha,
  credentialRevisions: [{ registryHost: 'ghcr.io', revision: 4 }],
});

function fixture(overrides = {}) {
  const calls = [];
  const projectRegistry = overrides.projectRegistry ?? {
    async materializeProject(id, options) {
      calls.push(['project', id, options]);
      return { id, projectName: 'shop_app', revision: 3, composeSha256: sha, document: 'services: {}' };
    },
  };
  const environmentRegistry = overrides.environmentRegistry ?? {
    async materializeEnvironment(id, options) {
      calls.push(['environment', id, options]);
      return { projectId: id, revision: 2, variables: { APP_MODE: 'production' } };
    },
  };
  const credentialRegistry = overrides.credentialRegistry ?? {
    async listCredentials({ projectId: id }) {
      calls.push(['credentials.list', id]);
      return [{ projectId: id, registryHost: 'ghcr.io', revision: 4, configured: true }];
    },
    async materializeCredential(id, host, options) {
      calls.push(['credential', id, host, options]);
      return { projectId: id, registryHost: host, revision: 4, username: 'user', secret: 'private-value' };
    },
  };
  const validateDockerCompose = overrides.validateDockerCompose ?? (async (input) => {
    calls.push(['validate', input]);
    return { projectName: 'shop_app', composeSha256: sha, validated: true, sideEffects: false };
  });
  return {
    calls,
    materialize: createDockerComposeMaterializer({
      projectRegistry,
      environmentRegistry,
      credentialRegistry,
      validateDockerCompose,
    }),
  };
}

test('compose materializer returns private runtime only after exact revision and credential pins match', async () => {
  const fx = fixture();
  const runtime = await fx.materialize(request);
  assert.equal(runtime.projectId, projectId);
  assert.equal(runtime.projectRevision, 3);
  assert.equal(runtime.environmentRevision, 2);
  assert.equal(runtime.composeSha256, sha);
  assert.deepEqual(runtime.environment, { APP_MODE: 'production' });
  assert.deepEqual(runtime.credentials, [{ registryHost: 'ghcr.io', username: 'user', secret: 'private-value' }]);
  const validation = fx.calls.find(([name]) => name === 'validate')[1];
  assert.equal(validation.interpolate, true);
  assert.equal(validation.environment.APP_MODE, 'production');
});

test('compose materializer rejects credential revision drift before private credential use', async () => {
  let privateReads = 0;
  const fx = fixture({
    credentialRegistry: {
      async listCredentials() { return [{ projectId, registryHost: 'ghcr.io', revision: 5 }]; },
      async materializeCredential() { privateReads += 1; return null; },
    },
  });
  await assert.rejects(
    fx.materialize(request),
    (error) => error instanceof DockerComposeMaterializerError && error.code === 'docker_compose_credentials_stale',
  );
  assert.equal(privateReads, 0);
});

test('compose materializer rejects project or environment drift and runtime validation failure', async () => {
  const staleProject = fixture({
    projectRegistry: { async materializeProject() { throw new Error('stale'); } },
  });
  await assert.rejects(staleProject.materialize(request), { code: 'docker_compose_desired_state_stale' });

  const invalid = fixture({
    validateDockerCompose: async () => { throw new Error('invalid'); },
  });
  await assert.rejects(invalid.materialize(request), { code: 'docker_compose_runtime_validation_failed' });
});
