import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = new URL('../src/app.js', import.meta.url);

test('production API mounts local Roundcube configuration control plane and preserves typed errors', async () => {
  const appSource = await readFile(source, 'utf8');

  assert.match(appSource, /RoundcubeConfigurationHttpError, mountRoundcubeConfigurationRoutes/);
  assert.match(appSource, /roundcubeConfigurationService = null/);
  assert.match(appSource, /if \(roundcubeConfigurationService\) \{[\s\S]*?mountRoundcubeConfigurationRoutes\(app, \{[\s\S]*?roundcubeConfigurationService,[\s\S]*?jobRegistry,[\s\S]*?localServerId,[\s\S]*?\}\);[\s\S]*?\}/);
  assert.match(appSource, /error instanceof RoundcubeConfigurationError/);
  assert.match(appSource, /error instanceof RoundcubeConfigurationHttpError/);
  assert.match(appSource, /error instanceof RoundcubeSecretRegistryError/);
});
