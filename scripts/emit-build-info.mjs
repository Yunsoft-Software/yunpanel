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
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !VERSION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

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

export function resolveGitRepositoryState(repoDir = process.cwd()) {
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
    const headOutput = execFileSync(
      'git',
      ['-C', resolvedDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const commit = normalizeCommitHash(headOutput);
    if (!commit) return null;

    const statusOutput = execFileSync(
      'git',
      ['-C', resolvedDir, 'status', '--porcelain', '--untracked-files=normal'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const dirty = statusOutput.trim().length > 0;
    return { commit, dirty };
  } catch {
    return null;
  }
}

export function resolveGitHeadCommit(repoDir = process.cwd()) {
  return resolveGitRepositoryState(repoDir)?.commit ?? null;
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
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.dirty === true
    || parsed.buildVerified !== true
  ) {
    return null;
  }

  const version = parsed.version !== undefined
    ? normalizeVersion(parsed.version)
    : BUILD_INFO_VERSION;
  const commit = normalizeCommitHash(parsed.commit);
  const buildId = normalizeBuildToken(parsed.buildId);
  const assetId = normalizeBuildToken(parsed.assetId);
  const buildTime = normalizeBuildTime(parsed.buildTime);

  if (!version || !commit || !buildId || !assetId || !buildTime) {
    return null;
  }

  const normalized = {
    version,
    schemaVersion: Number.isInteger(Number(parsed.schemaVersion)) && Number(parsed.schemaVersion) > 0
      ? Number(parsed.schemaVersion)
      : BUILD_INFO_SCHEMA_VERSION,
    buildId,
    assetId,
    commit,
    buildTime,
    dirty: false,
    buildVerified: true,
  };

  if (typeof parsed.packageVersion === 'string' && parsed.packageVersion.trim()) {
    normalized.packageVersion = parsed.packageVersion.trim();
  }

  return Object.freeze(normalized);
}

function hasExplicitEnvValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function createBuildInfo({
  repoDir = process.cwd(),
  env = process.env,
  now = new Date(),
  packageVersion = null,
  verifyWebDistPath = null,
  requireClean = false,
  strict = true,
} = {}) {
  const enforceClean = Boolean(requireClean || verifyWebDistPath);
  const mustValidateInputs = Boolean(strict || enforceClean);

  let explicitVersion = null;
  if (hasExplicitEnvValue(env.YUNPANEL_VERSION)) {
    explicitVersion = normalizeVersion(String(env.YUNPANEL_VERSION));
    if (!explicitVersion && mustValidateInputs) {
      throw new Error('Invalid version in YUNPANEL_VERSION');
    }
  }

  const rawEnvCommit = env.YUNPANEL_COMMIT_HASH ?? env.YUNPANEL_BUILD_COMMIT ?? env.GIT_COMMIT;
  let envCommit = null;
  if (hasExplicitEnvValue(rawEnvCommit)) {
    envCommit = normalizeCommitHash(String(rawEnvCommit));
    if (!envCommit && mustValidateInputs) {
      throw new Error('Invalid commit hash in YUNPANEL_COMMIT_HASH, YUNPANEL_BUILD_COMMIT, or GIT_COMMIT');
    }
  }

  const rawEnvBuildTime = env.YUNPANEL_BUILD_TIME ?? env.BUILD_TIMESTAMP;
  let explicitBuildTime = null;
  if (hasExplicitEnvValue(rawEnvBuildTime)) {
    explicitBuildTime = normalizeBuildTime(String(rawEnvBuildTime));
    if (!explicitBuildTime && mustValidateInputs) {
      throw new Error('Invalid ISO timestamp in YUNPANEL_BUILD_TIME or BUILD_TIMESTAMP');
    }
  }

  let explicitBuildId = null;
  if (hasExplicitEnvValue(env.YUNPANEL_BUILD_ID)) {
    explicitBuildId = normalizeBuildToken(String(env.YUNPANEL_BUILD_ID));
    if (!explicitBuildId && mustValidateInputs) {
      throw new Error('Invalid build identifier in YUNPANEL_BUILD_ID');
    }
  }

  let explicitAssetId = null;
  if (hasExplicitEnvValue(env.YUNPANEL_ASSET_ID)) {
    explicitAssetId = normalizeBuildToken(String(env.YUNPANEL_ASSET_ID));
    if (!explicitAssetId && mustValidateInputs) {
      throw new Error('Invalid asset identifier in YUNPANEL_ASSET_ID');
    }
  }

  const gitState = repoDir ? resolveGitRepositoryState(repoDir) : null;
  if (enforceClean && !gitState) {
    throw new Error(`Clean git repository verification failed: ${repoDir} is not a clean git repository root with a HEAD commit`);
  }
  if (gitState && envCommit && gitState.commit !== envCommit) {
    throw new Error(`Environment commit (${envCommit}) does not match git HEAD (${gitState.commit})`);
  }

  const commit = gitState?.commit ?? envCommit;
  if (!commit) {
    if (mustValidateInputs) {
      throw new Error(`Unable to resolve valid git HEAD commit for repository: ${repoDir}`);
    }
    return Object.freeze({
      version: explicitVersion ?? BUILD_INFO_VERSION,
      schemaVersion: BUILD_INFO_SCHEMA_VERSION,
      buildId: 'unknown',
      assetId: 'unknown',
      commit: 'unknown',
      buildTime: null,
      dirty: false,
      buildVerified: false,
    });
  }

  const envDirty = env.YUNPANEL_DIRTY_TREE === 'true' || env.YUNPANEL_DIRTY_TREE === '1';
  const dirty = Boolean(gitState?.dirty || envDirty);

  if (enforceClean && dirty) {
    throw new Error('Refusing to emit verified release build-info from a dirty git working tree');
  }

  if (verifyWebDistPath) {
    let rawWebDist;
    try {
      rawWebDist = readFileSync(verifyWebDistPath, 'utf8');
    } catch (error) {
      throw new Error(`Required web build-info file is missing or unreadable: ${verifyWebDistPath} (${error.message})`);
    }
    let parsedWebDist;
    try {
      parsedWebDist = JSON.parse(rawWebDist);
    } catch {
      throw new Error(`Web build-info file is not valid JSON: ${verifyWebDistPath}`);
    }
    if (!parsedWebDist || typeof parsedWebDist !== 'object' || Array.isArray(parsedWebDist)) {
      throw new Error(`Web build-info file must contain a JSON object: ${verifyWebDistPath}`);
    }
    if (parsedWebDist.dirty === true || parsedWebDist.buildVerified !== true) {
      throw new Error(`Web build-info file is dirty or unverified and cannot be packaged: ${verifyWebDistPath}`);
    }

    const verifiedWebManifest = validateBuildInfoManifest(parsedWebDist);
    if (!verifiedWebManifest) {
      throw new Error(`Web build-info file has invalid build identity fields: ${verifyWebDistPath}`);
    }
    if (verifiedWebManifest.commit !== commit) {
      throw new Error(
        `Web dist build-info commit (${verifiedWebManifest.commit}) does not match repository HEAD (${commit})`,
      );
    }
    if (explicitVersion && explicitVersion !== verifiedWebManifest.version) {
      throw new Error(
        `Explicit YUNPANEL_VERSION (${explicitVersion}) does not match web dist version (${verifiedWebManifest.version})`,
      );
    }
    if (envCommit && envCommit !== verifiedWebManifest.commit) {
      throw new Error(
        `Explicit environment commit (${envCommit}) does not match web dist commit (${verifiedWebManifest.commit})`,
      );
    }
    if (explicitBuildId && explicitBuildId !== verifiedWebManifest.buildId) {
      throw new Error(
        `Explicit YUNPANEL_BUILD_ID (${explicitBuildId}) does not match web dist buildId (${verifiedWebManifest.buildId})`,
      );
    }
    if (explicitAssetId && explicitAssetId !== verifiedWebManifest.assetId) {
      throw new Error(
        `Explicit YUNPANEL_ASSET_ID (${explicitAssetId}) does not match web dist assetId (${verifiedWebManifest.assetId})`,
      );
    }
    if (explicitBuildTime && explicitBuildTime !== verifiedWebManifest.buildTime) {
      throw new Error(
        `Explicit build timestamp (${explicitBuildTime}) does not match web dist buildTime (${verifiedWebManifest.buildTime})`,
      );
    }

    const pkgManifest = {
      version: verifiedWebManifest.version,
      schemaVersion: verifiedWebManifest.schemaVersion,
      buildId: verifiedWebManifest.buildId,
      assetId: verifiedWebManifest.assetId,
      commit: verifiedWebManifest.commit,
      buildTime: verifiedWebManifest.buildTime,
      dirty: false,
      buildVerified: true,
    };

    if (packageVersion !== null && packageVersion !== undefined && String(packageVersion).trim() !== '') {
      const normalizedPkgVer = String(packageVersion).trim();
      const upstreamPkgVer = normalizedPkgVer.split('-')[0];
      if (upstreamPkgVer && upstreamPkgVer !== verifiedWebManifest.version) {
        throw new Error(
          `Package upstream version (${upstreamPkgVer}) does not match web dist version (${verifiedWebManifest.version})`,
        );
      }
      pkgManifest.packageVersion = normalizedPkgVer;
    }

    return Object.freeze(pkgManifest);
  }

  const fallbackNow = now instanceof Date ? now : new Date(now);
  const buildTime = explicitBuildTime ?? fallbackNow.toISOString();
  const compactTimestamp = buildTime.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const shortCommit = commit.slice(0, 12);
  const buildId = explicitBuildId ?? `build-${compactTimestamp}-${shortCommit}`;
  const assetId = explicitAssetId ?? `assets-${buildId}`;
  const buildVerified = Boolean(gitState && !dirty);

  const manifest = {
    version: explicitVersion ?? BUILD_INFO_VERSION,
    schemaVersion: BUILD_INFO_SCHEMA_VERSION,
    buildId,
    assetId,
    commit,
    buildTime,
    dirty,
    buildVerified,
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
    requireClean: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--require-clean') {
      parsed.requireClean = true;
    } else if (arg === '--output') {
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
    throw new Error(
      'Usage: emit-build-info.mjs --output <path> [--repo <dir>] [--package-version <ver>] [--require-clean] [--verify-web-dist <dist-build-info.json>]',
    );
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
      requireClean: cli.requireClean,
      env: process.env,
      strict: true,
    });
    writeBuildInfoFile(cli.outputPath, buildInfo);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exit(1);
  }
}
