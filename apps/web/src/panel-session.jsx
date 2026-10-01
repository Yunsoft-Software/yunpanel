import { createContext, useContext, useMemo } from 'react';
import { panelPermission } from './owner-access.js';

const PanelSessionContext = createContext(null);

export function PanelSessionProvider({ session, children }) {
  const value = useMemo(() => {
    const role = session?.user?.role;
    const hosting = session?.user?.hosting;
    const isOwner = role === 'owner';
    const isReseller = hosting?.kind === 'reseller';
    const isCustomer = hosting?.kind === 'customer';
    const isSiteManager = role === 'site_manager' && !isReseller && !isCustomer;
    return {
      session,
      can: (permission) => panelPermission(session, permission),
      canManage: panelPermission(session, '*'),
      isOwner,
      isSiteManager,
      isReseller: session?.user?.hosting?.kind === 'reseller',
      isCustomer: session?.user?.hosting?.kind === 'customer',
      hostingProfile: hosting ?? null,
      readOnly: session?.access?.mode === 'read_only' || role === 'read_only',
    };
  }, [session]);
  return <PanelSessionContext.Provider value={value}>{children}</PanelSessionContext.Provider>;
}

export function usePanelSession() {
  const value = useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}
