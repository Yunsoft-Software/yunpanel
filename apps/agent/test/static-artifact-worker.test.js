import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyStaticArtifact } from '../src/static-artifact-worker.js';

test('artifact copier publishes safe files only after health file validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-artifact-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  try {
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<html>ok</html>');
    await writeFile(path.join(source, 'assets', 'app.js'), 'console.log("ok")');
    await mkdir(path.join(source, '.git'));
    await writeFile(path.join(source, '.git', 'config'), 'secret git metadata');

    const result = await copyStaticArtifact({ sourceDir: source, targetDir: target, healthFile: 'index.html' });
    assert.equal(result.files, 2);
    assert.equal(result.healthFile, 'index.html');
    assert.equal(await readFile(path.join(target, 'index.html'), 'utf8'), '<html>ok</html>');
    await assert.rejects(readFile(path.join(target, '.git', 'config'), 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact copier rejects missing, empty and symbolic health files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-artifact-health-'));
  const source = path.join(root, 'source');

  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'asset.txt'), 'asset');

    await assert.rejects(
      copyStaticArtifact({ sourceDir: source, targetDir: path.join(root, 'missing'), healthFile: 'index.html' }),
      /health file is missing/,
    );

    await writeFile(path.join(source, 'index.html'), '');
    await assert.rejects(
      copyStaticArtifact({ sourceDir: source, targetDir: path.join(root, 'empty'), healthFile: 'index.html' }),
      /health file is invalid/,
    );

    await rm(path.join(source, 'index.html'));
    await writeFile(path.join(source, 'real.html'), 'ok');
    await symlink('real.html', path.join(source, 'index.html'));
    await assert.rejects(
      copyStaticArtifact({ sourceDir: source, targetDir: path.join(root, 'symlink'), healthFile: 'index.html' }),
      /symbolic links are not allowed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
