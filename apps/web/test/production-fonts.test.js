import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createPanelServer } from '../server.js';
import { gitBlobHash, UI_FONTS, verifyFontAsset } from '../../../scripts/prepare-ui-fonts.mjs';

const proxyToken = 'p'.repeat(43);
const TURKISH_CHARS = ['İ', 'ı', 'Ğ', 'ğ', 'Ş', 'ş', 'Ç', 'ç', 'Ö', 'ö', 'Ü', 'ü'];
const NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function readTableDirectory(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const offset = 12 + i * 16;
    const tag = buf.toString('utf8', offset, offset + 4);
    const tableOffset = buf.readUInt32BE(offset + 8);
    const length = buf.readUInt32BE(offset + 12);
    tables.set(tag, { offset: tableOffset, length });
  }
  return tables;
}

function parseCmapTable(buf, cmapOffset) {
  const numSubtables = buf.readUInt16BE(cmapOffset + 2);
  const glyphMap = new Map();
  for (let s = 0; s < numSubtables; s++) {
    const subtableOffset = cmapOffset + buf.readUInt32BE(cmapOffset + 4 + s * 8 + 4);
    const format = buf.readUInt16BE(subtableOffset);
    if (format === 4) {
      const segCount = buf.readUInt16BE(subtableOffset + 6) / 2;
      const endCodeOffset = subtableOffset + 14;
      const startCodeOffset = endCodeOffset + segCount * 2 + 2;
      const idDeltaOffset = startCodeOffset + segCount * 2;
      const idRangeOffsetOffset = idDeltaOffset + segCount * 2;
      for (let i = 0; i < segCount; i++) {
        const end = buf.readUInt16BE(endCodeOffset + i * 2);
        const start = buf.readUInt16BE(startCodeOffset + i * 2);
        const idDelta = buf.readInt16BE(idDeltaOffset + i * 2);
        const idRangeOffset = buf.readUInt16BE(idRangeOffsetOffset + i * 2);
        if (start === 0xffff) break;
        for (let cp = start; cp <= end; cp++) {
          let glyphId = 0;
          if (idRangeOffset === 0) {
            glyphId = (cp + idDelta) & 0xffff;
          } else {
            const glyphOffset = (idRangeOffsetOffset + i * 2) + idRangeOffset + (cp - start) * 2;
            glyphId = buf.readUInt16BE(glyphOffset);
            if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff;
          }
          if (glyphId > 0 && !glyphMap.has(cp)) glyphMap.set(cp, glyphId);
        }
      }
    } else if (format === 12) {
      const numGroups = buf.readUInt32BE(subtableOffset + 12);
      for (let i = 0; i < numGroups; i++) {
        const start = buf.readUInt32BE(subtableOffset + 16 + i * 12);
        const end = buf.readUInt32BE(subtableOffset + 16 + i * 12 + 4);
        const startGlyphId = buf.readUInt32BE(subtableOffset + 16 + i * 12 + 8);
        for (let cp = start; cp <= end; cp++) {
          const glyphId = startGlyphId + (cp - start);
          if (glyphId > 0 && !glyphMap.has(cp)) glyphMap.set(cp, glyphId);
        }
      }
    }
  }
  return glyphMap;
}

function parseFvarAxes(buf, fvarOffset) {
  const axesArrayOffset = fvarOffset + buf.readUInt16BE(fvarOffset + 4);
  const axisCount = buf.readUInt16BE(fvarOffset + 8);
  const axisSize = buf.readUInt16BE(fvarOffset + 10);
  const axes = [];
  for (let a = 0; a < axisCount; a++) {
    const offset = axesArrayOffset + a * axisSize;
    const tag = buf.toString('utf8', offset, offset + 4);
    const minVal = buf.readInt32BE(offset + 4) / 65536;
    const defVal = buf.readInt32BE(offset + 8) / 65536;
    const maxVal = buf.readInt32BE(offset + 12) / 65536;
    axes.push({ tag, minVal, defVal, maxVal });
  }
  return axes;
}

function parseAdvanceWidths(buf, tables) {
  const hheaOffset = tables.get('hhea').offset;
  const numHMetrics = buf.readUInt16BE(hheaOffset + 34);
  const hmtxOffset = tables.get('hmtx').offset;
  return function getAdvance(glyphId) {
    if (glyphId < numHMetrics) {
      return buf.readUInt16BE(hmtxOffset + glyphId * 4);
    }
    return buf.readUInt16BE(hmtxOffset + (numHMetrics - 1) * 4);
  };
}

async function withProductionServer(run) {
  const webRoot = path.resolve(new URL('../dist', import.meta.url).pathname);
  const server = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiPort: 3001,
    proxyToken,
    publicOrigin: 'https://panel.example.com',
    webRoot,
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

test('production Vite output: Manrope and Outfit font requests return same-origin 200 with font/ttf and font-src CSP', async () => {
  await withProductionServer(async (port) => {
    const fontFiles = [
      { name: 'manrope-75274da585.ttf', expectedSize: 164700, blob: '75274da58537d6123b14f2cd0c355ad4681fc2b3' },
      { name: 'outfit-466d6245f9.ttf', expectedSize: 110884, blob: '466d6245f9582df39bf73da91a8b3c938fd061cd' },
    ];

    for (const font of fontFiles) {
      const response = await fetch(`http://127.0.0.1:${port}/fonts/ember/${font.name}`, {
        headers: { 'x-real-ip': '127.0.0.1' },
      });

      assert.equal(response.status, 200, `Expected 200 for ${font.name}`);
      assert.equal(response.headers.get('content-type'), 'font/ttf', `Expected font/ttf for ${font.name}`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'public, max-age=300');

      const csp = response.headers.get('content-security-policy');
      assert.ok(csp, 'CSP header must be present');
      assert.match(csp, /font-src\s+'self'/, `CSP must allow font-src 'self' for ${font.name}`);
      assert.match(csp, /default-src\s+'self'/);

      const arrayBuf = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuf);
      assert.equal(bytes.length, font.expectedSize);
      assert.equal(gitBlobHash(bytes), font.blob);
    }
  });
});

test('production server: OFL license files return 200 with text/plain charset utf-8', async () => {
  await withProductionServer(async (port) => {
    for (const license of ['manrope-OFL.txt', 'outfit-OFL.txt']) {
      const response = await fetch(`http://127.0.0.1:${port}/fonts/ember/${license}`, {
        headers: { 'x-real-ip': '127.0.0.1' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      const text = await response.text();
      assert.ok(text.includes('SIL OPEN FONT LICENSE Version 1.1'));
    }
  });
});

test('production Vite build index.html includes font preloads and stylesheet with swap display preventing CLS', async () => {
  const distDir = new URL('../dist/', import.meta.url);
  const indexHtml = await readFile(new URL('index.html', distDir), 'utf8');

  assert.match(indexHtml, /<link\s+rel="preload"\s+href="\/fonts\/ember\/manrope-75274da585\.ttf"\s+as="font"\s+type="font\/ttf"\s+crossorigin/);
  assert.match(indexHtml, /<link\s+rel="preload"\s+href="\/fonts\/ember\/outfit-466d6245f9\.ttf"\s+as="font"\s+type="font\/ttf"\s+crossorigin/);

  const assets = await readdir(new URL('assets/', distDir));
  const cssFile = assets.find((f) => f.startsWith('index-') && f.endsWith('.css'));
  assert.ok(cssFile, 'Built CSS file must exist');

  const css = await readFile(new URL(`assets/${cssFile}`, distDir), 'utf8');
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*Yun Manrope[^}]*font-display:\s*swap[^}]*src:\s*url\(\/fonts\/ember\/manrope-75274da585\.ttf\)/);
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*Yun Outfit[^}]*font-display:\s*swap[^}]*src:\s*url\(\/fonts\/ember\/outfit-466d6245f9\.ttf\)/);
});

test('actual font render proof: Manrope and Outfit TrueType cmap tables contain valid glyphs for all Turkish characters and numbers', async () => {
  const fonts = [
    { file: 'manrope-75274da585.ttf', minGlyphs: 500 },
    { file: 'outfit-466d6245f9.ttf', minGlyphs: 300 },
  ];

  for (const { file, minGlyphs } of fonts) {
    const fontPath = new URL(`../public/fonts/ember/${file}`, import.meta.url);
    const buf = await readFile(fontPath);
    const tables = readTableDirectory(buf);

    assert.ok(tables.has('cmap'), `${file} must contain a cmap table`);
    assert.ok(tables.has('hmtx'), `${file} must contain an hmtx table`);
    assert.ok(tables.has('hhea'), `${file} must contain an hhea table`);
    assert.ok(tables.has('head'), `${file} must contain a head table`);

    const glyphMap = parseCmapTable(buf, tables.get('cmap').offset);
    assert.ok(glyphMap.size >= minGlyphs, `${file} must contain at least ${minGlyphs} mapped glyphs`);

    const getAdvance = parseAdvanceWidths(buf, tables);

    for (const ch of TURKISH_CHARS) {
      const codePoint = ch.codePointAt(0);
      const glyphId = glyphMap.get(codePoint);
      assert.ok(glyphId !== undefined && glyphId > 0, `Turkish character '${ch}' (U+${codePoint.toString(16).padStart(4, '0')}) must map to valid glyph in ${file}`);
      const advance = getAdvance(glyphId);
      assert.ok(advance > 0, `Turkish character '${ch}' must have positive advance width in ${file}, got ${advance}`);
    }

    for (const num of NUMBERS) {
      const codePoint = num.codePointAt(0);
      const glyphId = glyphMap.get(codePoint);
      assert.ok(glyphId !== undefined && glyphId > 0, `Number '${num}' must map to valid glyph in ${file}`);
      const advance = getAdvance(glyphId);
      assert.ok(advance > 0, `Number '${num}' must have positive advance width in ${file}, got ${advance}`);
    }
  }
});

test('variable font weight variations: fvar tables support declared weight ranges and UI typography weights', async () => {
  const manropeBuf = await readFile(new URL('../public/fonts/ember/manrope-75274da585.ttf', import.meta.url));
  const manropeTables = readTableDirectory(manropeBuf);
  assert.ok(manropeTables.has('fvar'), 'Manrope must have fvar table for variable font weight');
  const manropeAxes = parseFvarAxes(manropeBuf, manropeTables.get('fvar').offset);
  const manropeWght = manropeAxes.find((a) => a.tag === 'wght');
  assert.ok(manropeWght, 'Manrope must have wght axis');
  assert.equal(manropeWght.minVal, 200);
  assert.equal(manropeWght.maxVal, 800);

  const outfitBuf = await readFile(new URL('../public/fonts/ember/outfit-466d6245f9.ttf', import.meta.url));
  const outfitTables = readTableDirectory(outfitBuf);
  assert.ok(outfitTables.has('fvar'), 'Outfit must have fvar table for variable font weight');
  const outfitAxes = parseFvarAxes(outfitBuf, outfitTables.get('fvar').offset);
  const outfitWght = outfitAxes.find((a) => a.tag === 'wght');
  assert.ok(outfitWght, 'Outfit must have wght axis');
  assert.equal(outfitWght.minVal, 100);
  assert.equal(outfitWght.maxVal, 900);

  const typographyCss = await readFile(new URL('../src/workspace/ui/ember-typography.css', import.meta.url), 'utf8');
  assert.match(typographyCss, /font-family:\s*'Yun Manrope';[^}]*font-weight:\s*200\s+800;/);
  assert.match(typographyCss, /font-family:\s*'Yun Outfit';[^}]*font-weight:\s*100\s+900;/);
});

test('monospace font family is strictly preserved in code editor and terminal components', async () => {
  const typographyCss = await readFile(new URL('../src/workspace/ui/ember-typography.css', import.meta.url), 'utf8');
  const terminalCss = await readFile(new URL('../src/workspace/terminal.css', import.meta.url), 'utf8');

  assert.match(typographyCss, /--ws-font-code:\s*ui-monospace,\s*'SFMono-Regular',\s*Consolas,\s*'Liberation Mono',\s*monospace;/);

  assert.match(typographyCss, /\.yf-editor textarea/);
  assert.match(typographyCss, /\.ws-terminal-surface/);

  assert.match(terminalCss, /\.ws-terminal-surface\s*\{[^}]*font-family:\s*var\(--ws-font-code/);
  assert.match(terminalCss, /\.ws-terminal-surface\s+\.xterm\s*\{[^}]*font-family:\s*var\(--ws-font-code/);

  const manropeBuf = await readFile(new URL('../public/fonts/ember/manrope-75274da585.ttf', import.meta.url));
  const tables = readTableDirectory(manropeBuf);
  const glyphMap = parseCmapTable(manropeBuf, tables.get('cmap').offset);
  const getAdvance = parseAdvanceWidths(manropeBuf, tables);

  const iAdvance = getAdvance(glyphMap.get('i'.charCodeAt(0)));
  const wAdvance = getAdvance(glyphMap.get('W'.charCodeAt(0)));
  assert.ok(wAdvance > iAdvance * 1.5, `Proportional UI font Manrope must have wider 'W' (${wAdvance}) than 'i' (${iAdvance})`);
});
