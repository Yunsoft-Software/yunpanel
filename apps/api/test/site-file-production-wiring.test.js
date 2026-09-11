import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production mounts the site-user file manager before the global JSON body limit', async () => {
  const [appSource, managerSource, buildSource] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/site-file-manager.js', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/build-deb.sh', import.meta.url), 'utf8'),
  ]);
  assert.match(appSource, /createSiteFileManager\(\{ websiteRegistry, localServerId \}\)/);
  const mountIndex = appSource.indexOf('mountSiteFileRoutes(app, { siteFileManager: files });');
  const globalJsonIndex = appSource.indexOf("app.use(express.json({ limit: '256kb' }));");
  assert.ok(mountIndex >= 0 && globalJsonIndex > mountIndex);
  assert.match(managerSource, /execFileWithInput\([\s\S]*RUNUSER_PATH,[\s\S]*\['-u', user, '--', process\.execPath, WORKER_PATH\]/);
  assert.match(managerSource, /child\.stdin\.end\(input\)/);
  assert.match(managerSource, /getuid\(\) !== 0/);
  assert.match(buildSource, /cp -a apps\/api apps\/agent apps\/web/);
  assert.match(buildSource, /docs\/site-files\.md/);
});
