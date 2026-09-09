import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext.jsx';
import { UnsavedChangesProvider } from './UnsavedChanges.jsx';
import { Button, Icon, LinkButton } from './PanelKit.jsx';
import { knownCount } from './resource-model.js';
import JobDrawer from './JobDrawer.jsx';
import './workspace.css';

const navigation = [
  ['/dashboard', 'Genel bakış', 'dashboard'], ['/websites', 'Web siteleri', 'globe'], ['/servers', 'Sunucular', 'server'],
  ['/databases', 'Veritabanları', 'database'], ['/docker', 'Docker', 'box'], ['/mail', 'Mail', 'mail'],
  ['/backups', 'Yedekler', 'archive'], ['/jobs', 'İşler', 'jobs'], ['/audit', 'Denetim kayıtları', 'shield'], ['/settings', 'Ayarlar', 'settings'],
];
export default function WorkspaceLayout() {
  return <WorkspaceProvider><UnsavedChangesProvider><Shell /></UnsavedChangesProvider></WorkspaceProvider>;
}
function Shell() {
  const { domains, jobs, notice, setNotice } = useWorkspace();
  const location = useLocation(); const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false); const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  const [query, setQuery] = useState(''); const search = useRef(null); const menu = useRef(null); const content = useRef(null);
  const websiteCount = knownCount(domains); const jobCount = knownCount(jobs, (job) => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const change = () => { setNarrow(media.matches); if (!media.matches) setMenuOpen(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => { setMenuOpen(false); content.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }, [location.pathname]);
  useEffect(() => {
    const shortcut = (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); search.current?.focus(); search.current?.select(); } };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (!narrow || !menuOpen) return undefined;
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; menu.current.querySelector('button')?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = [...menu.current.querySelectorAll('a[href],button:not(:disabled)')].filter((element) => element.getClientRects().length);
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
      <div className="ws-brand"><span className="ws-brand-mark">Y</span><div><strong>YunPanel</strong><small>SUNUCU YÖNETİMİ</small></div><Button className="ws-nav-close" icon="close" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)} /></div>
      <p className="ws-nav-label">YÖNETİM</p><nav className="ws-nav" aria-label="Panel bölümleri">{navigation.map(([to, label, icon]) => <NavLink key={to} to={to}><Icon name={icon} /><span>{label}</span>{to === '/websites' && websiteCount !== null && <span className="ws-nav-count">{websiteCount}</span>}{to === '/jobs' && jobCount > 0 && <span className="ws-nav-count">{jobCount}</span>}</NavLink>)}</nav>
      <div className="ws-sidebar-footer"><strong>Yunsoft / YunPanel</strong><span>Veriler 15 saniyede bir yenilenir.<br />İşlem sonuçları ayrıca izlenir.</span></div>
    </aside>
    <div className="ws-main" inert={narrow && menuOpen}>
      <div className="ws-toolbar"><Button className="ws-mobile-menu" icon="menu" aria-label="Ana menüyü aç" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)} /><form className="ws-search" onSubmit={(event) => { event.preventDefault(); navigate(`/websites${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`); }}><Icon name="search" /><label className="ws-sr-only" htmlFor="workspace-search">Web sitelerinde ara</label><input id="workspace-search" ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Alan adı veya alias ara…" maxLength={253} /><kbd>Ctrl K</kbd></form><LinkButton to="/websites/new" variant="primary" icon="plus">Site ekle</LinkButton></div>
      <main id="workspace-main" ref={content} className="ws-content" tabIndex={-1}>{notice && <div className="ws-notice" role="status"><div>{notice}</div><Button icon="close" aria-label="Bildirimi kapat" onClick={() => setNotice(null)} /></div>}<Outlet /></main>
    </div><JobDrawer />
  </div>;
}
