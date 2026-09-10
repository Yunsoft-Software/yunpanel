import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticRollbackEvidenceInspector, StaticRollbackEvidenceError } from '../src/static-rollback-evidence.js';

const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const currentReleaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

async function fixture(t) {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-rollback-evidence-'));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  const appRoot = path.join(webRoot, applicationId);
  await mkdir(path.join(appRoot, 'releases', releaseId), { recursive: true });
  await mkdir(path.join(appRoot, 'releases', currentReleaseId), { recursive: true });
  return { webRoot, appRoot, inspector: createStaticRollbackEvidenceInspector({ webRoot }) };
}

test('static rollback evidence requires both real releases and exact current symlink', async (t) => {
  const fx = await fixture(t);
  await symlink(path.join('releases', releaseId), path.join(fx.appRoot, 'current'));
  const evidence = await fx.inspector.inspect({ applicationId, releaseId, currentReleaseId });
  assert.deepEqual(evidence, {
    satisfied: true,
    result: { releaseId, previousReleaseId: currentReleaseId, active: true },
  });
});

test('different current release is not accepted as completed rollback evidence', async (t) => {
  const fx = await fixture(t);
  await symlink(path.join('releases', currentReleaseId), path.join(fx.appRoot, 'current'));
  assert.deepEqual(
    await fx.inspector.inspect({ applicationId, releaseId, currentReleaseId }),
    { satisfied: false, result: null },
  );
});

test('symlinked release directory is rejected', async (t) => {
  const fx = await fixture(t);
  const alternate = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
  await symlink(releaseId, path.join(fx.appRoot, 'releases', alternate));
  await symlink(path.join('releases', alternate), path.join(fx.appRoot, 'current'));
  assert.deepEqual(
    await fx.inspector.inspect({ applicationId, releaseId: alternate, currentReleaseId }),
    { satisfied: false, result: null },
  );
});

test('unexpected filesystem failures are redacted', async () => {
  const inspector = createStaticRollbackEvidenceInspector({
    webRoot: '/var/www/yunpanel/apps',
    lstatFn: async () => { throw Object.assign(new Error('/private/path SECRET=hidden'), { code: 'EACCES' }); },
  });
  await assert.rejects(
    inspector.inspect({ applicationId, releaseId, currentReleaseId }),
    (error) => error instanceof StaticRollbackEvidenceError
      && error.code === 'static_rollback_evidence_read_failed'
      && !error.message.includes('/private')
      && !error.message.includes('hidden'),
  );
});
