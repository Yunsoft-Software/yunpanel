#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const BUILD_INFO_VERSION = '0.3.0';
export const BUILD_INFO_SCHEMA_VERSION = 3;

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;
const BUILD_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{3,128}$/;

export function normalizeCommitHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'unknown' || !COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeBuildToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown' || !BUILD_TOKEN_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeBuildTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function resolveGitHeadCommit(repoDir = process.cwd()) {
  if (typeof repoDir !== 'string' || !repoDir.trim()) return null;
  try {
    const resolvedDir = path.resolve(repoDir);
    const topLevelRaw = execFileSync(
      'git',
      ['-C', resolvedDir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!topLevelRaw) return null;
    if (realpathSync(topLevelRaw) !== realpathSync(resolvedDir)) {
      return null;
    }
    const output = execFileSync(
      'git',
      ['-C', resolvedDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return normalizeCommitHash(output);
  } catch {
    return null;
  }
}

export function validateBuildInfoManifest(rawManifest) {
  let parsed = rawManifest;
  if (typeof rawManifest === 'string') {
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.buildVerified === false) {
    return null;
  }

  const commit = normalizeCommitHash(parsed.commit);
  const buildId = normalizeBuildToken(parsed.buildId);
  const assetId = normalizeBuildToken(parsed.assetId);
  const buildTime = normalizeBuildTime(parsed.buildTime);

  if (!commit || !buildId || !assetId || !buildTime) {
    return null;
  }

  const normalized = {
    version: typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : BUILD_INFO_VERSION,
    schemaVersion: Number.isInteger(Number(parsed.schemaVersion)) && Number(parsed.schemaVersion) > 0
      ? Number(parsed.schemaVersion)
      : BUILD_INFO_SCHEMA_VERSION,
    buildId,
    assetId,
    commit,
    buildTime,
    buildVerified: true,
  };

  if (typeof parsed.packageVersion === 'string' && parsed.packageVersion.trim()) {
    normalized.packageVersion = parsed.packageVersion.trim();
  }

  return Object.freeze(normalized);
}

export function createBuildInfo({
  repoDir = process.cwd(),
  env = process.env,
  now = new Date(),
  packageVersion = null,
  verifyWebDistPath = null,
  strict = true,
} = {}) {
  const rawEnvCommit = env.YUNPANEL_COMMIT_HASH ?? env.GIT_COMMIT;
  let envCommit = null;
  if (rawEnvCommit !== undefined && String(rawEnvCommit).trim() !== '') {
    envCommit = normalizeCommitHash(String(rawEnvCommit));
    if (!envCommit && strict) {
      throw new Error('Invalid commit hash in YUNPANEL_COMMIT_HASH or GIT_COMMIT');
    }
  }

  const gitHead = repoDir ? resolveGitHeadCommit(repoDir) : null;
  if (gitHead && envCommit && gitHead !== envCommit) {
    throw new Error(`Environment commit (${envCommit}) does not match git HEAD (${gitHead})`);
  }

  const commit = gitHead ?? envCommit;
  if (!commit) {
    if (strict) {
      throw new Error(`Unable to resolve valid git HEAD commit for repository: ${repoDir}`);
    }
    return Object.freeze({
      version: BUILD_INFO_VERSION,
      schemaVersion: BUILD_INFO_SCHEMA_VERSION,
      buildId: 'unknown',
      assetId: 'unknown',
      commit: 'unknown',
      buildTime: null,
      buildVerified: false,
    });
  }

  let verifiedWebManifest = null;
  if (verifyWebDistPath) {
    let rawWebDist;
    try {
      rawWebDist = readFileSync(verifyWebDistPath, 'utf8');
    } catch (error) {
      throw new Error(`Required web build-info file is missing or unreadable: ${verifyWebDistPath} (${error.message})`);
    }
    verifiedWebManifest = validateBuildInfoManifest(rawWebDist);
    if (!verifiedWebManifest) {
      throw new Error(`Web build-info file is invalid or unverified: ${verifyWebDistPath}`);
    }
    if (verifiedWebManifest.commit !== commit) {
      throw new Error(
        `Web dist build-info commit (${verifiedWebManifest.commit}) does not match repository HEAD (${commit})`,
      );
    }
  }

  const rawEnvBuildTime = env.YUNPANEL_BUILD_TIME ?? env.BUILD_TIMESTAMP;
  let explicitBuildTime = null;
  if (rawEnvBuildTime !== undefined && String(rawEnvBuildTime).trim() !== '') {
    explicitBuildTime = normalizeBuildTime(String(rawEnvBuildTime));
    if (!explicitBuildTime && strict) {
      throw new Error('Invalid ISO timestamp in YUNPANEL_BUILD_TIME or BUILD_TIMESTAMP');
    }
  }
  const fallbackNow = now instanceof Date ? now : new Date(now);
  const buildTime = explicitBuildTime ?? verifiedWebManifest?.buildTime ?? fallbackNow.toISOString();

  const compactTimestamp = buildTime.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortCommit = commit.slice(0, 12);

  let explicitBuildId = null;
  if (env.YUNPANEL_BUILD_ID !== undefined && String(env.YUNPANEL_BUILD_ID).trim() !== '') {
    explicitBuildId = normalizeBuildToken(String(env.YUNPANEL_BUILD_ID));
    if (!explicitBuildId && strict) {
      throw new Error('Invalid build identifier in YUNPANEL_BUILD_ID');
    }
  }
  const buildId = explicitBuildId ?? verifiedWebManifest?.buildId ?? `build-${compactTimestamp}-${shortCommit}`;

  let explicitAssetId = null;
  if (env.YUNPANEL_ASSET_ID !== undefined && String(env.YUNPANEL_ASSET_ID).trim() !== '') {
    explicitAssetId = normalizeBuildToken(String(env.YUNPANEL_ASSET_ID));
    if (!explicitAssetId && strict) {
      throw new Error('Invalid asset identifier in YUNPANEL_ASSET_ID');
    }
  }
  const assetId = explicitAssetId ?? verifiedWebManifest?.assetId ?? `assets-${buildId}`;

  const manifest = {
    version: BUILD_INFO_VERSION,
    schemaVersion: BUILD_INFO_SCHEMA_VERSION,
    buildId,
    assetId,
    commit,
    buildTime,
    buildVerified: true,
  };

  if (packageVersion !== null && packageVersion !== undefined && String(packageVersion).trim() !== '') {
    manifest.packageVersion = String(packageVersion).trim();
  }

  return Object.freeze(manifest);
}

export function writeBuildInfoFile(outputPath, buildInfo) {
  const resolvedOutput = path.resolve(outputPath);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(buildInfo, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  chmodSync(resolvedOutput, 0o644);
  return resolvedOutput;
}

function parseCliArgs(argv) {
  const parsed = {
    repoDir: process.cwd(),
    outputPath: null,
    packageVersion: null,
    verifyWebDistPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--output') {
      if (!next || next.startsWith('--')) throw new Error('--output requires a file path');
      parsed.outputPath = next;
      i += 1;
    } else if (arg === '--repo') {
      if (!next || next.startsWith('--')) throw new Error('--repo requires a directory path');
      parsed.repoDir = next;
      i += 1;
    } else if (arg === '--package-version') {
      if (!next || next.startsWith('--')) throw new Error('--package-version requires a version value');
      parsed.packageVersion = next;
      i += 1;
    } else if (arg === '--verify-web-dist') {
      if (!next || next.startsWith('--')) throw new Error('--verify-web-dist requires a build-info.json path');
      parsed.verifyWebDistPath = next;
      i += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  if (!parsed.outputPath) {
    throw new Error('Usage: emit-build-info.mjs --output <path> [--repo <dir>] [--package-version <ver>] [--verify-web-dist <dist-build-info.json>]');
  }

  return parsed;
}

function isDirectCliExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectCliExecution()) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const buildInfo = createBuildInfo({
      repoDir: cli.repoDir,
      packageVersion: cli.packageVersion,
      verifyWebDistPath: cli.verifyWebDistPath,
      env: process.env,
      strict: true,
    });
    writeBuildInfoFile(cli.outputPath, buildInfo);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exit(1);
  }
}
