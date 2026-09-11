import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index.js';

test('known operations are explicitly allowlisted', () => {
  for (const operation of [
    OPERATIONS.SERVER_INSPECT,
    OPERATIONS.SERVER_DOCKER,
    OPERATIONS.SERVER_NGINX,
    OPERATIONS.SYSTEM_PACKAGES_INSPECT,
  ]) {
    assert.equal(isKnownOperation(operation), true);
    assert.equal(isReadOnlyOperation(operation), true);
  }

  for (const operation of [
    OPERATIONS.DOMAIN_STAGE,
    OPERATIONS.SSL_ISSUE,
    OPERATIONS.SSL_RENEW,
    OPERATIONS.APP_STATIC_DEPLOY,
    OPERATIONS.APP_STATIC_ROLLBACK,
    OPERATIONS.APP_NODE_DEPLOY,
    OPERATIONS.APP_NODE_ROLLBACK,
    OPERATIONS.SYSTEM_UPGRADE,
  ]) {
    assert.equal(isKnownOperation(operation), true);
    assert.equal(isReadOnlyOperation(operation), false);
  }

  assert.equal(isKnownOperation('shell.exec'), false);
  assert.equal(isReadOnlyOperation('shell.exec'), false);
});

test('system package operations accept no caller-controlled arguments', () => {
  const inspect = createOperationEnvelope({
    id: 'request-system-inspect',
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
  });
  assert.equal(inspect.protocolVersion, AGENT_PROTOCOL_VERSION);

  const upgrade = createOperationEnvelope({
    id: 'request-system-upgrade',
    operation: OPERATIONS.SYSTEM_UPGRADE,
    payload: {},
  });
  assert.equal(upgrade.protocolVersion, AGENT_PROTOCOL_VERSION);

  const injected = validateOperationEnvelope({
    id: 'request-system-injected',
    operation: OPERATIONS.SYSTEM_UPGRADE,
    payload: { packageName: 'anything-else' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(injected.ok, false);
  assert.match(injected.errors.join(' '), /does not accept arguments/);
});

test('validates operation envelopes', () => {
  const envelope = createOperationEnvelope({
    id: 'request-0001',
    operation: OPERATIONS.SERVER_INSPECT,
    payload: {},
  });

  assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});

test('rejects arbitrary operations', () => {
  const result = validateOperationEnvelope({
    id: 'request-0002',
    operation: 'shell.exec',
    payload: { command: 'whoami' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /not allowed/);
});

test('validates domain mutation payloads before they reach the agent handler', () => {
  const validStage = validateOperationEnvelope({
    id: 'request-0003',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: ['www.example.com'],
      targetType: 'proxy',
      target: { upstreamPort: 3000, websocket: false },
      nginxSettings: {
        clientMaxBodySizeMb: 64,
        proxyTimeoutSeconds: 120,
        websocket: false,
        headers: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN', always: true }],
      },
      canonicalRedirect: true,
      httpsRedirect: false,
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validStage.ok, true);

  const invalidRedirect = validateOperationEnvelope({
    id: 'request-0003b',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: 'example.com', targetType: 'proxy', target: { upstreamPort: 3000 }, canonicalRedirect: 'yes' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidRedirect.ok, false);
  assert.match(invalidRedirect.errors.join(' '), /canonicalRedirect/);

  const invalidNginxSettings = validateOperationEnvelope({
    id: 'request-0003c',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com', targetType: 'proxy', target: { upstreamPort: 3000, websocket: true },
      nginxSettings: {
        clientMaxBodySizeMb: null, proxyTimeoutSeconds: 30, websocket: false, headers: [],
      },
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidNginxSettings.ok, false);
  assert.match(invalidNginxSettings.errors.join(' '), /nginxSettings/);

  const invalidActivation = validateOperationEnvelope({
    id: 'request-0004',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: '../bad' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidActivation.ok, false);
  assert.match(invalidActivation.errors.join(' '), /SHA-256/);

  const renamedActivation = validateOperationEnvelope({
    id: 'request-0004b', operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: 'a'.repeat(64) },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(renamedActivation.ok, true);
});

test('validates certificate issue and renewal payloads', () => {
  const validIssue = validateOperationEnvelope({
    id: 'request-0005',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['example.com', 'www.example.com'],
      email: 'admin@example.com',
      staging: true,
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validIssue.ok, true);

  const wildcardIssue = validateOperationEnvelope({
    id: 'request-0006',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['*.example.com'],
      email: 'admin@example.com',
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(wildcardIssue.ok, false);

  const dnsWildcardIssue = validateOperationEnvelope({
    id: 'request-0006b',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['example.com', '*.example.com'],
      email: 'admin@example.com',
      staging: true,
      challenge: {
        type: 'dns-01',
        provider: 'cloudflare',
        credentialId: '12345678-1234-4234-8234-123456789012',
        dnsZoneId: '22345678-1234-4234-8234-123456789012',
        propagationSeconds: 30,
      },
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(dnsWildcardIssue.ok, true);

  const badEmail = validateOperationEnvelope({
    id: 'request-0007',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['example.com'],
      email: 'not-an-email',
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(badEmail.ok, false);

  const validRenew = validateOperationEnvelope({
    id: 'request-0008',
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: true },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validRenew.ok, true);
});

test('validates static deploy and rollback payloads', () => {
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const deploymentId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const currentReleaseId = 'f8343982-05bc-48a7-9c50-979d85abf191';

  const deploy = validateOperationEnvelope({
    id: deploymentId,
    operation: OPERATIONS.APP_STATIC_DEPLOY,
    payload: {
      applicationId,
      deploymentId,
      repositoryUrl: 'https://github.com/example/site',
      branch: 'main',
      build: { mode: 'npm', outputDir: 'dist', healthFile: 'index.html' },
      retention: 5,
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(deploy.ok, true);

  const rollback = validateOperationEnvelope({
    id: 'request-rollback-0001',
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    payload: { applicationId, releaseId, currentReleaseId },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(rollback.ok, true);

  const invalidRollback = validateOperationEnvelope({
    id: 'request-rollback-0002',
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    payload: { applicationId, releaseId: '../../etc', currentReleaseId },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidRollback.ok, false);
  assert.match(invalidRollback.errors.join(' '), /releaseId/);

  const invalidCurrentRelease = validateOperationEnvelope({
    id: 'request-rollback-0003',
    operation: OPERATIONS.APP_STATIC_ROLLBACK,
    payload: { applicationId, releaseId, currentReleaseId: '../bad' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidCurrentRelease.ok, false);
  assert.match(invalidCurrentRelease.errors.join(' '), /currentReleaseId/);
});

test('validates Node rollback payloads with desired runtime state', () => {
  const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
  const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
  const currentReleaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const runtime = {
    nodeMajor: 24,
    installMode: 'ci',
    buildScript: 'build',
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 10,
    restartPolicy: 'on-failure',
  };

  const rollback = validateOperationEnvelope({
    id: 'request-node-rollback-0001',
    operation: OPERATIONS.APP_NODE_ROLLBACK,
    payload: { applicationId, releaseId, currentReleaseId, runtime },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(rollback.ok, true);

  const invalidRollback = validateOperationEnvelope({
    id: 'request-node-rollback-0002',
    operation: OPERATIONS.APP_NODE_ROLLBACK,
    payload: { applicationId, releaseId, currentReleaseId, runtime: { ...runtime, port: 80 } },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidRollback.ok, false);
  assert.match(invalidRollback.errors.join(' '), /port/);

  const invalidCurrentRelease = validateOperationEnvelope({
    id: 'request-node-rollback-0003',
    operation: OPERATIONS.APP_NODE_ROLLBACK,
    payload: { applicationId, releaseId, currentReleaseId: '../bad', runtime },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidCurrentRelease.ok, false);
  assert.match(invalidCurrentRelease.errors.join(' '), /currentReleaseId/);
});
