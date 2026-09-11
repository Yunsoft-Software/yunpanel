import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const askPassPath = fileURLToPath(new URL('../../../packages/host-runtime/src/git-askpass.js', import.meta.url));
const buildScriptPath = fileURLToPath(new URL('../../../scripts/build-deb.sh', import.meta.url));
const controlPath = fileURLToPath(new URL('../../../packaging/debian/control', import.meta.url));

test('package retains executable Git askpass and SSH client dependency', () => {
  assert.notEqual(statSync(askPassPath).mode & 0o111, 0);
  const buildScript = readFileSync(buildScriptPath, 'utf8');
  assert.match(buildScript, /cp -a packages\/\./);
  assert.match(readFileSync(controlPath, 'utf8'), /Depends:.*\bopenssh-client\b/);
});
