import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public upstream assets, pinned to a commit AND exact Git blob content hashes.
// Acquisition happens at build time. No Google/CDN request or CSP change in browsers.
const revision = 'e44c4b011a820c2cbe2fd2cfa8052037d7edb571';
const upstream = `https://raw.githubusercontent.com/google/fonts/${revision}/ofl`;
export const UI_FONTS = Object.freeze([
  { file: 'manrope-75274da585.ttf', source: `${upstream}/manrope/Manrope%5Bwght%5D.ttf`, size: 164700, blob: '75274da58537d6123b14f2cd0c355ad4681fc2b3' },
  { file: 'manrope-OFL.txt', source: `${upstream}/manrope/OFL.txt`, size: 4387, blob: 'e271172a9ed0cddc895aabb6509f1c7d880b492d' },
  { file: 'outfit-466d6245f9.ttf', source: `${upstream}/outfit/Outfit%5Bwght%5D.ttf`, size: 110884, blob: '466d6245f9582df39bf73da91a8b3c938fd061cd' },
  { file: 'outfit-OFL.txt', source: `${upstream}/outfit/OFL.txt`, size: 4389, blob: '723cd447edee83ed3bb07c3343f478d352aa7440' },
]);
export const gitBlobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export function verifyFontAsset(bytes, asset) {
  if (bytes.length !== asset.size || gitBlobHash(bytes) !== asset.blob) {
    throw new Error(`UI font asset integrity mismatch: ${asset.file}`);
  }
  return bytes;
}
const destination = fileURLToPath(new URL('../apps/web/public/fonts/ember/', import.meta.url));
async function cachedFile(path, asset) {
  try { return verifyFontAsset(await readFile(path), asset); }
  catch (error) { if (error.code === 'ENOENT' || error.message.startsWith('UI font asset integrity')) return null; throw error; }
}
export async function prepareUiFonts({ directory = destination, cacheDirectory = process.env.YUNPANEL_FONT_CACHE_DIR,
  fetchImpl = globalThis.fetch, assets = UI_FONTS, check = false } = {}) {
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const asset of assets) {
    const target = join(directory, asset.file);
    if (await cachedFile(target, asset)) { results.push({ file: asset.file, source: 'existing' }); continue; }
    if (check) throw new Error(`Verified UI font asset missing: ${asset.file}. Run npm run fonts --workspace @yunpanel/web.`);
    let bytes = cacheDirectory ? await cachedFile(join(resolve(cacheDirectory), asset.file), asset) : null;
    const origin = bytes ? 'cache' : 'upstream';
    if (!bytes) {
      const response = await fetchImpl(asset.source, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`UI font download failed (${response.status}): ${asset.file}`);
      // Fixed-size bounded stream: a gateway error page or oversized response cannot be installed.
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > asset.size) throw new Error(`UI font response too large: ${asset.file}`);
        chunks.push(Buffer.from(chunk));
      }
      bytes = verifyFontAsset(Buffer.concat(chunks), asset);
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    results.push({ file: asset.file, source: origin });
  }
  return results;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareUiFonts({ check: process.argv.includes('--check') }).then((results) => {
    console.log(`UI typography ready: ${results.length} verified assets (Manrope / Outfit).`);
  }).catch((error) => {
    console.error(`${error.message}\nFont preparation did not complete. For an offline build, supply the verified assets through YUNPANEL_FONT_CACHE_DIR. No production dependencies were changed.`);
    process.exitCode = 1;
  });
}
