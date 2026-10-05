import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobHash, prepareUiFonts, UI_FONTS, verifyFontAsset } from '../../../scripts/prepare-ui-fonts.mjs';
const bytes = Buffer.from('deterministic font fixture');
const asset = { file: 'fixture.ttf', size: bytes.length, blob: gitBlobHash(bytes), source: 'https://example.test/fixture' };
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'yunpanel-font-test-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('font and license assets are commit-pinned and hash-verified', () => {
  assert.equal(UI_FONTS.length, 4);
  for (const value of UI_FONTS) {
    assert.match(value.source, /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[a-f0-9]{40}\/ofl\//);
    assert.match(value.blob, /^[a-f0-9]{40}$/); assert.ok(value.size > 0 && value.size < 500000);
  }
  assert.equal(UI_FONTS.filter((v) => v.file.endsWith('OFL.txt')).length, 2);
});
test('unknown or corrupted content cannot masquerade as a prepared asset', () => {
  assert.deepEqual(verifyFontAsset(bytes, asset), bytes);
  assert.throws(() => verifyFontAsset(Buffer.from('x'.repeat(bytes.length)), asset), /integrity/);
});
test('first acquisition installs verified bytes atomically', () => temporary(async (directory) => {
  const result = await prepareUiFonts({ directory, assets: [asset], fetchImpl: async () => new Response(bytes) });
  assert.equal(result[0].source, 'upstream'); assert.deepEqual(await readFile(join(directory, asset.file)), bytes);
  assert.deepEqual(await readdir(directory), [asset.file]);
}));
test('verified cached output builds completely offline without fetch', () => temporary(async (directory) => {
  await writeFile(join(directory, asset.file), bytes);
  const result = await prepareUiFonts({ directory, assets: [asset], fetchImpl: () => { throw new Error('unexpected network'); } });
  assert.equal(result[0].source, 'existing');
}));
test('explicit offline asset directory supports reproducible installation', () => temporary(async (directory) => {
  const cacheDirectory = join(directory, 'cache');
  await prepareUiFonts({ directory: cacheDirectory, assets: [asset], fetchImpl: async () => new Response(bytes) });
  const result = await prepareUiFonts({ directory: join(directory, 'out'), cacheDirectory, assets: [asset], fetchImpl: () => { throw new Error('unexpected network'); } });
  assert.equal(result[0].source, 'cache');
}));
test('bad upstream responses never leave a font or temp file behind', () => temporary(async (directory) => {
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], fetchImpl: async () => new Response('x'.repeat(bytes.length)) }), /integrity/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], fetchImpl: async () => new Response('too large'.repeat(100)) }), /too large/);
  assert.deepEqual(await readdir(directory), []);
}));
test('network failure is explicit and never reported as completed typography', () => temporary(async (directory) => {
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], fetchImpl: async () => new Response(null, { status: 404 }) }), /404/);
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
}));
test('check-only detects missing assets and does not silently download', () => temporary(async (directory) => {
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], check: true }), /missing/);
  await writeFile(join(directory, asset.file), bytes);
  const result = await prepareUiFonts({ directory, assets: [asset], check: true });
  assert.equal(result[0].source, 'existing');
}));
test('corrupted destination asset fails check-only validation', () => temporary(async (directory) => {
  await writeFile(join(directory, asset.file), Buffer.from('corrupted font bytes'));
  await assert.rejects(prepareUiFonts({ directory, assets: [asset], check: true }), /missing|integrity/);
}));
test('corrupted cache directory asset fails offline validation without false positive installation', () => temporary(async (directory) => {
  const cacheDirectory = join(directory, 'cache');
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(join(cacheDirectory, asset.file), Buffer.from('corrupted cache bytes'));
  await assert.rejects(
    prepareUiFonts({
      directory: join(directory, 'out'),
      cacheDirectory,
      assets: [asset],
      fetchImpl: () => { throw new Error('offline network unreachable'); },
    }),
    /offline network unreachable|integrity/
  );
}));
test('OFL licenses and font files are packaged together in ember public font assets', async () => {
  const publicDir = new URL('../public/fonts/ember/', import.meta.url);
  const files = await readdir(publicDir);
  const ttfFiles = files.filter((f) => f.endsWith('.ttf'));
  const oflFiles = files.filter((f) => f.endsWith('-OFL.txt'));
  assert.equal(ttfFiles.length, 2);
  assert.equal(oflFiles.length, 2);
  assert.ok(files.includes('manrope-75274da585.ttf'));
  assert.ok(files.includes('manrope-OFL.txt'));
  assert.ok(files.includes('outfit-466d6245f9.ttf'));
  assert.ok(files.includes('outfit-OFL.txt'));
  for (const f of files) {
    const assetMeta = UI_FONTS.find((a) => a.file === f);
    assert.ok(assetMeta, `Unexpected or unmanaged file in fonts directory: ${f}`);
    const fileBytes = await readFile(new URL(`../public/fonts/ember/${f}`, import.meta.url));
    assert.doesNotThrow(() => verifyFontAsset(fileBytes, assetMeta));
  }
});
