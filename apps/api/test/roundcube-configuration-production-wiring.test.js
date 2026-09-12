import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);

async function text(name) {
  return readFile(source(name), 'utf8');
}

test('production API mounts local Roundcube configuration control plane and preserves typed errors', async () => {
  const appSource = await text('app.js');

  assert.match(appSource, /RoundcubeConfigurationHttpError, mountRoundcubeConfigurationRoutes/);
  assert.match(appSource, /roundcubeConfigurationService = null/);
  assert.match(appSource, /if \(roundcubeConfigurationService\) \{[\s\S]*?mountRoundcubeConfigurationRoutes\(app, \{[\s\S]*?roundcubeConfigurationService,[\s\S]*?jobRegistry,[\s\S]*?localServerId,[\s\S]*?\}\);[\s\S]*?\}/);
  assert.match(appSource, /error instanceof RoundcubeConfigurationError/);
  assert.match(appSource, /error instanceof RoundcubeConfigurationHttpError/);
  assert.match(appSource, /error instanceof RoundcubeSecretRegistryError/);
});

test('production boot shares one persistent Roundcube secret registry and configuration service', async () => {
  const indexSource = await text('index.js');

  assert.match(indexSource, /YUNPANEL_ROUNDCUBE_SECRET_STORE/);
  assert.match(indexSource, /createRoundcubeSecretRegistry\(\{[\s\S]*?filePath: roundcubeSecretStorePath,[\s\S]*?serverExists:[\s\S]*?\}\)/);
  assert.match(indexSource, /await roundcubeSecretRegistry\.init\(\)/);
  assert.match(indexSource, /createRoundcubeConfigurationService\(\{[\s\S]*?mailServiceIdentityRegistry,[\s\S]*?roundcubeSecretRegistry,[\s\S]*?\}\)/);
  assert.match(indexSource, /createApp\(\{[\s\S]*?roundcubeConfigurationService,[\s\S]*?\}\)/);
  assert.match(indexSource, /startConfiguredLocalRuntime\(\{[\s\S]*?roundcubeConfigurationService,[\s\S]*?\}\)/);
});

test('configured local runtime materializes Roundcube privately and records only recovery-safe evidence', async () => {
  const configuredSource = await text('configured-local-runtime.js');

  assert.match(configuredSource, /roundcubeConfigurationService\.materializeForServer\(execution\?\.resourceId/);
  assert.match(configuredSource, /loadRoundcubeConfiguration,/);
  assert.match(configuredSource, /operation === OPERATIONS\.ROUNDCUBE_CONFIG_APPLY/);
  assert.match(configuredSource, /roundcubeConfigOperationReceipts\.write\(\{/);
  assert.match(configuredSource, /databaseCreated: result\.databaseCreated/);
  assert.doesNotMatch(configuredSource, /desKey|configContent|fpmContent/);
});
