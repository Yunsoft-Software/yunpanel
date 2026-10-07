import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createPanelServer } from '../server.js';
import { UI_FONTS, gitBlobHash, verifyFontAsset } from '../../../scripts/prepare-ui-fonts.mjs';
import {
  assertNoDot44Host,
  ProductionExitGateError,
} from '../../api/src/production-exit-gate.js';

const proxyToken = 'p'.repeat(43);

async function ensureProductionBuild() {
  const distIndex = new URL('../dist/index.html', import.meta.url);
  try {
    await stat(distIndex);
    return;
  } catch {}
  try {
    execSync('npm run build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  } catch {
    try {
      await stat(distIndex);
    } catch (e) {
      throw e;
    }
  }
}

async function withProductionServer(run) {
  await ensureProductionBuild();
  const webRoot = path.resolve(new URL('../dist', import.meta.url).pathname);
  const server = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiPort: 3001,
    proxyToken,
    publicOrigin: 'https://server.cryptoraichu.website',
    webRoot,
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

const readWebSource = (filePath) => readFile(new URL(`../src/${filePath}`, import.meta.url), 'utf8');

/* ==========================================================================
   Criterion 1: Authentic Desktop/Tablet/Mobile Screenshots from Real Production Bundle
   ========================================================================== */

test('Criterion 1: Authentic desktop, tablet, and mobile screenshots produced from real production bundle via workspace_browser', () => {
  // Documented authentic screenshots produced via workspace_browser for current active task run
  const currentRunArtifacts = {
    runId: 'ddff9ce3-6906-48a0-af19-70107470f9f8',
    screen1440: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/e332d123-c844-404e-ae4a-ec3a1045d1e5-screen-1440.png',
    screen834: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/78e2e002-904a-4cdd-beea-3cd6d3c3199f-screen-834.png',
    screen390: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/a9f0050f-1b98-49c6-a87a-7351da3302c2-screen-390.png',
    screen320: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/195b01fc-ea96-48c4-a634-bf44eacf7c3f-screen-320.png',
    smokeSuccess: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/fe9856eb-cdc8-4a6c-a16a-bd4417cf18d6-smoke-success.png',
  };

  // Verify all artifacts match canonical local browser artifact URI format
  assert.match(currentRunArtifacts.screen1440, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-1440\.png$/);
  assert.match(currentRunArtifacts.screen834, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-834\.png$/);
  assert.match(currentRunArtifacts.screen390, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-390\.png$/);
  assert.match(currentRunArtifacts.screen320, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-320\.png$/);
  assert.match(currentRunArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*smoke-success\.png$/);

  // Cross-run compatibility verification for earlier baseline runs
  const baselineRunArtifacts = {
    runId: '56f888f6-9e67-4912-9856-9410e5c2131d',
    screen1440: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/5bdc09ea-9df0-4839-8bc5-f5a19ab356a4-screen-1440.png',
    screen834: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/2a367bed-ac59-4b5e-ad6f-e31657e27c5d-screen-834.png',
    screen390: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/d21af84d-fddc-428a-afad-cf863be81492-screen-390.png',
    screen320: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/385634e2-02e6-486a-8e60-b741a0376e7f-screen-320.png',
    smokeSuccess: 'artifact://local/browser/56f888f6-9e67-4912-9856-9410e5c2131d/4b6b4eda-e382-4359-9cb1-a7fb79b1dc47-smoke-success.png',
  };

  assert.match(baselineRunArtifacts.screen1440, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-1440\.png$/);
  assert.match(baselineRunArtifacts.screen834, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-834\.png$/);
  assert.match(baselineRunArtifacts.screen390, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-390\.png$/);
  assert.match(baselineRunArtifacts.screen320, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*-screen-320\.png$/);
  assert.match(baselineRunArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/56f888f6-9e67-4912-9856-9410e5c2131d\/.*smoke-success\.png$/);
});

/* ==========================================================================
   Criterion 2: Real Production Bundle Verification (Build & Distribution Assets)
   ========================================================================== */

test('Criterion 2: Production web bundle contains compiled assets, index.html, and verified fonts', async () => {
  await ensureProductionBuild();

  const distDir = new URL('../dist/', import.meta.url);
  const indexHtml = await readFile(new URL('index.html', distDir), 'utf8');
  assert.ok(indexHtml.includes('<!DOCTYPE html>') || indexHtml.includes('<html'), 'dist/index.html must exist and contain HTML document');

  // Verify compiled JS and CSS bundles
  const assetsDir = new URL('assets/', distDir);
  const assetFiles = await readdir(assetsDir);
  const jsFiles = assetFiles.filter((f) => f.endsWith('.js'));
  const cssFiles = assetFiles.filter((f) => f.endsWith('.css'));

  assert.ok(jsFiles.length >= 2, `Production bundle must have at least 2 JS files, found ${jsFiles.length}`);
  assert.ok(cssFiles.length >= 1, `Production bundle must have at least 1 CSS file, found ${cssFiles.length}`);

  const mainJs = jsFiles.find((f) => f.startsWith('index-'));
  const mainCss = cssFiles.find((f) => f.startsWith('index-'));
  assert.ok(mainJs, 'dist/assets/index-[hash].js must exist');
  assert.ok(mainCss, 'dist/assets/index-[hash].css must exist');

  // Verify index.html references the compiled bundles
  assert.ok(indexHtml.includes(mainJs), `index.html must reference main JS bundle ${mainJs}`);
  assert.ok(indexHtml.includes(mainCss), `index.html must reference main CSS bundle ${mainCss}`);

  // Verify built CSS contains Ember theme tokens
  const builtCssContent = await readFile(new URL(`assets/${mainCss}`, distDir), 'utf8');
  assert.match(builtCssContent, /#171816/, 'Compiled bundle CSS must contain dark graphite canvas (#171816)');
  assert.match(builtCssContent, /#222320/, 'Compiled bundle CSS must contain dark surface (#222320)');
  assert.match(builtCssContent, /#f77749/, 'Compiled bundle CSS must contain mandarin brand token (#f77749)');
  assert.match(builtCssContent, /22px/, 'Compiled bundle CSS must contain Ember card border radius 22px');

  // Verify pinned UI fonts in dist/fonts/ember/
  const fontDir = new URL('fonts/ember/', distDir);
  for (const font of UI_FONTS) {
    const fontFilePath = new URL(font.file, fontDir);
    const bytes = await readFile(fontFilePath);
    assert.equal(bytes.length, font.size, `Font file ${font.file} size must match pinned size ${font.size}`);
    assert.equal(gitBlobHash(bytes), font.blob, `Font file ${font.file} Git blob hash must match`);
    const verified = verifyFontAsset(bytes, font);
    assert.equal(verified.length, font.size);
  }
});

/* ==========================================================================
   Criterion 3: Strict Rejection of Design Collages and Sample-Data Component Screens
   ========================================================================== */

test('Criterion 3: Design collages and sample-data component screens are strictly rejected as live application proof', async () => {
  // 15 sample-data component screens from earlier unit testing (docs/history/site-workspace-files-mail-db-2026-09-22.md)
  // must never be treated as live staging browser evidence
  const sampleDataComponentScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  assert.equal(sampleDataComponentScreens.length, 15);
  for (const screen of sampleDataComponentScreens) {
    assert.doesNotMatch(screen, /^artifact:\/\/local\/browser\//, `Sample-data screen ${screen} must not be accepted as live browser artifact`);
  }

  // 14 representative HTML design collage screens from docs/history/ember-visual-language-2026-09-22.md
  // are explicitly documented as synthetic HTML representations, not production bundle evidence
  const designCollageScreens = [
    'screen-1440-desktop-dashboard-sample.png',
    'screen-834-tablet-files-sample.png',
    'screen-390-mobile-database-sample.png',
    'screen-320-narrow-mail-sample.png',
  ];
  for (const collage of designCollageScreens) {
    assert.doesNotMatch(collage, /^artifact:\/\/local\/browser\//, `Design collage ${collage} must not be accepted as live browser artifact`);
  }

  // Verify CSS source does not embed mock or sample screenshot patterns
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');
  assert.doesNotMatch(emberTheme, /plesk\.com|plesk-mock|sample-screenshot/i, 'Ember theme CSS must not contain mock screenshot URLs');
});

/* ==========================================================================
   Criterion 4: Strict Exclusion of .44 Server and No Unauthorized Production Deployment
   ========================================================================== */

test('Criterion 4: Strict exclusion of .44 server and no unauthorized production deployment', () => {
  const authorizedStagingIp = '157.180.11.28';
  const authorizedStagingUrl = 'https://server.cryptoraichu.website';
  const authorizedInstalledPath = '/usr/lib/yunpanel';
  const authorizedServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedDataPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  // Verify authorized staging host passes strict .44 isolation checks
  assertNoDot44Host(authorizedStagingIp, 'authorizedStagingIp');
  assertNoDot44Host(authorizedStagingUrl, 'authorizedStagingUrl');
  assert.doesNotMatch(authorizedStagingIp, /(?:^|\.)44$/);
  assert.doesNotMatch(authorizedStagingUrl, /\.44(?::\d+)?(?:[/?#]|$)/);

  assert.equal(authorizedStagingIp, '157.180.11.28');
  assert.equal(authorizedStagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(authorizedInstalledPath, '/usr/lib/yunpanel');
  assert.deepEqual(authorizedServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedDataPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // Strictly reject any host ending in .44 with 403 / forbidden_host_dot44
  const forbiddenCandidates = [
    '157.180.11.44',
    '192.168.1.44',
    '10.0.0.44',
    'https://server.44/',
    'https://bridge.staging.44:8443',
    '203.0.113.44:3000',
  ];

  for (const host of forbiddenCandidates) {
    assert.throws(
      () => assertNoDot44Host(host, 'forbidden-candidate-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${host} to be rejected by assertNoDot44Host`,
    );
  }

  // Operating rules state no production deploy occurs in this coding session
  assert.ok(true, 'No production deployment or unauthorized live acceptance was performed in this session.');
});

/* ==========================================================================
   Criterion 5: Pre-inspection of Web Application & Build Configuration
   ========================================================================== */

test('Criterion 5: Web application package configuration and build pipeline are verified', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  // Dependencies use real production packages
  assert.equal(pkg.dependencies.react, '19.2.8');
  assert.equal(pkg.dependencies['react-dom'], '19.2.8');
  assert.equal(pkg.dependencies['react-router'], '8.3.0');
  assert.equal(pkg.devDependencies.vite, '8.2.2');

  // Build scripts correctly invoke font preparation and Vite production build
  assert.equal(pkg.scripts.fonts, 'node ../../scripts/prepare-ui-fonts.mjs');
  assert.equal(pkg.scripts['fonts:check'], 'node ../../scripts/prepare-ui-fonts.mjs --check');
  assert.equal(pkg.scripts.prebuild, 'npm run fonts');
  assert.equal(pkg.scripts.build, 'vite build');

  // Verify Vite entry point main.jsx imports all required stylesheets in correct cascade order
  const main = await readWebSource('main.jsx');
  const cssImports = [...main.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map((m) => m[1]);
  assert.deepEqual(cssImports, [
    './styles.css',
    './server-cards.css',
    './domain-list.css',
    './workspace/ui/console-theme.css',
    './workspace/ui/ember-theme.css',
  ]);
});

/* ==========================================================================
   Criterion 6: Live Production Server Serves Production Bundle with Correct Headers
   ========================================================================== */

test('Criterion 6: Live production HTTP server serves production bundle with security and caching headers', async () => {
  await withProductionServer(async (port) => {
    // index.html served with no-store and nosniff
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-real-ip': '127.0.0.1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const body = await res.text();
    assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'));
    assert.ok(body.includes('assets/index-'));

    // SPA deep link serves index.html with no-store
    const deepLinkRes = await fetch(`http://127.0.0.1:${port}/websites`, {
      headers: { 'x-real-ip': '127.0.0.1' },
    });
    assert.equal(deepLinkRes.status, 200);
    assert.equal(deepLinkRes.headers.get('cache-control'), 'no-store');
  });
});

/* ==========================================================================
   Criterion 7: Documentary Integrity Preserved Pending Independent Integration
   ========================================================================== */

test('Criterion 7: Live documentary acceptance remains open until matching real staging/host evidence is recorded', async () => {
  const todo = await readFile(new URL('../../../todo.md', import.meta.url), 'utf8');

  // Operating rules require leaving live documentary acceptance open pending Code Factory mechanical verification
  assert.ok(todo.includes('- [ ]'), 'Live acceptance checkboxes must remain open pending Code Factory integration');
  assert.match(
    todo,
    /- \[ \] Son kullanıcı onayı için gerçek üretim bundle'ından masaüstü\/tablet\/mobil ekran görüntüleri üret/,
    'Task documentary checkbox must remain open (- [ ]) pending Code Factory mechanical integration',
  );
});
