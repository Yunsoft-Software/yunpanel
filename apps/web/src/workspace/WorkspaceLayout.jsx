import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext.jsx';
import { UnsavedChangesProvider } from './UnsavedChanges.jsx';
import { Button, Icon, LinkButton } from './PanelKit.jsx';
import { knownCount } from './resource-model.js';
import { navigationGroups, websiteCount } from './ui/ux-model.js';
import Preferences from './ui/Preferences.jsx';
import CommandPalette from './ui/CommandPalette.jsx';
import JobDrawer from './JobDrawer.jsx';
import './workspace.css';
import './ui/ux-theme.css';

export default function WorkspaceLayout() {
  return <WorkspaceProvider><UnsavedChangesProvider><Shell /></UnsavedChangesProvider></WorkspaceProvider>;
}
function Shell() {
  const { domains, websites, jobs, notice, setNotice, canManage } = useWorkspace();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const menu = useRef(null); const content = useRef(null);
  const sites = websiteCount(websites);
  const jobCount = canManage ? knownCount(jobs, (job) => ['queued', 'running'].includes(job.status)) : null;
  const groups = navigationGroups(canManage);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const change = () => { setNarrow(media.matches); if (!media.matches) setMenuOpen(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => { setMenuOpen(false); setPaletteOpen(false); content.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }, [location.pathname]);
  useEffect(() => {
    const shortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing && !menuOpen && !document.querySelector('dialog[open]')) {
        event.preventDefault(); setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [menuOpen]);
  useEffect(() => {
    if (!narrow || !menuOpen) return undefined;
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; menu.current.querySelector('button')?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = [...menu.current.querySelectorAll('a[href],button:not(:disabled),select:not(:disabled),input:not(:disabled)')].filter((element) => element.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !menu.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !menu.current.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [menuOpen, narrow]);
  return <div className="workspace-shell">
    <a href="#workspace-main" className="ws-skip">İçeriğe geç</a>
    {narrow && menuOpen && <button type="button" tabIndex={-1} className="ws-nav-backdrop" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)} />}
    <aside ref={menu} id="workspace-navigation" className={`ws-sidebar ${menuOpen ? 'is-open' : ''}`} inert={narrow && !menuOpen} aria-label="Ana menü" role={narrow && menuOpen ? 'dialog' : undefined} aria-modal={narrow && menuOpen ? true : undefined}>
      <div className="ws-brand"><span className="ws-brand-mark" aria-hidden="true">Y</span><div><strong>YunPanel</strong><small>SUNUCU YÖNETİMİ</small></div><Button className="ws-nav-close" icon="close" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)} /></div>
      <nav aria-label="Panel bölümleri">{groups.map((group) => <div className="ws-nav-group" key={group.id}><p className="ws-nav-label" id={`ws-nav-${group.id}`}>{group.label}</p><div className="ws-nav" role="group" aria-labelledby={`ws-nav-${group.id}`}>{group.items.map(([to, label, icon]) => <NavLink key={to} to={to}><Icon name={icon} /><span>{label}</span>{to === '/websites' && sites !== null && <span className="ws-nav-count" aria-label={`${sites} bağımsız Website`}>{sites}</span>}{to === '/jobs' && jobCount > 0 && <span className="ws-nav-count">{jobCount}</span>}</NavLink>)}</div></div>)}</nav>
      <Preferences />
      <div className="ws-sidebar-footer"><strong>{canManage ? 'Sunucu yönetimi' : 'Salt okunur görünüm'}</strong><span>{canManage ? 'Bu panel yalnız kurulu olduğu sunucuyu yönetir.' : 'Yalnız hesabınıza izin verilen envanter gösterilir.'}</span></div>
    </aside>
    <div className="ws-main" inert={narrow && menuOpen}>
      <div className="ws-toolbar"><Button className="ws-mobile-menu" icon="menu" aria-label="Ana menüyü aç" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)} />
        <button type="button" className="ws-command-trigger" aria-label="Site veya panel bölümü ara" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}><Icon name="search" /><span>Site veya panel bölümü ara…</span><kbd>⌘ / Ctrl K</kbd></button>
        {canManage && <div className="ws-toolbar-actions"><LinkButton to="/jobs" icon="jobs">İşlemler{jobCount > 0 ? ` · ${jobCount} aktif` : ''}</LinkButton><LinkButton to="/websites/new" variant="primary" icon="plus">Site ekle</LinkButton></div>}
      </div>
      <main id="workspace-main" ref={content} className="ws-content" tabIndex={-1}>{notice && <div className="ws-notice" role="status"><div>{notice}</div><Button icon="close" aria-label="Bildirimi kapat" onClick={() => setNotice(null)} /></div>}<Outlet /></main>
    </div>
    {paletteOpen && <CommandPalette domains={domains} canManage={canManage} onClose={() => setPaletteOpen(false)} />}
    {canManage && <JobDrawer />}
  </div>;
}
