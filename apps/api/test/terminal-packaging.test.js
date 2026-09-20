import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Debian package output is architecture-specific and node-pty native module is retired', async () => {
  const [rootPackage, apiPackage, control, build] = await Promise.all([
    readFile(new URL('../../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../../packaging/debian/control', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/build-deb.sh', import.meta.url), 'utf8'),
  ]);
  assert.equal(apiPackage.dependencies['node-pty'], undefined);
  assert.equal(rootPackage.allowScripts, undefined);
  assert.match(control, /^Architecture: @ARCHITECTURE@$/m);
  assert.match(control, /^Depends:.*\blibc6\b.*\blibstdc\+\+6\b/m);
  assert.match(build, /node_platform.*process\.platform/);
  assert.match(build, /x64\) architecture=amd64/);
  assert.match(build, /arm64\) architecture=arm64/);
  assert.doesNotMatch(build, /node-pty/);
  assert.match(build, /docs\/terminal\.md/);
  assert.match(build, /if \[\[ "\$output_directory" = \/\* \]\]/);
  assert.match(build, /package_path="\$package_directory\/yunpanel_/);
  assert.match(build, /yunpanel_\$\{version\}_\$\{architecture\}\.deb/);
  assert.doesNotMatch(build, /yunpanel_\$\{version\}_all\.deb/);
});
