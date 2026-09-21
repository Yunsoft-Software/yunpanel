import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AI_TOOL_CONFIRMATION,
  AI_TOOL_RISKS,
  DEFAULT_AI_TOOL_DEFINITIONS,
} from './ai-tool-catalog.js';

const DEFAULT_STORE_PATH = '/var/lib/yunpanel/control-plane/ai-policy.json';
const STORE_VERSION = 1;
const DECISIONS = new Set(['allow', 'confirm', 'deny']);
const RISKS = new Set(Object.values(AI_TOOL_RISKS));
const TOOLS = new Map(DEFAULT_AI_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export class AiPolicyStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiPolicyStoreError';
    this.code = code;
    this.status = status;
  }
}

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decision(value, kind, key, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (!DECISIONS.has(value)) {
    throw new AiPolicyStoreError('invalid_ai_policy_decision', `AI ${kind} policy decision for ${key} is invalid`);
  }
  if (kind === 'risk' && key === AI_TOOL_RISKS.DESTRUCTIVE && value === 'allow') {
    throw new AiPolicyStoreError('unsafe_ai_policy_override', 'Destructive AI tools cannot be globally auto-allowed');
  }
  if (kind === 'tool') {
    const tool = TOOLS.get(key);
    if (tool?.confirmation === AI_TOOL_CONFIRMATION.ALWAYS && value === 'allow') {
      throw new AiPolicyStoreError('unsafe_ai_policy_override', `AI tool ${key} always requires confirmation`);
    }
  }
  return value;
}

function normalizeOverrideMap(input, kind, { allowNull = false } = {}) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AiPolicyStoreError('invalid_ai_policy_overrides', `AI ${kind} policy overrides must be an object`);
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (kind === 'tool' && !TOOLS.has(key)) {
      throw new AiPolicyStoreError('unknown_ai_policy_tool', `AI tool ${key} is not registered`);
    }
    if (kind === 'risk' && !RISKS.has(key)) {
      throw new AiPolicyStoreError('unknown_ai_policy_risk', `AI risk ${key} is not registered`);
    }
    result[key] = decision(value, kind, key, { allowNull });
  }
  return result;
}

function normalizeOverrides(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['tool', 'risk'].includes(key))) {
    throw new AiPolicyStoreError('invalid_ai_policy_overrides', 'AI policy overrides are invalid');
  }
  return Object.freeze({
    tool: Object.freeze(normalizeOverrideMap(input.tool, 'tool')),
    risk: Object.freeze(normalizeOverrideMap(input.risk, 'risk')),
  });
}

function normalizePatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['tool', 'risk'].includes(key))) {
    throw new AiPolicyStoreError('invalid_ai_policy_patch', 'AI policy patch is invalid');
  }
  return Object.freeze({
    tool: Object.freeze(normalizeOverrideMap(input.tool, 'tool', { allowNull: true })),
    risk: Object.freeze(normalizeOverrideMap(input.risk, 'risk', { allowNull: true })),
  });
}

function applyMap(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function stateDigest({ revision, overrides }) {
  return digest({ version: STORE_VERSION, revision, overrides });
}

function publicSnapshot(state) {
  const overrides = normalizeOverrides(state.overrides);
  return Object.freeze({
    version: STORE_VERSION,
    revision: state.revision,
    digest: stateDigest({ revision: state.revision, overrides }),
    overrides,
    updatedAt: state.updatedAt,
  });
}

function normalizePersisted(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== STORE_VERSION
    || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1
    || typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt))) {
    throw new AiPolicyStoreError('invalid_ai_policy_store', 'AI policy store is invalid', 500);
  }
  return Object.freeze({
    version: STORE_VERSION,
    revision: parsed.revision,
    overrides: normalizeOverrides(parsed.overrides),
    updatedAt: new Date(parsed.updatedAt).toISOString(),
  });
}

export function createAiPolicyStore({ filePath = DEFAULT_STORE_PATH, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== 'string' || filePath.length < 1 || typeof now !== 'function') {
    throw new AiPolicyStoreError('invalid_ai_policy_store_dependencies', 'AI policy store dependencies are invalid', 500);
  }
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      cache = normalizePersisted(JSON.parse(await readFile(filePath, 'utf8')));
      return cache;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof AiPolicyStoreError) throw error;
        throw new AiPolicyStoreError('ai_policy_store_read_failed', 'Failed to read AI policy store', 500);
      }
    }
    cache = Object.freeze({
      version: STORE_VERSION,
      revision: 1,
      overrides: normalizeOverrides({}),
      updatedAt: new Date(now()).toISOString(),
    });
    return cache;
  }

  async function persist(state) {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tempPath, filePath);
    cache = state;
  }

  async function init() {
    return publicSnapshot(await load());
  }

  async function getSnapshot() {
    return publicSnapshot(await load());
  }

  async function previewUpdate({ expectedRevision, tool = {}, risk = {} } = {}) {
    const current = await load();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new AiPolicyStoreError('ai_policy_revision_conflict', 'AI policy changed; request a new snapshot', 409);
    }
    const patch = normalizePatch({ tool, risk });
    const nextOverrides = normalizeOverrides({
      tool: applyMap(current.overrides.tool, patch.tool),
      risk: applyMap(current.overrides.risk, patch.risk),
    });
    const nextRevision = current.revision + 1;
    const previewDigest = digest({
      version: STORE_VERSION,
      currentRevision: current.revision,
      currentDigest: stateDigest(current),
      nextRevision,
      nextOverrides,
    });
    return Object.freeze({
      version: STORE_VERSION,
      currentRevision: current.revision,
      nextRevision,
      nextOverrides,
      previewDigest,
      confirmation: `update-ai-policy:${nextRevision}:${previewDigest}`,
    });
  }

  async function applyUpdate({
    expectedRevision,
    tool = {},
    risk = {},
    previewDigest,
    confirmation,
  } = {}) {
    const preview = await previewUpdate({ expectedRevision, tool, risk });
    if (typeof previewDigest !== 'string' || previewDigest !== preview.previewDigest) {
      throw new AiPolicyStoreError('ai_policy_preview_stale', 'AI policy changed after preview; request a new preview', 409);
    }
    if (typeof confirmation !== 'string' || confirmation !== preview.confirmation) {
      throw new AiPolicyStoreError('ai_policy_confirmation_required', `Confirm AI policy update with ${preview.confirmation}`);
    }
    const next = Object.freeze({
      version: STORE_VERSION,
      revision: preview.nextRevision,
      overrides: preview.nextOverrides,
      updatedAt: new Date(now()).toISOString(),
    });
    await persist(next);
    return publicSnapshot(next);
  }

  function clearCache() {
    cache = null;
  }

  return Object.freeze({ init, getSnapshot, previewUpdate, applyUpdate, clearCache });
}

export const aiPolicyStoreInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  normalizeOverrides,
  normalizePatch,
  normalizePersisted,
  stateDigest,
});
