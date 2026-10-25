import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext.jsx';
import { UnsavedChangesProvider } from './UnsavedChanges.jsx';
import { Button, Icon, LinkButton } from './PanelKit.jsx';
import { knownCount } from './resource-model.js';
import { navigationGroups, navigationItemActive, PREFERENCE_KEY, readPreferences, writePreferences, websiteCount } from './ui/ux-model.js';
import Preferences, { apply as applyThemePreferences, readStored as readStoredTheme } from './ui/Preferences.jsx';
import CommandPalette from './ui/CommandPalette.jsx';
import JobDrawer from './JobDrawer.jsx';
import AiDrawer from './AiDrawer.jsx';
import NotificationCenterDrawer, { computeWorkspaceAlerts } from './NotificationCenterDrawer.jsx';
import './workspace.css';
import './ui/ux-theme.css';

export default function WorkspaceLayout() {
  return <WorkspaceProvider><UnsavedChangesProvider><Shell /></UnsavedChangesProvider></WorkspaceProvider>;
}
function Shell() {
  const { domains, websites, certificates, servers, jobs, notice, setNotice, canManage, isOwner, isReseller, isCustomer } = useWorkspace();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [themeMode, setThemeMode] = useState(() => (typeof document !== 'undefined' && document.documentElement.dataset.wsTheme === 'light' ? 'light' : 'dark'));
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  function toggleSidebar() {
    if (narrow) {
      setMenuOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => !prev);
    }
  }
  function closeSidebar() {
    if (narrow) {
      setMenuOpen(false);
    } else {
      setSidebarCollapsed(true);
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
  function handleShellMouseMove(event) {
    const card = event.target?.closest?.('.ws-website-task-card, .ws-section, .ws-metric, .yp-spotlight-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--yp-mouse-x', `${Math.round(event.clientX - rect.left)}px`);
    card.style.setProperty('--yp-mouse-y', `${Math.round(event.clientY - rect.top)}px`);
  }
  const menu = useRef(null); const content = useRef(null); const appearanceRef = useRef(null);
  const sites = websiteCount(websites);
  const jobCount = canManage ? knownCount(jobs, (job) => ['queued', 'running'].includes(job.status)) : null;
  const activeJobCount = jobCount ?? 0;
  const alertCount = computeWorkspaceAlerts({ domains, websites, certificates, servers }).length;
  const groups = navigationGroups(canManage, isOwner, isReseller, isCustomer);
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
    const shortcut = (event) => {
      const blocked = menuOpen || event.isComposing || document.querySelector('dialog[open]');
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
    const details = menu.current?.querySelector('details.ws-appearance') || document.querySelector('details.ws-appearance');
    if (!details) return undefined;
    appearanceRef.current = details;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (details.open) {
          event.preventDefault();
          event.stopPropagation();
          details.open = false;
          details.querySelector('summary')?.focus();
        }
        return;
      }
      if (event.key === 'Tab' && details.open) {
        const focusable = Array.from(details.querySelectorAll('summary, select:not(:disabled), button:not(:disabled), input:not(:disabled)'))
          .filter((element) => !element.disabled && !element.closest('[inert]'));
        if (focusable.length <= 1) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    details.addEventListener('keydown', handleKeyDown);
    return () => details.removeEventListener('keydown', handleKeyDown);
  }, []);
  useEffect(() => {
    if (!narrow || !menuOpen) return undefined;
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; menu.current.querySelector('button')?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') {
        if (appearanceRef.current?.open && appearanceRef.current.contains(document.activeElement)) {
          event.preventDefault();
          appearanceRef.current.open = false;
          appearanceRef.current.querySelector('summary')?.focus();
          return;
        }
        event.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...menu.current.querySelectorAll('a[href],button:not(:disabled),select:not(:disabled),input:not(:disabled),summary')].filter((element) => {
        if (element.disabled || element.closest('[inert]')) return false;
        const closedDetails = element.closest('details:not([open])');
        if (closedDetails && !element.matches('summary')) return false;
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
  return <div className={`workspace-shell ${!narrow && sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`} data-ws-design-system="shadcn-zinc-indigo">
    <a href="#workspace-main" className="ws-skip">İçeriğe geç</a>
    {narrow && menuOpen && <button type="button" tabIndex={-1} className="ws-nav-backdrop" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)} />}
    <aside ref={menu} id="workspace-navigation" className={`ws-sidebar ${menuOpen ? 'is-open' : ''} ${!narrow && sidebarCollapsed ? 'is-collapsed' : ''}`} inert={narrow && !menuOpen} aria-label="Ana menü" role={narrow && menuOpen ? 'dialog' : undefined} aria-modal={narrow && menuOpen ? true : undefined}>
      <div className="ws-brand"><span className="ws-brand-mark" aria-hidden="true">Y</span><div><strong>YunPanel</strong><small>{isOwner ? 'SUNUCU YÖNETİMİ' : isReseller ? 'BAYİ PANELİ' : isCustomer ? 'MÜŞTERİ PANELİ' : 'SİTE YÖNETİMİ'}</small></div><Button className="ws-nav-close" icon="close" aria-label="Menüyü kapat" title="Yan menüyü daralt / kapat" onClick={closeSidebar} /></div>
      <nav aria-label="Panel bölümleri">{groups.map((group) => <div className="ws-nav-group" key={group.id}><p className="ws-nav-label" id={`ws-nav-${group.id}`}>{group.label}</p><div className="ws-nav" role="group" aria-labelledby={`ws-nav-${group.id}`}>{group.items.map(([to, label, icon]) => <Fragment key={to}><Link to={to} className={navigationItemActive(to, location.pathname) ? 'active' : undefined} aria-current={navigationItemActive(to, location.pathname) ? (to === location.pathname ? 'page' : 'location') : undefined}><Icon name={icon} /><span>{label}</span>{to === '/jobs' && jobCount > 0 && <span className="ws-nav-count">{jobCount}</span>}</Link>{to === '/websites' && canManage && isOwner && <Link key="/docker" to="/docker" className={navigationItemActive('/docker', location.pathname) ? 'active' : undefined} aria-current={navigationItemActive('/docker', location.pathname) ? (location.pathname === '/docker' ? 'page' : 'location') : undefined}><Icon name="box" /><span>Uygulama Marketi</span></Link>}</Fragment>)}</div></div>)}</nav>
      <details className="ws-appearance"><summary>Görünüm tercihleri</summary><Preferences /></details>
      <div className="ws-sidebar-footer"><strong>{isOwner ? (canManage ? 'Sunucu yönetimi' : 'Salt okunur görünüm') : isReseller ? 'Bayi yönetimi' : isCustomer ? 'Müşteri paneli' : 'Site yönetimi'}</strong><span>{isOwner ? (canManage ? 'Yerel sunucu çalışma alanı' : 'Yalnız izin verilen kaynaklar') : isReseller ? 'Müşterileriniz ve izinli site araçları' : isCustomer ? 'Web siteleriniz ve barındırma araçları' : 'Yetkili olduğunuz web siteleri'}</span></div>
    </aside>
    <div className="ws-main" inert={narrow && menuOpen}>
      <div className="ws-toolbar">
        <Button className="ws-mobile-menu" icon="menu" aria-label="Ana menüyü aç" title={sidebarCollapsed ? 'Yan menüyü göster' : 'Yan menüyü gizle'} aria-expanded={narrow ? menuOpen : !sidebarCollapsed} aria-controls="workspace-navigation" onClick={toggleSidebar} />
        <button type="button" className="ws-command-trigger" aria-label="Site veya panel bölümü ara" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}><Icon name="search" /><span>Site veya araç ara…</span><kbd>⌘ / Ctrl K</kbd></button>
        <div className="ws-toolbar-actions">
          <Button icon={themeMode === 'light' ? 'moon' : 'sun'} onClick={toggleThemeMode} aria-label="Gece ve Açık tema arasında geçiş yap" title="Tema Değiştir">
            <span className="ws-toolbar-label">{themeMode === 'light' ? 'Gece Modu' : 'Açık Mod'}</span>
          </Button>
          {canManage && isOwner && <LinkButton to="/docker" icon="box" aria-label="Uygulama Marketi" title="Uygulama Marketi"><span className="ws-toolbar-label">Uygulama Marketi</span></LinkButton>}
          {canManage && isOwner && <Button icon="terminal" aria-label="AI asistanı aç" title="AI Asistan · Ctrl / ⌘ Shift A" onClick={() => setAiOpen(true)}><span className="ws-toolbar-label">AI Asistan</span></Button>}
          <Button icon="bell" aria-label="Bildirim ve Görev Merkezi" title="Bildirim ve Görev Merkezi" onClick={() => setNotificationsOpen(true)}><span className="ws-toolbar-label">Bildirimler</span>{(activeJobCount + alertCount) > 0 && <span className="ws-nav-count">{activeJobCount + alertCount}</span>}</Button>
          {canManage && <LinkButton to="/jobs" icon="jobs" aria-label={`İşlemler${jobCount > 0 ? `, ${jobCount} aktif` : ''}`} title="İşlemler"><span className="ws-toolbar-label">İşlemler</span>{jobCount > 0 && <span className="ws-nav-count">{jobCount}</span>}</LinkButton>}
        </div>
      </div>
      <main id="workspace-main" ref={content} className="ws-content" tabIndex={-1}>{notice && <div className="ws-notice" role="status"><div>{notice}</div><Button icon="close" aria-label="Bildirimi kapat" onClick={() => setNotice(null)} /></div>}<Outlet /></main>
    </div>
    {paletteOpen && <CommandPalette domains={domains} canManage={canManage} isOwner={isOwner} isReseller={isReseller} isCustomer={isCustomer} onClose={() => setPaletteOpen(false)} />}
    {notificationsOpen && <NotificationCenterDrawer open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />}
    {canManage && <JobDrawer />}
    {canManage && <AiDrawer open={aiOpen} onClose={() => setAiOpen(false)} />}
  </div>;
}
