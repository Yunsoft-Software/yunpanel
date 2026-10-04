#!/usr/bin/env node
import { DEFAULT_AI_TOOL_DEFINITIONS } from './ai-tool-catalog.js';
import { createAiToolRegistry } from './ai-tool-registry.js';
import { createAiMcpAdapter } from './ai-mcp-adapter.js';

export function startAiMcpServer({
  registry = null,
  audit = null,
  policyOverrides = {},
  policyStore = null,
  auth = null,
  inputStream = process.stdin,
  outputStream = process.stdout,
} = {}) {
  const targetRegistry = registry ?? createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
  const adapter = createAiMcpAdapter({
    registry: targetRegistry,
    audit,
    policyOverrides,
    policyStore,
  });

  const defaultAuth = auth ?? Object.freeze({
    user: Object.freeze({ id: process.env.YUNPANEL_AI_ACTOR_ID || 'owner-mcp', role: 'owner' }),
    access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
    security: Object.freeze({ managementAllowed: true }),
  });

  const stdio = adapter.createStdioHandler({
    auth: defaultAuth,
    inputStream,
    outputStream,
  });

  return Object.freeze({
    adapter,
    close: () => stdio.close(),
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  startAiMcpServer();
}
