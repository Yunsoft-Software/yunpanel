import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  packageVersionedDocsBundle,
  verifyVersionedDocsBundle,
} from '../../../scripts/verify-and-package-docs.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'docs', 'yunpanel-docs-0.3.0');

test('YunPanel 0.3.0 bilingual docs bundle satisfies Yunsoft Website importer contract (locales, SemVer, hashes, links, zero secrets, no symlinks/traversal)', () => {
  const result = verifyVersionedDocsBundle(BUNDLE_DIR);
  assert.equal(result.product, 'yunpanel');
  assert.equal(result.version, '0.3.0');
  assert.match(result.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(result.pagesCount, 11);
  assert.equal(result.docFilesCount, 22);
  assert.equal(result.screenshotsCount, 34);
  assert.ok(result.internalLinkCount >= 40, `Expected rich internal doc:<slug> cross-links, got ${result.internalLinkCount}`);
  assert.ok(result.imageRefCount >= 34, `Expected TR & EN image references, got ${result.imageRefCount}`);

  // Public campaign links and screenshot provenance in both guide languages.
  const trLicense = readFileSync(path.join(BUNDLE_DIR, 'locales/tr/licensing-and-premium.md'), 'utf8');
  const enLicense = readFileSync(path.join(BUNDLE_DIR, 'locales/en/licensing-and-premium.md'), 'utf8');
  const trSetup = readFileSync(path.join(BUNDLE_DIR, 'locales/tr/first-time-setup.md'), 'utf8');
  const enSetup = readFileSync(path.join(BUNDLE_DIR, 'locales/en/first-time-setup.md'), 'utf8');
  for (const guide of [trLicense, trSetup]) {
    assert.match(guide, /https:\/\/yunsoft\.com\/kampanya\/premium-3-ay\)/);
    assert.match(guide, /yerel `0\.3\.0` \(`f30fd779`\) aday derlemesi/);
  }
  for (const guide of [enLicense, enSetup]) {
    assert.match(guide, /https:\/\/yunsoft\.com\/campaign\/premium-3-months\)/);
    assert.match(guide, /local `0\.3\.0` \(`f30fd779`\) candidate build/);
  }
});

test('Docs validator checks image paths and the language of file and screenshot ID references', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-docs-neg-'));
  try {
    const copyDir = path.join(tmpDir, 'yunpanel-docs-0.3.0');
    cpSync(BUNDLE_DIR, copyDir, { recursive: true });

    // 1. ../../assets/... MUST be rejected
    const trInstall = path.join(copyDir, 'locales/tr/installation-and-upgrade.md');
    const original = readFileSync(trInstall, 'utf8');
    writeFileSync(trInstall, original.replace('(assets/tr/18-tools-settings.png)', '(../../assets/tr/18-tools-settings.png)'), 'utf8');
    assert.throws(
      () => verifyVersionedDocsBundle(copyDir),
      /must be screenshot:<id> or package-root assets/,
    );

    // 2. screenshot:<manifest-id> MUST be accepted
    writeFileSync(trInstall, original.replace('(assets/tr/18-tools-settings.png)', '(screenshot:tools-settings-overview)'), 'utf8');
    const ok = verifyVersionedDocsBundle(copyDir);
    assert.equal(ok.screenshotsCount, 34);

    const enInstall = path.join(copyDir, 'locales/en/installation-and-upgrade.md');
    const englishOriginal = readFileSync(enInstall, 'utf8');
    for (const wrongLocaleReference of ['assets/tr/18-tools-settings.png', 'screenshot:tools-settings-overview']) {
      writeFileSync(enInstall, englishOriginal.replace('(assets/en/18-tools-settings.png)', `(${wrongLocaleReference})`), 'utf8');
      assert.throws(() => verifyVersionedDocsBundle(copyDir), /Image locale mismatch.*en page references tr screenshot/);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('YunPanel 0.3.0 docs packager produces a clean traversal-free tarball with root yunpanel-docs-0.3.0/', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-docs-tar-'));
  try {
    const archivePath = path.join(tmpDir, 'yunpanel-docs-0.3.0.tar.gz');
    const result = packageVersionedDocsBundle(BUNDLE_DIR, archivePath);
    assert.match(result.archiveSha256, /^[0-9a-f]{64}$/);
    assert.ok(result.archiveEntries >= 40);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
