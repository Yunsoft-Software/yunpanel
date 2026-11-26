import { AI_TOOL_CONFIRMATION, AI_TOOL_RISKS } from './ai-tool-catalog.js';

const DECISIONS = new Set(['allow', 'confirm', 'deny']);
const OVERRIDE_KEYS = new Set(['tool', 'risk']);
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export class AiPolicyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiPolicyError';
    this.code = code;
    this.status = status;
  }
}

function managementOwner(auth) {
  return auth?.user?.role === 'owner'
    && auth?.access?.mode === 'management'
    && auth?.security?.managementAllowed === true
    && Array.isArray(auth?.access?.permissions)
    && auth.access.permissions.includes('*');
}

function readOnlyActor(auth) {
  return auth?.user?.role === 'read_only'
    && auth?.access?.mode === 'read_only'
    && Array.isArray(auth?.access?.permissions);
}

function normalizeOverrides(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !OVERRIDE_KEYS.has(key))) {
    throw new AiPolicyError('invalid_ai_policy_overrides', 'AI policy overrides are invalid');
  }
  const tool = value.tool ?? {};
  const risk = value.risk ?? {};
  const normalizedTool = Object.create(null);
  const normalizedRisk = Object.create(null);
  for (const [kind, entries, target] of [['tool', tool, normalizedTool], ['risk', risk, normalizedRisk]]) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new AiPolicyError('invalid_ai_policy_overrides', `AI ${kind} policy overrides are invalid`);
    }
    for (const [k, decision] of Object.entries(entries)) {
      if (!DECISIONS.has(decision)) throw new AiPolicyError('invalid_ai_policy_decision', 'AI policy decision is invalid');
      target[k] = decision;
    }
  }
  return { tool: normalizedTool, risk: normalizedRisk };
}

function policyOverride(tool, overrides) {
  return overrides.tool[tool.name] ?? overrides.risk[tool.risk] ?? null;
}

export function evaluateAiToolPolicy({ tool, auth, overrides = {} } = {}) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string'
    || !NAME_PATTERN.test(tool.name)
    || !Object.values(AI_TOOL_RISKS).includes(tool.risk)
    || !Object.values(AI_TOOL_CONFIRMATION).includes(tool.confirmation)
    || !DECISIONS.has(tool.defaultPolicy)) {
    throw new AiPolicyError('invalid_ai_tool_policy_metadata', 'AI tool policy metadata is invalid');
  }

  if (!managementOwner(auth)) {
    if (readOnlyActor(auth) && tool.risk === AI_TOOL_RISKS.READ) {
      return Object.freeze({ decision: 'allow', reason: 'read_only_safe' });
    }
    return Object.freeze({ decision: 'deny', reason: 'owner_management_required' });
  }

  const normalized = normalizeOverrides(overrides);
  const override = policyOverride(tool, normalized);
  if (override === 'deny') return Object.freeze({ decision: 'deny', reason: 'explicit_deny' });

  if (tool.confirmation === AI_TOOL_CONFIRMATION.ALWAYS) {
    return Object.freeze({ decision: 'confirm', reason: 'always_confirm' });
  }
  if (tool.confirmation === AI_TOOL_CONFIRMATION.NEVER) {
    return Object.freeze({ decision: 'allow', reason: 'read_safe' });
  }

  const decision = override ?? tool.defaultPolicy;
  if (tool.risk === AI_TOOL_RISKS.DESTRUCTIVE && decision === 'allow') {
    return Object.freeze({ decision: 'confirm', reason: 'destructive_safety_enforced' });
  }

  return Object.freeze({
    decision,
    reason: override ? 'configured_override' : 'tool_default',
  });
}

export const aiPolicyInternals = Object.freeze({
  normalizeOverrides,
  managementOwner,
  readOnlyActor,
});
