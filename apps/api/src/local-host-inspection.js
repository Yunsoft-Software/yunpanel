import { randomUUID } from 'node:crypto';
import { inspectHostInventory } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

/**
 * Development-only compatibility envelope around the same host inventory source
 * used by the agentless runtime. No loopback agent HTTP or agent credential is
 * involved.
 */
export async function inspectLocalHost({ inspect = inspectHostInventory } = {}) {
  if (typeof inspect !== 'function') throw new Error('Local host inspection adapter is invalid');

  let result;
  try {
    result = await inspect({ mode: 'local' });
  } catch {
    throw new Error('Local host inspection failed');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Local host inspection returned invalid state');
  }

  return {
    requestId: randomUUID(),
    operation: OPERATIONS.SERVER_INSPECT,
    status: 'succeeded',
    result,
  };
}
