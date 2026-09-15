import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyStaticArtifact } from '../src/static-artifact-worker.js';

function mode(value) {
  return value.mode & 0o777;
}

test('static artifact worker creates directories 0750 and files 0640', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<h1>ok</h1>');
  await writeFile(path.join(source, 'assets', 'app.js'), 'console.log("ok")');
  await chmod(path.join(source, 'index.html'), 0o666);
  await chmod(path.join(source, 'assets', 'app.js'), 0o777);

  const result = await copyStaticArtifact({ sourceDir: source, targetDir: target, healthFile: 'index.html' });

  assert.equal(result.files, 2);
  assert.equal(mode(await stat(target)), 0o750);
  assert.equal(mode(await stat(path.join(target, 'assets'))), 0o750);
  assert.equal(mode(await stat(path.join(target, 'index.html'))), 0o640);
  assert.equal(mode(await stat(path.join(target, 'assets', 'app.js'))), 0o640);
});
