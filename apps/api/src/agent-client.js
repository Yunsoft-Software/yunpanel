import { randomUUID } from 'node:crypto';
import { inspectHostInventory } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';

/**
 * Compatibility adapter for the retained development inspect route. The API no
 * longer calls the loopback yun-agent HTTP server or reads an agent token just
 * to inspect its own host; the privileged local runtime implementation is the
 * single source of host inventory now.
 */
export async function inspectLocalAgent({ inspect = inspectHostInventory } = {}) {
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
