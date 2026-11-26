import { createHash } from 'node:crypto';
import { evaluateAiToolPolicy } from './ai-policy.js';

const VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class AiActionPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiActionPlanError';
    this.code = code;
    this.status = status;
  }
}

export function computeStateFingerprint(state) {
  if (state == null) return null;
  if (typeof state === 'string') return state;
  try {
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  } catch {
    return null;
  }
}

function actionDigest({ tool, input, decision, stateFingerprint = null, epoch = null }) {
  const payload = {
    version: VERSION,
    tool: tool.name,
    risk: tool.risk,
    confirmation: tool.confirmation,
    decision,
    input,
  };
  if (stateFingerprint) {
    payload.stateFingerprint = stateFingerprint;
  }
  if (epoch != null) {
    payload.epoch = epoch;
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function createAiActionPlan({
  registry,
  name,
  input = {},
  auth,
  overrides = {},
  state = null,
  stateFingerprint = null,
  epoch = null,
} = {}) {
  if (!registry || typeof registry.prepare !== 'function') {
    throw new AiActionPlanError('invalid_ai_tool_registry', 'AI tool registry is required');
  }
  const prepared = registry.prepare({ name, input });
  if (!prepared.tool.available) {
    throw new AiActionPlanError('ai_tool_unavailable', `AI tool ${prepared.tool.name} is not available`, 409);
  }
  const policy = evaluateAiToolPolicy({ tool: prepared.tool, auth, overrides });
  if (policy.decision === 'deny') {
    throw new AiActionPlanError('ai_tool_denied', 'AI tool is denied by the current policy', 403);
  }
  const resolvedFingerprint = stateFingerprint ?? computeStateFingerprint(state);
  const previewDigest = actionDigest({
    tool: prepared.tool,
    input: prepared.input,
    decision: policy.decision,
    stateFingerprint: resolvedFingerprint,
    epoch,
  });
  return Object.freeze({
    version: VERSION,
    tool: Object.freeze({
      name: prepared.tool.name,
      risk: prepared.tool.risk,
      confirmation: prepared.tool.confirmation,
    }),
    decision: policy.decision,
    reason: policy.reason,
    previewDigest,
    confirmation: policy.decision === 'confirm' ? `ai:${prepared.tool.name}:${previewDigest}` : null,
    stateFingerprint: resolvedFingerprint ?? null,
    epoch: epoch ?? null,
  });
}

export function verifyAiActionExecution({
  plan,
  previewDigest,
  confirmation = null,
  currentState = null,
  stateFingerprint = null,
  currentStateFingerprint = null,
  currentPlan = null,
  epoch = null,
  currentEpoch = null,
  consumedConfirmations = null,
} = {}) {
  if (!plan || typeof plan !== 'object' || !SHA256_PATTERN.test(plan.previewDigest ?? '')) {
    throw new AiActionPlanError('invalid_ai_action_plan', 'AI action plan is invalid');
  }
  if (plan.decision === 'deny') {
    throw new AiActionPlanError('ai_tool_denied', 'AI action is denied by the current policy', 403);
  }
  if (currentPlan && (currentPlan.previewDigest !== plan.previewDigest || currentPlan.tool?.name !== plan.tool?.name)) {
    throw new AiActionPlanError('ai_action_preview_stale', 'AI action changed after preview; request a new preview', 409);
  }
  if (typeof previewDigest !== 'string' || previewDigest !== plan.previewDigest) {
    throw new AiActionPlanError('ai_action_preview_stale', 'AI action changed after preview; request a new preview', 409);
  }
  const currentFp = currentStateFingerprint ?? computeStateFingerprint(currentState) ?? (typeof stateFingerprint === 'string' ? stateFingerprint : null);
  if ((plan.stateFingerprint || currentFp) && plan.stateFingerprint !== currentFp) {
    throw new AiActionPlanError('ai_action_state_drift', 'Resource state changed after preview; request a new preview', 409);
  }
  const effectiveEpoch = currentEpoch ?? epoch;
  if (plan.epoch != null && effectiveEpoch != null && plan.epoch !== effectiveEpoch) {
    throw new AiActionPlanError('ai_action_restart_invalidated', 'AI action confirmation invalidated by service restart; request a new preview', 409);
  }
  if (consumedConfirmations && confirmation && (
    (typeof consumedConfirmations.has === 'function' && consumedConfirmations.has(confirmation))
    || (Array.isArray(consumedConfirmations) && consumedConfirmations.includes(confirmation))
  )) {
    throw new AiActionPlanError('ai_action_confirmation_already_consumed', 'AI action confirmation has already been executed', 409);
  }
  if (plan.decision === 'confirm' && confirmation !== plan.confirmation) {
    throw new AiActionPlanError('ai_action_confirmation_required', `Confirm AI action with ${plan.confirmation}`);
  }
  return true;
}

export const aiActionPlanInternals = Object.freeze({
  version: VERSION,
  actionDigest,
  computeStateFingerprint,
});
