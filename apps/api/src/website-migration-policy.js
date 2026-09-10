import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MODES = new Set(['compatibility', 'enforced']);

export class WebsiteMigrationPolicyError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteMigrationPolicyError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, mode: 'compatibility', enforcedDigest: null, transitionedAt: null };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Website migration policy state');
  const allowed = new Set(['version', 'mode', 'enforcedDigest', 'transitionedAt']);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== STORE_VERSION || !MODES.has(value.mode)) {
    throw new Error('invalid Website migration policy state');
  }
  if (value.mode === 'compatibility') {
    if (value.enforcedDigest !== null) throw new Error('invalid Website migration policy state');
  } else if (typeof value.enforcedDigest !== 'string' || !DIGEST_PATTERN.test(value.enforcedDigest)) {
    throw new Error('invalid Website migration policy state');
  }
  if (value.transitionedAt !== null && (typeof value.transitionedAt !== 'string' || !Number.isFinite(Date.parse(value.transitionedAt)))) {
    throw new Error('invalid Website migration policy state');
  }
  return { version: STORE_VERSION, mode: value.mode, enforcedDigest: value.enforcedDigest, transitionedAt: value.transitionedAt };
}

function validateFinalPreview(preview, expectedDigest) {
  if (typeof expectedDigest !== 'string' || !DIGEST_PATTERN.test(expectedDigest)) {
    throw new WebsiteMigrationPolicyError('website_migration_preview_digest_invalid', 'A current migration preview digest is required', 400);
  }
  if (!preview || preview.version !== 1 || preview.digest !== expectedDigest || preview.destructive !== false || preview.autoApply !== false
    || !preview.counts || !Array.isArray(preview.items)) {
    throw new WebsiteMigrationPolicyError('website_migration_preview_stale', 'Migration preview does not match current state');
  }
  if (preview.counts.total !== preview.items.length
    || preview.counts.alreadyBound !== preview.items.length
    || preview.counts.ready !== 0 || preview.counts.ambiguous !== 0 || preview.counts.unresolved !== 0
    || preview.items.some((item) => item.status !== 'already_bound' || item.action !== 'none' || item.requiresConfirmation !== false)) {
    throw new WebsiteMigrationPolicyError('website_migration_not_complete', 'All managed domains must have explicit Website bindings before enforcement');
  }
  return expectedDigest;
}

export function createWebsiteMigrationPolicyStore({ filePath = null, now = () => Date.now() } = {}) {
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();
  if (typeof now !== 'function') throw new WebsiteMigrationPolicyError('website_migration_policy_dependencies_invalid', 'Website migration policy dependencies are invalid', 503);

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const snapshot = JSON.stringify(state, null, 2);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try { state = validateState(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function snapshot() {
    if (!initialized) throw new WebsiteMigrationPolicyError('website_migration_policy_uninitialized', 'Website migration policy is not initialized', 503);
    return Object.freeze({ ...state, websiteBindingRequired: state.mode === 'enforced' });
  }

  async function finalize({ preview, previewDigest } = {}) {
    await ensureInitialized();
    const digest = validateFinalPreview(preview, previewDigest);
    if (state.mode === 'enforced') {
      if (state.enforcedDigest !== digest) throw new WebsiteMigrationPolicyError('website_migration_policy_conflict', 'Website binding enforcement was finalized from a different migration state');
      return snapshot();
    }
    state = {
      version: STORE_VERSION,
      mode: 'enforced',
      enforcedDigest: digest,
      transitionedAt: new Date(now()).toISOString(),
    };
    await persist();
    return snapshot();
  }

  async function rollback({ enforcedDigest } = {}) {
    await ensureInitialized();
    if (state.mode === 'compatibility') return snapshot();
    if (typeof enforcedDigest !== 'string' || !DIGEST_PATTERN.test(enforcedDigest) || enforcedDigest !== state.enforcedDigest) {
      throw new WebsiteMigrationPolicyError('website_migration_rollback_digest_mismatch', 'Rollback must name the exact enforced migration digest');
    }
    state = {
      version: STORE_VERSION,
      mode: 'compatibility',
      enforcedDigest: null,
      transitionedAt: new Date(now()).toISOString(),
    };
    await persist();
    return snapshot();
  }

  return Object.freeze({ init, snapshot, finalize, rollback });
}

export const websiteMigrationPolicyInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  digestPattern: DIGEST_PATTERN,
  validateState,
  validateFinalPreview,
});
