import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpToolsService } from '../src/website-php-tools-service.js';

const websiteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const applicationId = '11111111-1111-4111-8111-111111111111';
const serverId = '22222222-2222-4222-8222-222222222222';
const foreignId = '33333333-3333-4333-8333-333333333333';
const unixUser = 'yunapp-0123456789ab';
const root = `/var/lib/yunpanel/apps/${applicationId}/current`;
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const ok = (stdout = '') => ({ success: true, exitCode: 0, stdout, stderr: '' });
function harness() {
  const website = { id: websiteId, applicationId, serverId, unixUser, runtimeType: 'php' };
  const application = { id: applicationId, serverId, unixUser, type: 'php' };
  const files = new Map([[`${root}/public`, 'directory'], [`${root}/composer.json`, 'file'], [`${root}/composer.lock`, 'file']]);
  const calls = [];
  const manager = {
    inspectWpCli: async () => ({ available: true, version: '2.8.1' }),
    inspectComposer: async () => ({ available: true, version: '2.7.2' }),
    runWpCli: async (value) => {
      calls.push({ tool: 'wp', ...value });
      return ok(value.args[0] === 'version' ? '6.4.2\n' : ['plugin', 'theme'].includes(value.command)
        ? JSON.stringify([{ name: 'example', status: 'active', version: '1.0.0', secret: 'must-not-leak' }]) : '');
    },
    runComposer: async (value) => { calls.push({ tool: 'composer', ...value }); return ok('valid'); },
  };
  const service = createWebsitePhpToolsService({ websiteRegistry: { getWebsite: async () => website },
    applicationRegistry: { getApplication: async () => application }, phpCliToolManager: manager,
    lstatFn: async (file) => {
      const entry = files.get(file); if (entry instanceof Error) throw entry;
      if (!entry) throw missing();
      return { isDirectory: () => entry === 'directory', isFile: () => entry === 'file' };
    },
  });
  return { service, website, application, manager, files, calls };
}
test('WP status includes verified binding and sanitized successful inventories', async () => {
  const h = harness(); const value = await h.service.getWpCliStatus(websiteId);
  assert.equal(value.schemaVersion, 1); assert.equal(value.websiteId, websiteId); assert.equal(value.serverId, serverId);
  assert.equal(value.applicationId, applicationId); assert.equal(value.unixUser, unixUser);
  assert.equal(value.installed, true); assert.equal(value.coreVersion, '6.4.2');
  assert.equal(value.checks.plugins, 'ready'); assert.equal(value.plugins.length, 1);
  assert.equal(JSON.stringify(value).includes('must-not-leak'), false);
  assert.ok(Number.isFinite(Date.parse(value.inspectedAt)));
  assert.ok(h.calls.every((c) => c.unixUser === unixUser && c.cwd === `${root}/public`));
});
for (const tool of ['WpCli', 'Composer']) {
  test(`${tool} missing tool is not a healthy project`, async () => {
    const h = harness(); h.manager[`inspect${tool}`] = async () => ({ available: false, version: null });
    const value = await h.service[`get${tool}Status`](websiteId);
    assert.equal(value.available, false); assert.equal(h.calls.length, 0);
    assert.equal(tool === 'WpCli' ? value.installed : value.valid, null);
  });
  test(`${tool} inspection failure remains unknown, without leaking stderr`, async () => {
    const h = harness(); h.manager[`inspect${tool}`] = async () => { throw new Error('private-path'); };
    const value = await h.service[`get${tool}Status`](websiteId);
    assert.equal(value.available, null); assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(value).includes('private-path'));
  });
}
for (const failed of [null, { success: false, exitCode: 1, stderr: 'secret-timeout' }, { success: true, exitCode: 1 }]) {
  test(`unsuccessful WordPress inspection is not absence: ${JSON.stringify(failed)}`, async () => {
    const h = harness(); h.manager.runWpCli = async () => failed;
    const value = await h.service.getWpCliStatus(websiteId);
    assert.equal(value.installed, null); assert.equal(value.checks.installation, 'unknown');
    assert.equal(value.checks.plugins, 'not_checked');
    assert.ok(!JSON.stringify(value).includes('secret-timeout'));
  });
}
for (const stdout of ['bad-json', '{}', '[null]', '[{"name":"x"}]', '[{"name":"x","status":"active"},{"name":"x","status":"active"}]']) {
  test(`malformed plugin list is unknown: ${stdout}`, async () => {
    const h = harness(), original = h.manager.runWpCli;
    h.manager.runWpCli = async (c) => c.command === 'plugin' ? ok(stdout) : original(c);
    const value = await h.service.getWpCliStatus(websiteId);
    assert.deepEqual(value.plugins, []); assert.equal(value.checks.plugins, 'unknown');
    assert.equal(value.checks.themes, 'ready');
  });
}
test('empty verified list is distinct from a failed list', async () => {
  const h = harness(), original = h.manager.runWpCli;
  h.manager.runWpCli = async (c) => c.command === 'plugin' ? ok('[]') : original(c);
  const value = await h.service.getWpCliStatus(websiteId);
  assert.deepEqual(value.plugins, []); assert.equal(value.checks.plugins, 'ready');
});
for (const patch of [{ id: foreignId }, { serverId: foreignId }, { unixUser: 'root' }]) {
  test(`foreign application binding ${Object.keys(patch)[0]} prevents commands`, async () => {
    const h = harness(); Object.assign(h.application, patch);
    await assert.rejects(h.service.getWpCliStatus(websiteId)); assert.equal(h.calls.length, 0);
  });
}
test('registry returns different Website ID: no command', async () => {
  const h = harness(); h.website.id = foreignId;
  await assert.rejects(h.service.getWpCliStatus(websiteId)); assert.equal(h.calls.length, 0);
});
test('shared registry object changed during inspection invalidates the result', async () => {
  const h = harness(), original = h.manager.runWpCli;
  h.manager.runWpCli = async (c) => { const result = await original(c); h.website.unixUser = 'yunapp-abcdef123456'; h.application.unixUser = h.website.unixUser; return result; };
  await assert.rejects(h.service.getWpCliStatus(websiteId), { code: 'website_php_context_changed' });
  assert.equal(h.calls.length, 1);
});
test('Composer status and run both prefer root when both projects exist', async () => {
  const h = harness(); h.files.set(`${root}/public/composer.json`, 'file');
  const status = await h.service.getComposerStatus(websiteId);
  await h.service.runComposer(websiteId, { command: 'dump-autoload', args: ['-o'] });
  assert.equal(status.projectLocation, 'root'); assert.equal(status.valid, true);
  assert.ok(h.calls.every((c) => c.cwd === root));
});
test('Composer selects public only after proven root absence', async () => {
  const h = harness(); h.files.delete(`${root}/composer.json`); h.files.set(`${root}/public/composer.json`, 'file');
  const status = await h.service.getComposerStatus(websiteId);
  await h.service.runComposer(websiteId, { command: 'validate' });
  assert.equal(status.projectLocation, 'public'); assert.equal(status.hasComposerLock, false);
  assert.ok(h.calls.every((c) => c.cwd === `${root}/public`));
});
for (const problem of [Object.assign(new Error('private path'), { code: 'EACCES' }), 'symlink', 'directory']) {
  test(`unreadable or nonregular root project prevents public fallback: ${String(problem)}`, async () => {
    const h = harness(); h.files.set(`${root}/composer.json`, problem); h.files.set(`${root}/public/composer.json`, 'file');
    const status = await h.service.getComposerStatus(websiteId);
    assert.equal(status.hasComposerJson, null); assert.equal(status.checks.project, 'unknown');
    assert.equal(h.calls.length, 0);
    await assert.rejects(h.service.runComposer(websiteId, { command: 'install' }), { code: 'composer_project_unknown' });
    assert.equal(h.calls.length, 0);
  });
}
test('Composer absent project is not a successful validation', async () => {
  const h = harness(); h.files.delete(`${root}/composer.json`);
  const status = await h.service.getComposerStatus(websiteId);
  assert.equal(status.hasComposerJson, false); assert.equal(status.valid, null);
  assert.equal(status.checks.validation, 'not_checked'); assert.equal(h.calls.length, 0);
});
test('Composer lock read error is unknown, not absent', async () => {
  const h = harness(); h.files.set(`${root}/composer.lock`, Object.assign(new Error(), { code: 'EIO' }));
  const status = await h.service.getComposerStatus(websiteId);
  assert.equal(status.hasComposerLock, null); assert.equal(status.checks.lock, 'unknown');
});
test('Composer validation timeout cannot mean valid or definitely invalid', async () => {
  const h = harness(); h.manager.runComposer = async () => ({ success: false, exitCode: 1, stderr: 'private' });
  const status = await h.service.getComposerStatus(websiteId);
  assert.equal(status.valid, null); assert.equal(status.checks.validation, 'unknown');
  assert.ok(!JSON.stringify(status).includes('private'));
});
test('public path permission error is not silent cwd fallback', async () => {
  const h = harness(); h.files.set(`${root}/public`, Object.assign(new Error(), { code: 'EACCES' }));
  await assert.rejects(h.service.getComposerStatus(websiteId), { code: 'website_php_path_unavailable' });
  assert.equal(h.calls.length, 0);
});
test('project location changes during validation invalidate the snapshot', async () => {
  const h = harness(); h.manager.runComposer = async () => { h.files.delete(`${root}/composer.json`); return ok(); };
  await assert.rejects(h.service.getComposerStatus(websiteId), { code: 'website_php_context_changed' });
});
