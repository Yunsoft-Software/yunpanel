import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNginxManager } from '../src/nginx-manager.js';

// nginx -t is checked on a real host separately; here the staged bytes are inspected.
test('a redirect Domain stages and activates a forwarding-only config', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-redirect-domain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createNginxManager({ stagingDir: path.join(root, 'staging'), sitesDir: path.join(root, 'enabled'), execFn: async () => '' });
  const spec = { primaryDomain: 'eski.example.test', targetType: 'redirect', target: { url: 'https://yeni.example.test', status: 301, preservePath: true }, nginxSettings: {} };
  const stage = await manager.stageDomain(spec);
  const result = await manager.activateDomain({ primaryDomain: spec.primaryDomain, checksum: stage.checksum });
  assert.equal(result.active, true);
  const [file] = await readdir(path.join(root, 'enabled'));
  assert.match(await readFile(path.join(root, 'enabled', file), 'utf8'), /return 301 https:\/\/yeni\.example\.test\$request_uri;/);
});
