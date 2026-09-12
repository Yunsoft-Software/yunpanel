import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalRoundcubeConfigOperation,
  LocalRoundcubeConfigOperationError,
} from '../src/local-roundcube-config-operation.js';

const payload = Object.freeze({
  previewSha256: 'a'.repeat(64),
  configSha256: 'b'.repeat(64),
  fpmSha256: 'c'.repeat(64),
});
const nginxSha256 = 'e'.repeat(64);
const execution = Object.freeze({
  jobId: '12345678-1234-4234-8234-123456789012',
  resourceType: 'server',
  resourceId: '10714f5d-8646-4f9a-a8e9-b80439ff6305',
});

function fixture({ stale = false } = {}) {
  const calls = [];
  const bundle = {
    preview: {
      sha256: stale ? 'd'.repeat(64) : payload.previewSha256,
      configSha256: payload.configSha256,
      fpmSha256: payload.fpmSha256,
      nginxSha256,
      configuration: { artifact: { path: '/etc/roundcube/config.inc.php' } },
      fpm: { artifact: { path: '/etc/php/8.3/fpm/pool.d/yunpanel-roundcube.conf' } },
      nginx: { artifact: { path: '/etc/nginx/sites-enabled/yunpanel-roundcube.conf' } },
    },
    sensitiveArtifacts: [{ path: '/etc/roundcube/config.inc.php', content: '<?php secret();\n' }],
    publicArtifacts: [
      { path: '/etc/php/8.3/fpm/pool.d/yunpanel-roundcube.conf', content: '[pool]\n' },
      { path: '/etc/nginx/sites-enabled/yunpanel-roundcube.conf', content: 'server {}\n' },
    ],
  };
  const operation = createLocalRoundcubeConfigOperation({
    configManager: {
      async stageConfiguration(preview, content) { calls.push(['config', preview, content]); },
      async stageFpmPool(preview, content) { calls.push(['fpm', preview, content]); },
      async stageNginxConfig(preview, content) { calls.push(['nginx', preview, content]); },
    },
    backupManager: { async backupConfiguration() {} },
    activator: {
      async activateConfiguration(preview, options) {
        calls.push(['activate', preview, options]);
        return {
          version: 1,
          previewSha256: payload.previewSha256,
          configSha256: payload.configSha256,
          fpmSha256: payload.fpmSha256,
          nginxSha256,
          databaseCreated: true,
          httpHealthy: true,
          applied: true,
          sideEffects: true,
        };
      },
    },
    loadConfiguration: async (input, context) => {
      calls.push(['load', input, context]);
      return bundle;
    },
  });
  return { operation, calls };
}

test('Roundcube host operation stages private config plus public FPM/Nginx material outside job payload', async () => {
  const fx = fixture();
  const result = await fx.operation.execute(payload, execution);
  assert.deepEqual(result, {
    version: 1,
    ...payload,
    nginxSha256,
    databaseCreated: true,
    httpHealthy: true,
    applied: true,
    sideEffects: true,
  });
  assert.deepEqual(fx.calls.map(([name]) => name), ['load', 'config', 'fpm', 'nginx', 'activate']);
  assert.doesNotMatch(JSON.stringify(payload), /secret|des_key|config\.inc|nginx/i);
  assert.deepEqual(fx.calls.at(-1)[2], { transactionId: execution.jobId });
});

test('Roundcube host operation rejects stale desired state before staging', async () => {
  const fx = fixture({ stale: true });
  await assert.rejects(
    fx.operation.execute(payload, execution),
    (error) => error instanceof LocalRoundcubeConfigOperationError
      && error.code === 'roundcube_configuration_bundle_invalid',
  );
  assert.deepEqual(fx.calls.map(([name]) => name), ['load']);
});

test('Roundcube host operation requires server-scoped durable execution context', async () => {
  const fx = fixture();
  await assert.rejects(
    fx.operation.execute(payload, { ...execution, resourceType: 'mail_domain' }),
    (error) => error instanceof LocalRoundcubeConfigOperationError
      && error.code === 'roundcube_execution_context_invalid',
  );
  assert.equal(fx.calls.length, 0);
});