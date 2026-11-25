import { createContext, useContext, useMemo } from 'react';
import { panelPermission } from './owner-access.js';

const PanelSessionContext = createContext(null);

export function formatUserRoleLabel(user) {
  if (!user || typeof user !== 'object') return 'Kullanıcı';
  const role = user.role;
  const hostingKind = user.hosting?.kind;
  if (role === 'owner') return 'Sunucu Yöneticisi';
  if (hostingKind === 'reseller' || role === 'reseller') return 'Bayi';
  if (hostingKind === 'customer' || role === 'customer') return 'Müşteri';
  if (role === 'site_manager') return 'Site Yöneticisi';
  if (role === 'read_only') return 'Salt Okunur';
  return 'Kullanıcı';
}

export function PanelSessionProvider({ session, accountControls = null, children }) {
  const value = useMemo(() => {
    const role = session?.user?.role;
    const hosting = session?.user?.hosting;
    const isOwner = role === 'owner';
    const isReseller = hosting?.kind === 'reseller' || role === 'reseller';
    const isCustomer = hosting?.kind === 'customer' || role === 'customer';
    const isSiteManager = role === 'site_manager' && !isReseller && !isCustomer;
    return {
      session,
      accountControls,
      can: (permission) => panelPermission(session, permission),
      canManage: panelPermission(session, '*'),
      isOwner,
      isSiteManager,
      isReseller,
      isCustomer,
      hostingProfile: hosting ?? null,
      readOnly: session?.access?.mode === 'read_only' || role === 'read_only',
    };
  }, [session, accountControls]);
  return <PanelSessionContext.Provider value={value}>{children}</PanelSessionContext.Provider>;
}

export function usePanelSession() {
  const value = useContext(PanelSessionContext);
  if (!value) throw new Error('Panel session provider is missing');
  return value;
}
