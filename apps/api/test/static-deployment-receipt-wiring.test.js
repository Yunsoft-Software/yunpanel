import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const deploymentId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const payload = Object.freeze({ applicationId, deploymentId });
const result = Object.freeze({
  deploymentId,
  releaseId: deploymentId,
  commitSha: 'a'.repeat(40),
  previousReleaseId: null,
  artifactFiles: 3,
  artifactBytes: 1024,
});

test('successful static deploy records the exact safe result after host completion', async () => {
  const events = [];
  const operations = createLocalHostOperations({
    staticDeploymentManager: {
      async deployStatic(input) {
        events.push(['deploy', input]);
        return result;
      },
    },
    staticDeploymentReceiptStore: {
      async write(receipt) {
        events.push(['receipt', receipt]);
      },
    },
  });

  assert.deepEqual(await operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, payload), result);
  assert.deepEqual(events, [
    ['deploy', payload],
    ['receipt', { applicationId, deploymentId, result }],
  ]);
});

test('receipt failure never recasts a completed static deployment as failed', async () => {
  let deployments = 0;
  const operations = createLocalHostOperations({
    staticDeploymentManager: {
      async deployStatic() {
        deployments += 1;
        return result;
      },
    },
    staticDeploymentReceiptStore: {
      async write() {
        throw new Error('receipt storage unavailable');
      },
    },
  });

  assert.deepEqual(await operations.executeOperation(OPERATIONS.APP_STATIC_DEPLOY, payload), result);
  assert.equal(deployments, 1);
});
