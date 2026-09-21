import { createAiActionPlan } from './ai-action-plan.js';
import { evaluateAiToolPolicy } from './ai-policy.js';

const MAX_PROPOSALS = 8;

export class AiOrchestratorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiOrchestratorError';
    this.code = code;
    this.status = status;
  }
}

function providerTool(tool) {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
  });
}

function validateDependencies(provider, registry, policyOverrides) {
  if (!provider || typeof provider.complete !== 'function' || typeof provider.id !== 'string') {
    throw new AiOrchestratorError('invalid_ai_provider', 'AI orchestrator requires a provider', 500);
  }
  if (!registry || typeof registry.list !== 'function' || typeof registry.prepare !== 'function') {
    throw new AiOrchestratorError('invalid_ai_tool_registry', 'AI orchestrator requires a tool registry', 500);
  }
  if (!policyOverrides || typeof policyOverrides !== 'object' || Array.isArray(policyOverrides)) {
    throw new AiOrchestratorError('invalid_ai_policy_overrides', 'AI policy overrides are invalid', 500);
  }
}

export function createAiOrchestrator({ provider, registry, policyOverrides = {} } = {}) {
  validateDependencies(provider, registry, policyOverrides);

  function availableTools(auth) {
    return Object.freeze(registry.list()
      .filter((tool) => tool.available)
      .map((tool) => Object.freeze({
        tool,
        policy: evaluateAiToolPolicy({ tool, auth, overrides: policyOverrides }),
      }))
      .filter(({ policy }) => policy.decision !== 'deny'));
  }

  async function proposeTurn({ model, messages, auth, signal = null } = {}) {
    const allowed = availableTools(auth);
    const byName = new Map(allowed.map((entry) => [entry.tool.name, entry]));
    const result = await provider.complete({
      model,
      messages,
      tools: allowed.map(({ tool }) => providerTool(tool)),
      signal,
    });
    if (result.type === 'message') {
      return Object.freeze({
        type: 'message',
        provider: provider.id,
        message: Object.freeze({ role: 'assistant', text: result.text }),
      });
    }

    if (result.calls.length > MAX_PROPOSALS) {
      throw new AiOrchestratorError('too_many_ai_tool_proposals', 'AI provider proposed too many tool calls', 502);
    }
    const proposals = result.calls.map((call) => {
      const allowedTool = byName.get(call.name);
      if (!allowedTool) {
        throw new AiOrchestratorError('ai_provider_requested_disallowed_tool', 'AI provider requested a tool outside the allowed capability set', 502);
      }
      const prepared = registry.prepare({ name: call.name, input: call.input });
      const plan = createAiActionPlan({
        registry,
        name: call.name,
        input: prepared.input,
        auth,
        overrides: policyOverrides,
      });
      return Object.freeze({
        callId: call.id,
        name: call.name,
        input: prepared.input,
        plan,
        autoExecutable: plan.decision === 'allow',
      });
    });
    return Object.freeze({
      type: 'tool_proposals',
      provider: provider.id,
      proposals: Object.freeze(proposals),
    });
  }

  return Object.freeze({ availableTools, proposeTurn });
}

export const aiOrchestratorInternals = Object.freeze({ providerTool, maxProposals: MAX_PROPOSALS });
