#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_RELATIVE_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\\)[A-Za-z0-9._/-]+$/;
const ASSET_FILE_PATTERN = /^assets\/(tr|en)\/[A-Za-z0-9._-]+\.(?:png|webp)$/;
const FORBIDDEN_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b157\.180\.11\.28\b/,
  /\b(?:\d{1,3}\.){3}44\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /eyJhbGciOiJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /__Host-yunpanel_session=/,
  /Authorization:\s*Bearer\s+\S+/i,
  /DocsDemo\w+Pass!/,
];

function sha256File(filePath) {
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function walkNoSymlinks(rootDir, currentDir = rootDir, files = []) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(currentDir, entry.name);
    const lstat = lstatSync(full);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Symlink is forbidden inside docs bundle: ${path.relative(rootDir, full)}`);
    }
    if (lstat.isDirectory()) {
      walkNoSymlinks(rootDir, full, files);
    } else if (lstat.isFile()) {
      files.push(path.relative(rootDir, full).split(path.sep).join('/'));
    } else {
      throw new Error(`Non-regular file is forbidden inside docs bundle: ${path.relative(rootDir, full)}`);
    }
  }
  return files;
}

function assertNoSecrets(content, label) {
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error(`Forbidden secret or sensitive host marker detected in ${label}: ${pattern}`);
    }
  }
}

export function verifyVersionedDocsBundle(bundleDir) {
  const resolvedRoot = path.resolve(bundleDir);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Docs bundle directory does not exist: ${resolvedRoot}`);
  }
  if (lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error(`Docs bundle root must not be a symlink: ${resolvedRoot}`);
  }

  const allFiles = walkNoSymlinks(resolvedRoot);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('manifest.json is missing at bundle root');
  }
  const manifestRaw = readFileSync(manifestPath, 'utf8');
  assertNoSecrets(manifestRaw, 'manifest.json');
  const manifest = JSON.parse(manifestRaw);

  if (manifest.schemaVersion !== 1) throw new Error(`Expected schemaVersion=1, got ${manifest.schemaVersion}`);
  if (manifest.product !== 'yunpanel') throw new Error(`Expected product=yunpanel, got ${manifest.product}`);
  if (typeof manifest.version !== 'string' || manifest.version.toLowerCase() === 'latest' || !SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`Invalid SemVer version in manifest: ${manifest.version}`);
  }
  const expectedDirName = `yunpanel-docs-${manifest.version}`;
  if (path.basename(resolvedRoot) !== expectedDirName) {
    throw new Error(`Bundle directory name must be '${expectedDirName}', got '${path.basename(resolvedRoot)}'`);
  }
  if (manifest.sourceRepo !== 'Yunsoft-Software/yunpanel') {
    throw new Error(`Invalid sourceRepo: ${manifest.sourceRepo}`);
  }
  if (typeof manifest.sourceCommit !== 'string' || !HEX40_PATTERN.test(manifest.sourceCommit)) {
    throw new Error(`sourceCommit must be a 40-char lowercase hex SHA, got: ${manifest.sourceCommit}`);
  }
  if (typeof manifest.verifiedAt !== 'string' || !UTC_ISO_PATTERN.test(manifest.verifiedAt) || Number.isNaN(Date.parse(manifest.verifiedAt))) {
    throw new Error(`verifiedAt must be a UTC ISO timestamp, got: ${manifest.verifiedAt}`);
  }

  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('manifest.pages must be a non-empty array');
  }

  const pageSlugs = new Set();
  const referencedDocFiles = new Set();
  for (const page of manifest.pages) {
    if (!SLUG_PATTERN.test(page.slug ?? '')) throw new Error(`Invalid page slug: ${page.slug}`);
    if (pageSlugs.has(page.slug)) throw new Error(`Duplicate page slug: ${page.slug}`);
    pageSlugs.add(page.slug);
    if (!Number.isInteger(page.order) || page.order < 1) throw new Error(`Invalid order for ${page.slug}`);
    if (typeof page.section !== 'string' || !page.section) throw new Error(`Missing section for ${page.slug}`);

    for (const locale of ['tr', 'en']) {
      const entry = page.locales?.[locale];
      if (!entry || typeof entry.title !== 'string' || !entry.title.trim() || typeof entry.summary !== 'string' || !entry.summary.trim()) {
        throw new Error(`Missing ${locale} title/summary for page ${page.slug}`);
      }
      const expectedFile = `locales/${locale}/${page.slug}.md`;
      if (entry.file !== expectedFile || !SAFE_RELATIVE_PATTERN.test(entry.file)) {
        throw new Error(`Invalid file path for ${page.slug} (${locale}): ${entry.file}`);
      }
      const absFile = path.join(resolvedRoot, entry.file);
      if (!existsSync(absFile)) throw new Error(`Referenced doc file missing: ${entry.file}`);
      referencedDocFiles.add(entry.file);
    }
  }

  if (!pageSlugs.has(manifest.defaultPage)) {
    throw new Error(`defaultPage '${manifest.defaultPage}' is not listed in manifest.pages`);
  }

  // Verify locales.tr and locales.en sections & identical slug sets
  const localeKeys = Object.keys(manifest.locales ?? {}).sort();
  if (JSON.stringify(localeKeys) !== JSON.stringify(['en', 'tr'])) {
    throw new Error(`manifest.locales must define exactly tr and en, got: ${localeKeys.join(', ')}`);
  }
  const localeSectionSlugs = {};
  for (const locale of ['tr', 'en']) {
    const loc = manifest.locales[locale];
    if (typeof loc.title !== 'string' || !loc.title.trim() || typeof loc.summary !== 'string' || !loc.summary.trim()) {
      throw new Error(`Missing title/summary for manifest.locales.${locale}`);
    }
    if (!Array.isArray(loc.sections) || loc.sections.length === 0) {
      throw new Error(`Missing sections for manifest.locales.${locale}`);
    }
    const slugs = [];
    for (const section of loc.sections) {
      if (typeof section.id !== 'string' || !section.id || typeof section.title !== 'string' || !section.title) {
        throw new Error(`Invalid section in manifest.locales.${locale}`);
      }
      if (!Array.isArray(section.pages) || section.pages.length === 0) {
        throw new Error(`Empty section pages in ${locale}.${section.id}`);
      }
      for (const slug of section.pages) {
        if (!pageSlugs.has(slug)) throw new Error(`Section ${locale}.${section.id} references unknown slug '${slug}'`);
        slugs.push(slug);
      }
    }
    localeSectionSlugs[locale] = [...slugs].sort();
    if (JSON.stringify(localeSectionSlugs[locale]) !== JSON.stringify([...pageSlugs].sort())) {
      throw new Error(`Locale ${locale} sections do not cover exact page slug set`);
    }
  }
  if (JSON.stringify(localeSectionSlugs.tr) !== JSON.stringify(localeSectionSlugs.en)) {
    throw new Error('TR and EN slug sets do not match');
  }

  // Verify screenshots
  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length === 0) {
    throw new Error('manifest.screenshots must be a non-empty array');
  }
  const screenshotIds = new Set();
  const registeredAssets = new Map();
  for (const shot of manifest.screenshots) {
    if (typeof shot.id !== 'string' || !shot.id || screenshotIds.has(shot.id)) {
      throw new Error(`Invalid or duplicate screenshot id: ${shot.id}`);
    }
    screenshotIds.add(shot.id);
    if (shot.product !== manifest.product) throw new Error(`Screenshot ${shot.id} product mismatch`);
    if (shot.version !== manifest.version) throw new Error(`Screenshot ${shot.id} version mismatch`);
    if (!['tr', 'en'].includes(shot.locale)) throw new Error(`Screenshot ${shot.id} invalid locale: ${shot.locale}`);
    if (shot.sanitized !== true) throw new Error(`Screenshot ${shot.id} must have sanitized: true`);
    if (typeof shot.alt !== 'string' || !shot.alt.trim() || typeof shot.caption !== 'string' || !shot.caption.trim()) {
      throw new Error(`Screenshot ${shot.id} missing alt/caption`);
    }
    if (typeof shot.capturedFrom !== 'string' || !shot.capturedFrom.includes(manifest.sourceCommit)) {
      throw new Error(`Screenshot ${shot.id} capturedFrom must reference sourceCommit ${manifest.sourceCommit}`);
    }
    if (!ASSET_FILE_PATTERN.test(shot.file ?? '') || !SAFE_RELATIVE_PATTERN.test(shot.file)) {
      throw new Error(`Screenshot ${shot.id} invalid file path: ${shot.file}`);
    }
    const dirLocale = shot.file.split('/')[1];
    if (dirLocale !== shot.locale) {
      throw new Error(`Screenshot ${shot.id} locale '${shot.locale}' mismatches directory '${dirLocale}'`);
    }
    if (!SHA256_PATTERN.test(shot.sha256 ?? '')) {
      throw new Error(`Screenshot ${shot.id} invalid sha256`);
    }
    const absImg = path.join(resolvedRoot, shot.file);
    if (!existsSync(absImg)) throw new Error(`Screenshot file missing: ${shot.file}`);
    const actualSha = sha256File(absImg);
    if (actualSha !== shot.sha256) {
      throw new Error(`SHA-256 mismatch for ${shot.file}: manifest=${shot.sha256} actual=${actualSha}`);
    }
    registeredAssets.set(shot.file, shot);
  }

  // Ensure no unregistered files exist anywhere in bundle
  const allowedFiles = new Set(['manifest.json', ...referencedDocFiles, ...registeredAssets.keys()]);
  for (const rel of allFiles) {
    if (!allowedFiles.has(rel)) {
      throw new Error(`Unregistered file inside docs bundle: ${rel}`);
    }
  }

  // Verify every markdown page: version visible, zero secrets, valid internal links & registered images, zero traversal
  let internalLinkCount = 0;
  let imageRefCount = 0;
  const usedAssets = new Set();

  for (const relDoc of referencedDocFiles) {
    const absDoc = path.join(resolvedRoot, relDoc);
    const content = readFileSync(absDoc, 'utf8');
    assertNoSecrets(content, relDoc);
    if (!content.includes(manifest.version)) {
      throw new Error(`Doc ${relDoc} must visibly mention version ${manifest.version}`);
    }
    if (!content.includes(manifest.sourceCommit.slice(0, 8))) {
      throw new Error(`Doc ${relDoc} must reference verified source revision ${manifest.sourceCommit.slice(0, 8)}`);
    }

    // Images: ![alt](target) — Website validator accepts ONLY screenshot:<manifest-id> or package-root assets/...; ../../assets is rejected!
    for (const match of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim();
      imageRefCount += 1;
      if (target.startsWith('screenshot:')) {
        const shotId = target.slice('screenshot:'.length);
        const byId = manifest.screenshots.find((s) => s.id === shotId);
        if (!byId) {
          throw new Error(`Unknown screenshot:<id> referenced in ${relDoc}: ${target}`);
        }
        usedAssets.add(byId.file);
        continue;
      }
      if (target.includes('..') || target.startsWith('/') || target.startsWith('./') || /^[a-z]+:/i.test(target)) {
        throw new Error(`Image link in ${relDoc} must be screenshot:<id> or package-root assets/... (got: ${target})`);
      }
      if (!ASSET_FILE_PATTERN.test(target) || !SAFE_RELATIVE_PATTERN.test(target)) {
        throw new Error(`Image link in ${relDoc} must be package-root assets/(tr|en)/... (got: ${target})`);
      }
      if (!registeredAssets.has(target)) {
        throw new Error(`Image referenced in ${relDoc} is not registered in manifest.screenshots: ${target}`);
      }
      usedAssets.add(target);
    }

    // Non-image links: [label](target)
    for (const match of content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].trim();
      if (/^https?:\/\//i.test(target) || target.startsWith('#')) continue;
      internalLinkCount += 1;
      let targetSlug = null;
      if (target.startsWith('doc:')) {
        targetSlug = target.slice(4).split('#')[0];
      } else if (target.startsWith('./')) {
        targetSlug = target.slice(2).split('#')[0];
      } else {
        throw new Error(`Internal link in ${relDoc} must use doc:<slug> or ./<slug>, got: ${target}`);
      }
      if (!pageSlugs.has(targetSlug)) {
        throw new Error(`Internal link in ${relDoc} points to unknown slug '${targetSlug}'`);
      }
    }
  }

  for (const assetPath of registeredAssets.keys()) {
    if (!usedAssets.has(assetPath)) {
      throw new Error(`Registered screenshot is not referenced by any doc page: ${assetPath}`);
    }
  }

  return Object.freeze({
    bundleDir: resolvedRoot,
    product: manifest.product,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    verifiedAt: manifest.verifiedAt,
    pagesCount: manifest.pages.length,
    docFilesCount: referencedDocFiles.size,
    screenshotsCount: manifest.screenshots.length,
    internalLinkCount,
    imageRefCount,
  });
}

export function packageVersionedDocsBundle(bundleDir, outputArchivePath) {
  const summary = verifyVersionedDocsBundle(bundleDir);
  const resolvedRoot = summary.bundleDir;
  const parentDir = path.dirname(resolvedRoot);
  const dirName = path.basename(resolvedRoot);
  const outAbs = path.resolve(outputArchivePath);
  mkdirSync(path.dirname(outAbs), { recursive: true });

  execFileSync(
    'tar',
    ['--exclude=.DS_Store', '-czf', outAbs, '-C', parentDir, dirName],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );

  // Verify archive entries: no absolute paths, no '..', no symlinks, all under yunpanel-docs-<version>/
  const entries = execFileSync('tar', ['-tzf', outAbs], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('..') || !entry.startsWith(`${dirName}/`) && entry !== `${dirName}` && entry !== `${dirName}/`) {
      throw new Error(`Unsafe archive entry detected: ${entry}`);
    }
  }
  const archiveSha256 = sha256File(outAbs);
  return Object.freeze({
    ...summary,
    archivePath: outAbs,
    archiveSha256,
    archiveEntries: entries.length,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const bundleIdx = args.indexOf('--bundle');
  const outIdx = args.indexOf('--package');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkgVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const bundleDir = bundleIdx >= 0 ? args[bundleIdx + 1] : path.join(repoRoot, 'docs', `yunpanel-docs-${pkgVersion}`);
  if (outIdx >= 0) {
    const outPath = args[outIdx + 1];
    const result = packageVersionedDocsBundle(bundleDir, outPath);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = verifyVersionedDocsBundle(bundleDir);
    console.log(JSON.stringify(result, null, 2));
  }
}
