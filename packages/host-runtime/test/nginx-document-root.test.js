import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNginxManager } from '../src/nginx-manager.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-document-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'site/public'), { recursive: true });
  const manager = createNginxManager({ stagingDir: path.join(root, 'staging'), sitesDir: path.join(root, 'enabled'), execFn: async () => '' });
  const spec = { primaryDomain: 'owned.example.test', targetType: 'static', target: { root: path.join(root, 'site') }, nginxSettings: { documentRoot: 'public' } };
  return { root, manager, spec };
}
test('document root stage and activation use the same contained directory', async t => {
  const f = await fixture(t);
  const stage = await f.manager.stageDomain(f.spec);
  const result = await f.manager.activateDomain({ primaryDomain: f.spec.primaryDomain, checksum: stage.checksum });
  assert.equal(result.active, true);
});
test('document root rejects symlinks and a missing directory before staging', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'foreign'));
  await symlink(path.join(f.root, 'foreign'), path.join(f.root, 'site/link'));
  for (const directory of ['link', 'missing']) await assert.rejects(f.manager.stageDomain({ ...f.spec, nginxSettings: { documentRoot: directory } }), { code: 'nginx_document_root_unavailable' });
});
test('activation rechecks a directory replaced with a symlink after preview/stage', async t => {
  const f = await fixture(t);
  const stage = await f.manager.stageDomain(f.spec);
  await rm(path.join(f.root, 'site/public'), { recursive: true });
  await symlink(f.root, path.join(f.root, 'site/public'));
  await assert.rejects(f.manager.activateDomain({ primaryDomain: f.spec.primaryDomain, checksum: stage.checksum }), { code: 'nginx_document_root_unavailable' });
});
