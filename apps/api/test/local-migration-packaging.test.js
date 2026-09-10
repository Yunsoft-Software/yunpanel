import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootPackageUrl = new URL('../../../package.json', import.meta.url);
const buildDebUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);
const envExampleUrl = new URL('../../../.env.example', import.meta.url);

test('root package exposes the local runtime migration CLI', async () => {
  const packageJson = JSON.parse(await readFile(rootPackageUrl, 'utf8'));
  assert.equal(packageJson.scripts['local-runtime'], 'node scripts/local-runtime.mjs');
});

test('Debian package installs the local runtime migration entry point executable', async () => {
  const buildScript = await readFile(buildDebUrl, 'utf8');
  assert.match(buildScript, /install -m 0755 scripts\/local-runtime\.mjs .*\/usr\/lib\/yunpanel\/scripts\/local-runtime\.mjs/);
});

test('environment template keeps local execution disabled until explicit migration', async () => {
  const env = await readFile(envExampleUrl, 'utf8');
  assert.match(env, /^YUNPANEL_LOCAL_SERVER_ID=$/m);
  assert.match(env, /packaged migration CLI before enabling this value/);
  assert.doesNotMatch(env, /^YUNPANEL_LOCAL_SERVER_ID=[0-9a-f-]+$/m);
});
