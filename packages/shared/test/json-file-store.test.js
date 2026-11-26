import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupPathFor, readJsonWithFallback, writeJsonAtomic, writeTextAtomic } from '../src/json-file-store.js';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-json-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fileMode = async (target) => (await stat(target)).mode & 0o777;

test('writeJsonAtomic keeps the requested format and mode and leaves no temp files', async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, 'state', 'registry.json');
    await writeJsonAtomic(target, { version: 1, items: [] }, { trailingNewline: true, mode: 0o600, directoryMode: 0o700 });
    assert.equal(await readFile(target, 'utf8'), '{\n  "version": 1,\n  "items": []\n}\n');
    assert.equal(await fileMode(target), 0o600);
    assert.equal(await fileMode(path.dirname(target)), 0o700);

    await writeJsonAtomic(target, { compact: true }, { space: 0, mode: 0o640 });
    assert.equal(await readFile(target, 'utf8'), '{"compact":true}');
    assert.equal(await fileMode(target), 0o640);
    assert.deepEqual((await readdir(path.dirname(target))).sort(), ['registry.json', 'registry.json.bak']);
  });
});

test('each write keeps the previous good file as .bak', async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, 'registry.json');
    await writeJsonAtomic(target, { revision: 1 });
    await assert.rejects(readFile(backupPathFor(target)), { code: 'ENOENT' });
    await writeJsonAtomic(target, { revision: 2 });
    assert.deepEqual(JSON.parse(await readFile(backupPathFor(target), 'utf8')), { revision: 1 });
    assert.equal(await fileMode(backupPathFor(target)), 0o600);
  });
});

test('a corrupt main file never replaces the last good backup', async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, 'registry.json');
    await writeJsonAtomic(target, { revision: 1 });
    await writeJsonAtomic(target, { revision: 2 });
    await writeFile(target, '{"revision": 3');
    await writeJsonAtomic(target, { revision: 4 });
    assert.deepEqual(JSON.parse(await readFile(backupPathFor(target), 'utf8')), { revision: 1 });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { revision: 4 });
  });
});

test('a half-written temp file left by a crash does not change what is read', async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, 'registry.json');
    await writeJsonAtomic(target, { revision: 1 });
    await writeFile(`${target}.999.crashed.tmp`, '{"revision": 2, "ite');
    assert.deepEqual(await readJsonWithFallback(target), { revision: 1 });
    await writeTextAtomic(target, '{"revision":3}');
    assert.deepEqual(await readJsonWithFallback(target), { revision: 3 });
  });
});

test('missing main file rethrows ENOENT for the caller', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(readJsonWithFallback(path.join(directory, 'missing.json')), { code: 'ENOENT' });
  });
});

for (const [label, damaged, reason] of [['empty', '', 'empty file'], ['corrupt', '{"revision": 2,', 'invalid JSON']]) {
  test(`${label} main file is recovered from .bak and reported`, async () => {
    await withDirectory(async (directory) => {
      const target = path.join(directory, 'registry.json');
      await writeJsonAtomic(target, { revision: 1 });
      await writeJsonAtomic(target, { revision: 2 });
      await writeFile(target, damaged);
      const reports = [];
      assert.deepEqual(await readJsonWithFallback(target, { onRecovered: (report) => reports.push(report) }), { revision: 1 });
      assert.deepEqual(reports, [{ filePath: target, backupPath: backupPathFor(target), reason }]);
    });
  });
}

test('corrupt main and corrupt or missing backup fail closed with the main parse error', async () => {
  await withDirectory(async (directory) => {
    const target = path.join(directory, 'registry.json');
    await writeFile(target, '{broken');
    await assert.rejects(readJsonWithFallback(target, { onRecovered: () => assert.fail('must not recover') }), SyntaxError);
    await writeFile(backupPathFor(target), '');
    await assert.rejects(readJsonWithFallback(target, { onRecovered: () => assert.fail('must not recover') }), SyntaxError);
  });
});
