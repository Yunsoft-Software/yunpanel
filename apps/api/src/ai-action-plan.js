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

function actionDigest({ tool, input, decision }) {
  return createHash('sha256').update(JSON.stringify({
    version: VERSION,
    tool: tool.name,
    risk: tool.risk,
    confirmation: tool.confirmation,
    decision,
    input,
  })).digest('hex');
}

export function createAiActionPlan({ registry, name, input = {}, auth, overrides = {} } = {}) {
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
  const previewDigest = actionDigest({
    tool: prepared.tool,
    input: prepared.input,
    decision: policy.decision,
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
  });
}

export function verifyAiActionExecution({ plan, previewDigest, confirmation = null } = {}) {
  if (!plan || typeof plan !== 'object' || !SHA256_PATTERN.test(plan.previewDigest ?? '')) {
    throw new AiActionPlanError('invalid_ai_action_plan', 'AI action plan is invalid');
  }
  if (typeof previewDigest !== 'string' || previewDigest !== plan.previewDigest) {
    throw new AiActionPlanError('ai_action_preview_stale', 'AI action changed after preview; request a new preview', 409);
  }
  if (plan.decision === 'confirm' && confirmation !== plan.confirmation) {
    throw new AiActionPlanError('ai_action_confirmation_required', `Confirm AI action with ${plan.confirmation}`);
  }
  return true;
}

export const aiActionPlanInternals = Object.freeze({ version: VERSION, actionDigest });
