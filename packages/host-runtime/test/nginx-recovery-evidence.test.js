import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

const spec = Object.freeze({
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  targetType: 'proxy',
  target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-nginx-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    stagingDir: path.join(root, 'staging'),
    sitesDir: path.join(root, 'sites'),
  };
}

test('staged-domain evidence is absent until the exact deterministic stage exists', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const manager = createNginxManager({
    stagingDir,
    sitesDir,
    execFn: async () => { throw new Error('inspection must not execute nginx or systemctl'); },
  });

  assert.deepEqual(await manager.inspectStagedDomain(spec), { satisfied: false, result: null });
  const staged = await manager.stageDomain(spec);
  assert.deepEqual(await manager.inspectStagedDomain(spec), { satisfied: true, result: staged });
});

test('different staged content never satisfies recovery evidence', async (t) => {
  const { stagingDir, sitesDir } = await fixture(t);
  const manager = createNginxManager({ stagingDir, sitesDir });
  const staged = await manager.stageDomain(spec);
  const stagePath = path.join(stagingDir, staged.configName);
  await writeFile(stagePath, `${await readFile(stagePath, 'utf8')}# drift\n`, 'utf8');

  assert.deepEqual(await manager.inspectStagedDomain(spec), { satisfied: false, result: null });
});

test('staged-domain evidence rejects unreadable state with an authored error', async () => {
  const manager = createNginxManager({
    readFileFn: async () => { throw Object.assign(new Error('/private/path TOKEN=secret'), { code: 'EACCES' }); },
  });

  await assert.rejects(
    manager.inspectStagedDomain(spec),
    (error) => error instanceof NginxManagerError
      && error.code === 'staged_config_inspection_failed'
      && !error.message.includes('/private')
      && !error.message.includes('secret'),
  );
});
