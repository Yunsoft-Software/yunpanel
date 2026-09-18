import assert from 'node:assert/strict';
import test from 'node:test';
import {
  elFinderClientTemplatePolicy,
  previewElFinderClient,
  renderElFinderClientIndex,
  renderElFinderClientScript,
} from '../src/elfinder-client.js';

test('elFinder browser shell exposes only the minimal same-origin bootstrap before handoff', () => {
  const html = renderElFinderClientIndex();
  assert.ok(html.includes('/tools/elfinder/yunpanel-client.js'));
  for (const path of [
    '/tools/elfinder/assets/jquery/jquery.min.js',
    '/tools/elfinder/assets/jquery-ui/jquery-ui.min.js',
    '/tools/elfinder/assets/jquery-ui/jquery-ui.min.css',
    '/tools/elfinder/vendor/js/elfinder.min.js',
    '/tools/elfinder/vendor/css/elfinder.min.css',
  ]) assert.equal(html.includes(path), false, path);
  assert.doesNotMatch(html, /https?:\/\/|\/\/code\.jquery|cdnjs|jsdelivr/i);
  assert.match(html, /noindex,nofollow,noarchive/);
});

test('elFinder client points only at protected connector and disables external preview integrations', () => {
  const script = renderElFinderClientScript();
  assert.match(script, /url: '\/tools\/elfinder\/connector\.php'/);
  assert.match(script, /requestType: 'post'/);
  assert.match(script, /\^#handoff=\(\[A-Za-z0-9_-\]\{43\}\)\$/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /fetch\('\/tools\/elfinder\/__yunpanel\/handoff'/);
  assert.match(script, /credentials: 'same-origin'/);
  assert.match(script, /body: JSON\.stringify\(\{ capability \}\)/);
  assert.match(script, /response\.status !== 204/);
  assert.match(script, /loadApplicationAssets/);
  for (const path of [
    '/tools/elfinder/assets/jquery/jquery.min.js',
    '/tools/elfinder/assets/jquery-ui/jquery-ui.min.js',
    '/tools/elfinder/assets/jquery-ui/jquery-ui.min.css',
    '/tools/elfinder/vendor/js/elfinder.min.js',
    '/tools/elfinder/vendor/css/elfinder.min.css',
  ]) assert.ok(script.includes(path), path);
  assert.match(script, /await loadApplicationAssets\(\);\s*start\(\);/);
  assert.doesNotMatch(script, /[?&]handoff=/);
  assert.match(script, /sharecadMimes: \[\]/);
  assert.match(script, /googleDocsMimes: \[\]/);
  assert.match(script, /officeOnlineMimes: \[\]/);
  assert.doesNotMatch(script, /netmount|chmod/);
  assert.doesNotMatch(script, /window\.(?:alert|confirm|prompt)/);
  assert.doesNotMatch(script, /https?:\/\/|cdnjs|jsdelivr|google\.com/i);
});

test('elFinder browser client preview is deterministic and pins fixed package paths', () => {
  const a = previewElFinderClient();
  const b = previewElFinderClient();
  assert.deepEqual(a, b);
  assert.equal(a.gatewayBasePath, '/tools/elfinder/');
  assert.equal(a.connectorPath, '/tools/elfinder/connector.php');
  assert.equal(a.handoffPath, '/tools/elfinder/__yunpanel/handoff');
  assert.deepEqual(a.artifacts.map((item) => [item.path, item.mode, item.sensitive]), [
    ['/usr/share/yunpanel/elfinder/index.html', 0o644, false],
    ['/usr/share/yunpanel/elfinder/yunpanel-client.js', 0o644, false],
  ]);
  for (const artifact of a.artifacts) assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(elFinderClientTemplatePolicy.indexPath, a.artifacts[0].path);
});
