import { createContext, useContext, useMemo } from 'react';
import { panelPermission } from './owner-access.js';

const PanelSessionContext = createContext(null);

export function PanelSessionProvider({ session, children }) {
  const value = useMemo(() => ({
    session,
    can: (permission) => panelPermission(session, permission),
    canManage: panelPermission(session, '*'),
    readOnly: session?.access?.mode === 'read_only',
  }), [session]);
  return <PanelSessionContext.Provider value={value}>{children}</PanelSessionContext.Provider>;
}

export function usePanelSession() {
  const value = useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}
