import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';
import { ConfirmDialog } from './PanelKit.jsx';

const DirtyContext = createContext(null);
const SamePathBypassContext = createContext(null);

export function UnsavedChangesProvider({ children }) {
  const formsRef = useRef(new Set());
  const [, setVersion] = useState(0);
  const bypassSamePathRef = useRef(false);
  const update = useCallback((id, dirty) => {
    const has = formsRef.current.has(id);
    if (has === dirty) return;
    if (dirty) formsRef.current.add(id);
    else formsRef.current.delete(id);
    setVersion((value) => value + 1);
  }, []);
  const runWithoutSamePathBlock = useCallback((callback) => {
    bypassSamePathRef.current = true;
    try {
      callback();
    } finally {
      queueMicrotask(() => { bypassSamePathRef.current = false; });
    }
  }, []);
  const dirty = formsRef.current.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (formsRef.current.size === 0) return false;
    if (bypassSamePathRef.current && currentLocation.pathname === nextLocation.pathname) {
      bypassSamePathRef.current = false;
      return false;
    }
    return currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search;
  });
  useBeforeUnload(useCallback((event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }, [dirty]));
  return <DirtyContext.Provider value={update}><SamePathBypassContext.Provider value={runWithoutSamePathBlock}>{children}{blocker.state === 'blocked' && <ConfirmDialog title="Kaydedilmemiş değişiklikler var" message="Bu sayfadan ayrılırsanız henüz kaydetmediğiniz bilgiler silinir." cancelLabel="Düzenlemeye dön" confirmLabel="Değişiklikleri bırak" onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />}</SamePathBypassContext.Provider></DirtyContext.Provider>;
}
export function useUnsavedChanges(dirty) {
  const update = useContext(DirtyContext); const id = useId();
  useEffect(() => { update?.(id, Boolean(dirty)); return () => update?.(id, false); }, [id, update, dirty]);
}
export function useSamePathSearchBypass() {
  return useContext(SamePathBypassContext);
}
