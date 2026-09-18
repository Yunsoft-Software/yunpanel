import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fetchUrl = new URL('../../../scripts/fetch-elfinder-vendor.sh', import.meta.url);
const buildUrl = new URL('../../../scripts/build-deb.sh', import.meta.url);

test('elFinder vendor fetch pins the reviewed stable tag to an exact commit', async () => {
  const source = await readFile(fetchUrl, 'utf8');
  assert.match(source, /^version=2\.1\.70$/m);
  assert.match(source, /^commit=e7ea668fd569fc9903fb1c431d47d58f2daad2f2$/m);
  assert.match(source, /^repository=https:\/\/github\.com\/Studio-42\/elFinder\.git$/m);
  assert.match(source, /checkout --detach "\$commit"/);
  assert.match(source, /rev-parse HEAD/);
  assert.match(source, /rev-list -n 1 "\$version"/);
  assert.match(source, /status --porcelain --untracked-files=all/);
  assert.doesNotMatch(source, /\blatest\b|refs\/heads\/master|checkout master/);
});

test('Debian builder refuses drifted elFinder input and packages only the pinned clean vendor tree', async () => {
  const source = await readFile(buildUrl, 'utf8');
  assert.match(source, /^elfinder_version=2\.1\.70$/m);
  assert.match(source, /^elfinder_commit=e7ea668fd569fc9903fb1c431d47d58f2daad2f2$/m);
  assert.match(source, /ELFINDER_VENDOR_ROOT/);
  assert.match(source, /rev-parse HEAD/);
  assert.match(source, /rev-list -n 1 "\$elfinder_version"/);
  assert.match(source, /status --porcelain --untracked-files=all/);
  assert.match(source, /usr\/share\/yunpanel\/elfinder\/vendor\/elfinder/);
  assert.match(source, /cp -a "\$elfinder_vendor_root\/\."/);
  assert.match(source, /rm -rf -- "\$package_root\/usr\/share\/yunpanel\/elfinder\/vendor\/elfinder\/\.git"/);
  assert.match(source, /renderElFinderConnector/);
  assert.match(source, /usr\/share\/yunpanel\/elfinder\/connector\.php/);
  assert.match(source, /usr\/share\/yunpanel\/elfinder\/VERSION/);
  assert.doesNotMatch(source, /curl .*elfinder|wget .*elfinder/i);
});

test('elFinder package layout requires the runtime files used by the hardened connector and browser client', async () => {
  const source = await readFile(buildUrl, 'utf8');
  for (const path of [
    'LICENSE.md',
    'elfinder.html',
    'css/elfinder.min.css',
    'js/elfinder.min.js',
    'php/autoload.php',
    'php/elFinder.class.php',
    'php/elFinderConnector.class.php',
    'php/elFinderVolumeLocalFileSystem.class.php',
  ]) assert.ok(source.includes(path), path);
});
