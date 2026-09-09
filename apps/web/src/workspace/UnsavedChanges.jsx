import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';
import { ConfirmDialog } from './PanelKit.jsx';

const DirtyContext = createContext(null);
export function UnsavedChangesProvider({ children }) {
  const [forms, setForms] = useState(() => new Set());
  const update = useCallback((id, dirty) => setForms((current) => {
    if (current.has(id) === dirty) return current;
    const next = new Set(current); if (dirty) next.add(id); else next.delete(id); return next;
  }), []);
  const dirty = forms.size > 0;
  const blocker = useBlocker(dirty);
  useBeforeUnload(useCallback((event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }, [dirty]));
  return <DirtyContext.Provider value={update}>{children}{blocker.state === 'blocked' && <ConfirmDialog title="Kaydedilmemiş değişiklikler var" message="Bu sayfadan ayrılırsanız henüz kaydetmediğiniz bilgiler silinir." confirmLabel="Değişiklikleri bırak" onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />}</DirtyContext.Provider>;
}
export function useUnsavedChanges(dirty) {
  const update = useContext(DirtyContext); const id = useId();
  useEffect(() => { update?.(id, Boolean(dirty)); return () => update?.(id, false); }, [id, update, dirty]);
}
