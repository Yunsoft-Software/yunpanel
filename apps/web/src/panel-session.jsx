import { createContext, useContext, useMemo } from 'react';
import { panelPermission } from './owner-access.js';

const PanelSessionContext = createContext(null);

export function PanelSessionProvider({ session, children }) {
  const value = useMemo(() => ({
    session,
    can: (permission) => panelPermission(session, permission),
    canManage: panelPermission(session, '*'),
    isOwner: session?.user?.role === 'owner',
    isSiteManager: session?.user?.role === 'site_manager',
    isReseller: session?.user?.hosting?.kind === 'reseller',
    isCustomer: session?.user?.hosting?.kind === 'customer',
    hostingProfile: session?.user?.hosting ?? null,
    readOnly: session?.access?.mode === 'read_only',
  }), [session]);
  return <PanelSessionContext.Provider value={value}>{children}</PanelSessionContext.Provider>;
}

export function usePanelSession() {
  const value = useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}
