import { useCallback, useEffect, useReducer, useState } from 'react';
import { panelRequest } from '../api.js';
import { collectionReducer, initialCollection } from './resource-model.js';

/** One in-flight request per resource; no out-of-order refresh or form remount. */
export function useCollection(path, { pollMs = 15000, enabled = true } = {}) {
  const [state, dispatch] = useReducer(collectionReducer, undefined, initialCollection);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const items = await panelRequest(path, { signal: controller.signal });
        if (!controller.signal.aborted) dispatch({ type: 'success', items });
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: 'failure', error });
      } finally {
        if (!controller.signal.aborted && pollMs > 0) timer = setTimeout(read, pollMs);
      }
    }
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, pollMs, enabled, revision]);
  return { ...state, refresh };
}
