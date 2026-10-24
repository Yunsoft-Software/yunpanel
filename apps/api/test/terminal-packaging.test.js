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
  assert.equal(typeof apiPackage.dependencies['node-pty'], 'string');
  assert.equal(rootPackage.allowScripts, undefined);
  assert.match(control, /^Architecture: @ARCHITECTURE@$/m);
  assert.match(control, /^Depends:.*\blibc6\b.*\blibstdc\+\+6\b/m);
  assert.match(build, /node_platform.*process\.platform/);
  assert.match(build, /x64\) architecture=amd64/);
  assert.match(build, /arm64\) architecture=arm64/);
  assert.doesNotMatch(build, /node-pty/);
  assert.match(build, /docs\/operations\.md/);
  assert.match(build, /docs\/security\.md/);
  assert.match(build, /if \[\[ "\$output_directory" = \/\* \]\]/);
  assert.match(build, /package_path="\$package_directory\/yunpanel_/);
  assert.match(build, /yunpanel_\$\{version\}_\$\{architecture\}\.deb/);
  assert.doesNotMatch(build, /yunpanel_\$\{version\}_all\.deb/);
});

test('Debian documentation inputs exist after the documentation consolidation', async () => {
  const build = await readFile(new URL('../../../scripts/build-deb.sh', import.meta.url), 'utf8');
  const manifest = build.match(/documentation_files=\(\n([\s\S]*?)\n\)/);
  assert.ok(manifest, 'The package must declare its documentation inputs');
  const files = manifest[1].split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(file === '.env.example' || file === 'README.md' || /^docs\/[a-z-]+\.md$/.test(file), file);
    const contents = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.ok(contents.trim().length > 0, `${file} must not be empty`);
  }
});
