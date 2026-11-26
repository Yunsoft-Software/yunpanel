import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { usePanelSession } from '../panel-session.jsx';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext.jsx';
import { UnsavedChangesProvider } from './UnsavedChanges.jsx';
import { Button, Icon, LinkButton } from './PanelKit.jsx';
import { knownCount } from './resource-model.js';
import { isPremiumRequired } from './license-client.js';
import { navigationGroups, navigationItemActive, navigationItemRequiredCapability, PREFERENCE_KEY, writePreferences, websiteCount } from './ui/ux-model.js';
import { apply as applyThemePreferences, readStored as readStoredTheme } from './ui/Preferences.jsx';
import CommandPalette from './ui/CommandPalette.jsx';
import JobDrawer from './JobDrawer.jsx';
import AiDrawer from './AiDrawer.jsx';
import NotificationCenterDrawer, { computeWorkspaceAlerts } from './NotificationCenterDrawer.jsx';

export default function WorkspaceLayout() {
  return <WorkspaceProvider><UnsavedChangesProvider><Shell /></UnsavedChangesProvider></WorkspaceProvider>;
}
function Shell() {
  const { accountControls } = usePanelSession();
  const { domains, websites, certificates, servers, jobs, license, notice, setNotice, canManage, isOwner, isReseller, isCustomer } = useWorkspace();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [dismissedRedirectKey, setDismissedRedirectKey] = useState(null);
  const [themeMode, setThemeMode] = useState(() => (typeof document !== 'undefined' && document.documentElement.dataset.wsTheme === 'light' ? 'light' : 'dark'));
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  function toggleSidebar() {
    if (narrow) {
      setMenuOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => !prev);
    }
  }
  function toggleThemeMode() {
    const nextTheme = (typeof document !== 'undefined' && document.documentElement.dataset.wsTheme === 'light') ? 'dark' : 'light';
    setThemeMode(nextTheme);
    try {
      const current = readStoredTheme();
      const updated = { ...current, theme: nextTheme };
      applyThemePreferences(updated);
      if (typeof window !== 'undefined' && window.localStorage) {
        writePreferences(window.localStorage, updated);
        window.dispatchEvent(new StorageEvent('storage', { key: PREFERENCE_KEY, newValue: JSON.stringify(updated) }));
      }
    } catch {
      if (typeof document !== 'undefined') document.documentElement.dataset.wsTheme = nextTheme;
    }
  }
  const menu = useRef(null); const content = useRef(null);
  const sites = websiteCount(websites);
  const jobCount = canManage ? knownCount(jobs, (job) => ['queued', 'running'].includes(job.status)) : null;
  const activeJobCount = jobCount ?? 0;
  const alertCount = computeWorkspaceAlerts({ domains, websites, certificates, servers }).length;
  const groups = navigationGroups(canManage, isOwner, isReseller, isCustomer);
  const accessDeniedRedirect = location.state?.accessDeniedRedirect;
  const showAccessRedirectNotice = Boolean(
    accessDeniedRedirect
    && typeof accessDeniedRedirect === 'object'
    && dismissedRedirectKey !== location.key,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const change = () => { setNarrow(media.matches); if (!media.matches) setMenuOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    setMenuOpen(false); setPaletteOpen(false);
    content.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined;
    const syncTheme = () => {
      setThemeMode(document.documentElement.dataset.wsTheme === 'light' ? 'light' : 'dark');
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ws-theme'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onStorage = (event) => {
      if (event.key === PREFERENCE_KEY || event.key === null) {
        const stored = readStoredTheme();
        applyThemePreferences(stored);
        setThemeMode(document.documentElement.dataset.wsTheme === 'light' ? 'light' : 'dark');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    const shortcut = (event) => {
      const blocked = menuOpen || event.isComposing || document.querySelector('dialog[open]') || document.querySelector('.ws-drawer-backdrop');
      if (blocked) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setPaletteOpen(true);
      }
      if (isOwner && canManage && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault(); setAiOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [menuOpen, isOwner, canManage]);
  useEffect(() => {
    if (!narrow || !menuOpen) return undefined;
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; menu.current.querySelector('button')?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...menu.current.querySelectorAll('a[href],button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')].filter((element) => {
        if (element.disabled || element.closest('[inert]')) return false;
        return true;
      });
      if (focusable.length === 0) return;
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !menu.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !menu.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
      else document.querySelector('.ws-mobile-menu')?.focus();
    };
  }, [menuOpen, narrow]);
  const totalNotifications = activeJobCount + alertCount;
  return <div className={`workspace-shell ${!narrow && sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`} data-ws-design-system="shadcn-zinc-indigo" data-sites-count={sites ?? ''}>
    <a href="#workspace-main" className="ws-skip">İçeriğe geç</a>
    {narrow && menuOpen && <div className="ws-nav-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
    <aside ref={menu} id="workspace-navigation" className={`ws-sidebar ${menuOpen ? 'is-open' : ''} ${!narrow && sidebarCollapsed ? 'is-collapsed' : ''}`} inert={narrow && !menuOpen} aria-label="Ana menü" role={narrow && menuOpen ? 'dialog' : undefined} aria-modal={narrow && menuOpen ? true : undefined}>
      <div className="ws-brand">
        <Link to="/websites" className="ws-brand-link" aria-label="YunPanel Ana Sayfa">
          <span className="ws-brand-mark" aria-hidden="true">Y</span>
          <div>
            <strong>YunPanel</strong>
            <small>{isOwner ? 'SUNUCU YÖNETİMİ' : isReseller ? 'BAYİ PANELİ' : isCustomer ? 'MÜŞTERİ PANELİ' : canManage ? 'SİTE YÖNETİMİ' : 'SALT OKUNUR'}</small>
          </div>
        </Link>
        {narrow && <Button className="ws-nav-close ws-icon-btn" icon="close" aria-label="Menüyü kapat" title="Menüyü kapat" onClick={() => setMenuOpen(false)} />}
      </div>
      <nav className="ws-sidebar-nav" aria-label="Panel bölümleri">{groups.map((group) => {
        const managementRoutes = new Set(['/customers', '/resellers', '/tools-settings']);
        const hasSplit = isOwner && canManage && group.items.some(([to]) => managementRoutes.has(to));
        const hostingItems = hasSplit ? group.items.filter(([to]) => !managementRoutes.has(to)) : group.items;
        const managementItems = hasSplit ? group.items.filter(([to]) => managementRoutes.has(to)) : [];
        const renderItem = ([to, label, icon]) => {
          const requiredCapability = navigationItemRequiredCapability(to, isOwner);
          const premiumBadge = Boolean(requiredCapability && isPremiumRequired(license, requiredCapability));
          const active = navigationItemActive(to, location.pathname);
          return <Fragment key={to}>
            <Link to={to} className={active ? 'active' : undefined} aria-current={active ? (to === location.pathname ? 'page' : 'location') : undefined}>
              <Icon name={icon} size={17} />
              <span>{label}</span>
              {premiumBadge && <span className="ws-nav-premium" data-premium-badge="true">Pro</span>}
              {to === '/jobs' && jobCount > 0 && <span className="ws-nav-count">{jobCount}</span>}
            </Link>
            {to === '/websites' && canManage && isOwner && (
              <Link key="/docker" to="/docker" className={navigationItemActive('/docker', location.pathname) ? 'active' : undefined} aria-current={navigationItemActive('/docker', location.pathname) ? (location.pathname === '/docker' ? 'page' : 'location') : undefined}>
                <Icon name="box" size={17} />
                <span>Uygulama Marketi</span>
              </Link>
            )}
          </Fragment>;
        };
        return <Fragment key={group.id}>
          <div className="ws-nav-group">
            <p className="ws-nav-label" id={`ws-nav-${group.id}`}>{hasSplit ? 'Barındırma' : group.label}</p>
            <div className="ws-nav" role="group" aria-labelledby={`ws-nav-${group.id}`}>{hostingItems.map(renderItem)}</div>
          </div>
          {managementItems.length > 0 && (
            <div className="ws-nav-group">
              <p className="ws-nav-label" id={`ws-nav-${group.id}-mgmt`}>Yönetim</p>
              <div className="ws-nav" role="group" aria-labelledby={`ws-nav-${group.id}-mgmt`}>{managementItems.map(renderItem)}</div>
            </div>
          )}
        </Fragment>;
      })}</nav>
    </aside>
    <div className="ws-main" inert={narrow && menuOpen}>
      <header className="ws-toolbar">
        <div className="ws-toolbar-left">
          <Button
            className="ws-mobile-menu ws-icon-btn"
            icon={narrow ? 'menu' : 'sidebar'}
            aria-label="Ana menüyü aç"
            title={narrow ? (menuOpen ? 'Menüyü kapat' : 'Menüyü aç') : (sidebarCollapsed ? 'Yan menüyü göster' : 'Yan menüyü gizle')}
            aria-expanded={narrow ? menuOpen : !sidebarCollapsed}
            aria-controls="workspace-navigation"
            onClick={toggleSidebar}
          />
          <button type="button" className="ws-command-trigger" aria-label="Site veya panel bölümü ara" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={15} />
            <span>Site veya araç ara…</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
        <div className="ws-toolbar-actions">
          {canManage && isOwner && (
            <Button
              className="ws-icon-btn"
              icon="sparkles"
              aria-label="AI asistanı aç"
              title="AI Asistan · Ctrl / ⌘ Shift A"
              onClick={() => setAiOpen(true)}
            />
          )}
          <Button
            className="ws-icon-btn ws-icon-btn-badged"
            icon="bell"
            aria-label={`Bildirim ve Görev Merkezi${totalNotifications > 0 ? `, ${totalNotifications} bildirim` : ''}`}
            title="Bildirim ve Görev Merkezi"
            onClick={() => setNotificationsOpen(true)}
          >
            {totalNotifications > 0 && <span className="ws-icon-badge" aria-hidden="true">{totalNotifications > 99 ? '99+' : totalNotifications}</span>}
          </Button>
          {canManage && (
            <LinkButton
              className="ws-icon-btn ws-icon-btn-badged"
              to="/jobs"
              icon="jobs"
              aria-label={`İşlemler${jobCount > 0 ? `, ${jobCount} aktif` : ''}`}
              title="İşlemler"
            >
              {jobCount > 0 && <span className="ws-icon-badge" aria-hidden="true">{jobCount}</span>}
            </LinkButton>
          )}
          <span className="ws-toolbar-divider" aria-hidden="true" />
          <Button
            className="ws-theme-toggle ws-icon-btn"
            icon={themeMode === 'light' ? 'moon' : 'sun'}
            onClick={toggleThemeMode}
            aria-label={themeMode === 'light' ? 'Gece temasına geç' : 'Açık temaya geç'}
            title={themeMode === 'light' ? 'Gece temasına geç' : 'Açık temaya geç'}
          />
          {accountControls && <>
            <span className="ws-toolbar-divider" aria-hidden="true" />
            <div className="auth-sessionbar ws-topbar-account" aria-label="Hesap işlemleri">
              <div className="ws-topbar-identity">
                <span className="ws-topbar-username">{accountControls.username}</span>
                <span className="auth-role">{accountControls.roleLabel}</span>
              </div>
              <Button
                className="ws-icon-btn"
                icon="user"
                disabled={accountControls.accountDisabled}
                aria-label="Hesabım"
                title={`Hesabım (${accountControls.username})`}
                onClick={accountControls.openAccount}
              />
              <Button
                className="ws-icon-btn ws-icon-btn-logout"
                icon="logout"
                disabled={accountControls.busy}
                aria-label="Çıkış yap"
                title={accountControls.busy ? 'İşleniyor…' : 'Çıkış yap'}
                onClick={accountControls.logout}
              />
            </div>
          </>}
        </div>
      </header>
      <main id="workspace-main" ref={content} className="ws-content" tabIndex={-1}>{showAccessRedirectNotice && <div className="ws-notice ws-notice-warn" role="status" data-access-redirect-notice="true"><div>Bu sayfaya erişim yetkiniz olmadığı için yetkili olduğunuz site listesine yönlendirildiniz.</div><Button className="ws-icon-btn" icon="close" aria-label="Yetki yönlendirme bildirimini kapat" title="Kapat" onClick={() => setDismissedRedirectKey(location.key)} /></div>}{notice && <div className="ws-notice" role="status"><div>{notice}</div><Button className="ws-icon-btn" icon="close" aria-label="Bildirimi kapat" title="Kapat" onClick={() => setNotice(null)} /></div>}<Outlet /></main>
    </div>
    {paletteOpen && <CommandPalette domains={domains} canManage={canManage} isOwner={isOwner} isReseller={isReseller} isCustomer={isCustomer} onClose={() => setPaletteOpen(false)} />}
    {notificationsOpen && <NotificationCenterDrawer open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />}
    {canManage && <JobDrawer />}
    {canManage && <AiDrawer open={aiOpen} onClose={() => setAiOpen(false)} />}
  </div>;
}
