import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { initialScopedCollection, scopedCollectionReducer, scopedCollectionView } from './collection-state.js';

/** One in-flight request per resource, fenced to the current resource and run. */
export function useCollection(path, { pollMs = 15000, enabled = true } = {}) {
  const scope = useMemo(() => ({ path, enabled }), [path, enabled]);
  const [state, dispatch] = useReducer(scopedCollectionReducer, undefined, initialScopedCollection);
  const [revision, setRevision] = useState(0);
  const latestRun = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const run = ++latestRun.current;
    dispatch({ type: 'begin', scope, run });
    if (!scope.enabled) return undefined;
    const controller = new AbortController();
    let timer;
    async function read() {
      try {
        const items = await panelRequest(scope.path, { signal: controller.signal });
        if (!controller.signal.aborted) dispatch({ type: 'success', scope, run, items });
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: 'failure', scope, run, error });
      } finally {
        if (!controller.signal.aborted && pollMs > 0) timer = setTimeout(read, pollMs);
      }
    }
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [scope, pollMs, revision]);
  return { ...scopedCollectionView(state, scope), refresh };
}
