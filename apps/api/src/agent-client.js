import { randomUUID } from 'node:crypto';
import { OPERATIONS, createOperationEnvelope } from '@yunpanel/protocol';

const DEFAULT_AGENT_URL = 'http://127.0.0.1:4010';
const DEV_TOKEN = 'development-only-token';

function resolveAgentToken() {
  if (process.env.YUN_AGENT_TOKEN) return process.env.YUN_AGENT_TOKEN;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('YUN_AGENT_TOKEN is required in production');
  }
  return DEV_TOKEN;
}

export async function inspectLocalAgent({ agentUrl = process.env.YUN_AGENT_URL ?? DEFAULT_AGENT_URL } = {}) {
  const envelope = createOperationEnvelope({
    id: randomUUID(),
    operation: OPERATIONS.SERVER_INSPECT,
    payload: {},
  });

  const response = await fetch(`${agentUrl}/v1/operations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resolveAgentToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(3000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message ?? `Agent request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}
