import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteNodeReleaseProvisioningHandler,
  WebsiteNodeReleaseProvisioningError,
} from '../src/website-node-release-provisioning-handler.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const deploymentId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

function intent() {
  return {
    adapter: 'passenger-release',
    websiteId: 'f73cc6ac-07e8-4d22-b29a-741154687d20',
    applicationId,
    deploymentId,
    repositoryUrl: 'https://github.com/example/node-app.git',
    branch: 'main',
    runtime: {
      nodeMajor: 24,
      packageManager: 'npm',
      installMode: 'ci',
      buildScript: 'build',
      mode: 'production',
      documentRoot: '.',
      start: { mode: 'node', entryFile: 'dist/server.js', script: null },
      healthPath: '/health',
      healthTimeoutSeconds: 30,
      restartPolicy: 'on-failure',
    },
    retention: 5,
  };
}

test('release handler inspects before mutation and returns operation-owned evidence', async () => {
  const calls = [];
  const nodeReleaseManager = {
    inspectDeployment: async (spec) => {
      calls.push(['inspect', spec]);
      return { satisfied: false, reason: 'website_node_release_receipt_missing' };
    },
    prepare: async (spec, options) => {
      calls.push(['prepare', spec, options]);
      return {
        satisfied: true,
        applicationId,
        deploymentId,
        releaseId: deploymentId,
        previousReleaseId: null,
        commitSha: 'a'.repeat(40),
      };
    },
    compensate: async () => ({ satisfied: true }),
    inspectCompensation: async () => ({ satisfied: true }),
  };
  const handler = createWebsiteNodeReleaseProvisioningHandler({ nodeReleaseManager });
  const result = await handler.apply({ intent: intent() });

  assert.equal(result.satisfied, true);
  assert.equal(result.releaseId, deploymentId);
  assert.deepEqual(calls.map(([kind]) => kind), ['inspect', 'prepare']);
  assert.equal(calls[1][1].runtime.port, undefined);
  assert.deepEqual(calls[1][2], { gitCredential: null });
});

test('release handler materializes private Git credential only when mutation is required', async () => {
  const credential = { type: 'github_token', token: 'secret-token-value' };
  let materialized = 0;
  let receivedOptions = null;
  const handler = createWebsiteNodeReleaseProvisioningHandler({
    gitCredentialProvider: async (receivedApplicationId) => {
      materialized += 1;
      assert.equal(receivedApplicationId, applicationId);
      return credential;
    },
    nodeReleaseManager: {
      inspectDeployment: async () => ({ satisfied: false, reason: 'missing' }),
      prepare: async (_spec, options) => {
        receivedOptions = options;
        return { satisfied: true, releaseId: deploymentId };
      },
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
  });
  const result = await handler.apply({ intent: intent() });
  assert.equal(result.satisfied, true);
  assert.equal(materialized, 1);
  assert.deepEqual(receivedOptions, { gitCredential: credential });
  assert.equal(JSON.stringify(result).includes('secret-token-value'), false);
});

test('release handler never decrypts Git credential for an already satisfied retry', async () => {
  let materialized = false;
  const evidence = {
    satisfied: true,
    applicationId,
    deploymentId,
    releaseId: deploymentId,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
  };
  const handler = createWebsiteNodeReleaseProvisioningHandler({
    gitCredentialProvider: async () => { materialized = true; return null; },
    nodeReleaseManager: {
      inspectDeployment: async () => evidence,
      prepare: async () => { throw new Error('prepare should not run'); },
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
  });

  assert.equal(await handler.apply({ intent: intent() }), evidence);
  assert.equal(materialized, false);
});

test('release handler compensation is bound to persisted previous-release evidence', async () => {
  let received = null;
  const handler = createWebsiteNodeReleaseProvisioningHandler({
    nodeReleaseManager: {
      inspectDeployment: async () => ({ satisfied: true }),
      prepare: async () => ({ satisfied: true }),
      compensate: async (target) => { received = target; return { satisfied: true, ...target }; },
      inspectCompensation: async (target) => ({ satisfied: true, ...target }),
    },
  });

  const missing = await handler.compensate({ intent: intent(), evidence: null });
  assert.equal(missing.satisfied, false);
  assert.equal(missing.reason, 'website_node_release_compensation_evidence_missing');

  const result = await handler.compensate({
    intent: intent(),
    evidence: { previousReleaseId: null },
  });
  assert.equal(result.satisfied, true);
  assert.deepEqual(received, { applicationId, deploymentId, previousReleaseId: null });
});

test('release handler rejects non-Passenger release intents', async () => {
  const handler = createWebsiteNodeReleaseProvisioningHandler({
    nodeReleaseManager: {
      inspectDeployment: async () => ({ satisfied: true }),
      prepare: async () => ({ satisfied: true }),
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
  });

  await assert.rejects(
    handler.apply({ intent: { ...intent(), adapter: 'direct-systemd' } }),
    (error) => error instanceof WebsiteNodeReleaseProvisioningError
      && error.code === 'website_node_release_intent_invalid',
  );
});
