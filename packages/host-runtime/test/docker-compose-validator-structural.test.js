import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDockerComposeValidator } from '../src/docker-compose-validator.js';

test('structural compose validation disables interpolation without exposing environment values', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-structural-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let observedArgs = null;
  const validator = createDockerComposeValidator({
    root,
    accessFn: async () => {},
    execFn: async (file, args) => {
      observedArgs = [...args];
      return JSON.stringify({
        name: 'app',
        services: { web: { image: '${IMAGE:?required}' } },
      });
    },
  });
  const result = await validator({
    projectName: 'app',
    document: 'services:\n  web:\n    image: ${IMAGE:?required}\n',
    interpolate: false,
  });
  assert.ok(observedArgs.includes('--no-interpolate'));
  assert.equal(result.projectName, 'app');
  assert.equal(result.validated, true);
});
