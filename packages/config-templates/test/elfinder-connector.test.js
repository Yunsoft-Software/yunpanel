import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elFinderConnectorTemplatePolicy,
  previewElFinderConnector,
  renderElFinderConnector,
} from '../src/elfinder-connector.js';

test('elFinder connector derives Website identity only from FPM environment', () => {
  const content = renderElFinderConnector();

  assert.match(content, /getenv\('YUNPANEL_ELFINDER_ROOT'\)/);
  assert.match(content, /getenv\('YUNPANEL_ELFINDER_WEBSITE_ID'\)/);
  assert.match(content, /getenv\('YUNPANEL_ELFINDER_APPLICATION_ID'\)/);
  assert.match(content, /getenv\('YUNPANEL_ELFINDER_UNIX_USER'\)/);
  assert.match(content, /\$expectedRoot = '\/var\/lib\/yunpanel\/data\/' \. strtolower\(\$applicationId\)/);
  assert.match(content, /realpath\(\$root\) !== \$root/);
  assert.match(content, /is_link\(\$root\)/);
  assert.match(content, /posix_geteuid\(\)/);
  assert.match(content, /\(\$processUser\['name'\] \?\? null\) !== \$unixUser/);

  for (const field of ['root', 'path', 'unixUser', 'websiteId', 'applicationId']) {
    assert.ok(content.includes("'" + field + "'"));
  }
  assert.doesNotMatch(content, /\$_GET\[['"]root['"]\]/);
  assert.doesNotMatch(content, /\$_POST\[['"]root['"]\]/);
});

test('elFinder connector stays on LocalFileSystem and disables network and chmod surfaces', () => {
  const content = renderElFinderConnector();

  assert.match(content, /elFinder::\$netDrivers = \[\]/);
  assert.match(content, /'driver' => 'LocalFileSystem'/);
  assert.match(content, /'path' => \$root \. DIRECTORY_SEPARATOR/);
  assert.match(content, /'URL' => ''/);
  assert.match(content, /'followSymLinks' => false/);
  assert.match(content, /'disabled' => \['netmount', 'chmod'\]/);
  assert.match(content, /'uploadMaxSize' => '128M'/);
  assert.match(content, /'maxArcFilesSize' => '1G'/);
  assert.match(content, /'acceptedName' =>/);
  assert.doesNotMatch(content, /FTP|SFTP|Dropbox|GoogleDrive|OneDrive|Box\.net/);
});

test('elFinder connector fails closed when packaged vendor code or runtime identity is unavailable', () => {
  const content = renderElFinderConnector();

  assert.match(content, /is_file\(YUNPANEL_ELFINDER_AUTOLOAD\)/);
  assert.match(content, /is_readable\(YUNPANEL_ELFINDER_AUTOLOAD\)/);
  assert.match(content, /class_exists\('elFinder', false\)/);
  assert.match(content, /class_exists\('elFinderConnector', false\)/);
  assert.match(content, /class_exists\('elFinderVolumeLocalFileSystem', false\)/);
  assert.match(content, /yunpanel_elfinder_fail\(503\)/);
  assert.match(content, /yunpanel_elfinder_fail\(403\)/);
  assert.match(content, /Cache-Control: no-store/);
  assert.match(content, /Referrer-Policy: no-referrer/);
  assert.doesNotMatch(content, /display_errors|var_dump|print_r/);
});

test('elFinder connector preview pins fixed package paths and deterministic public artifact metadata', () => {
  const first = previewElFinderConnector();
  const second = previewElFinderConnector();

  assert.deepEqual(first, second);
  assert.equal(first.vendorRoot, '/usr/share/yunpanel/elfinder/vendor/elfinder');
  assert.equal(first.autoloadPath, '/usr/share/yunpanel/elfinder/vendor/elfinder/php/autoload.php');
  assert.equal(first.artifact.path, '/usr/share/yunpanel/elfinder/connector.php');
  assert.equal(first.artifact.mode, 0o644);
  assert.equal(first.artifact.sensitive, false);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.artifact.sha256, first.sha256);
  assert.equal(first.artifact.bytes, Buffer.byteLength(renderElFinderConnector()));

  assert.equal(elFinderConnectorTemplatePolicy.connectorPath, first.artifact.path);
  assert.equal(elFinderConnectorTemplatePolicy.vendorRoot, first.vendorRoot);
  assert.equal(elFinderConnectorTemplatePolicy.autoloadPath, first.autoloadPath);
});
