import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, CollectionNotice, EmptyState, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { siteListPage } from './site-list-model.js';
import { createWebsiteTaskResolver, siteListFilterParams, clearSiteListFilters } from './website-task-model.js';
import WebsiteTaskCard from './WebsiteTaskCard.jsx';
import WebsiteRemovalRecoveryPanel from './WebsiteRemovalRecoveryPanel.jsx';
import { useWebsitePreferences } from './useWebsitePreferences.js';
import './website-preferences.css';
import './ui/console-lists.css';
import './ui/website-task-cards.css';

export default function WebsitesPage() {
  const { domains, websites, applications, certificates, isOwner, canManage, refreshAll } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const { preferences, change: changePreferences, saved } = useWebsitePreferences();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const query = params.get('q') ?? '';
  const type = ['proxy', 'static'].includes(params.get('type')) ? params.get('type') : 'all';
  const status = ['active', 'draft', 'staged', 'error'].includes(params.get('status')) ? params.get('status') : 'all';
  const sort = params.get('sort') === 'desc' ? 'desc' : 'asc';
  const filtering = Boolean(query.trim()) || type !== 'all' || status !== 'all';
  const tree = useMemo(() => domainTreeRows(domains.items, { query, collapsed: filtering ? new Set() : collapsed }), [domains.items, query, filtering, collapsed]);
  const result = siteListPage(tree, { type, status, sort, perPage: preferences.perPage, page: Number(params.get('page') ?? 1) });
  const readable = ['ready', 'stale'].includes(domains.status);
  const resolveTasks = useMemo(() => createWebsiteTaskResolver({ domains, websites, applications, canManage, isOwner }), [domains, websites, applications, canManage, isOwner]);
  function filter(name, value) {
    setParams((current) => siteListFilterParams(current, name, value), { replace: name === 'q' });
  }
  function toggle(id) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return <>
    <PageHeading title="Web Siteleri ve Alan Adları" description="Dosya, posta, veritabanı ve yayın araçlarını ilgili sitenin kartından açın." actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button>{isOwner && canManage && <LinkButton to="/websites/new" icon="plus" variant="primary">Web sitesi ekle</LinkButton>}</>} />
    {isOwner && canManage && <WebsiteRemovalRecoveryPanel />}
    <Section className={`ws-site-table ws-site-table-${preferences.density} ws-site-list`} title="Siteler ve alt alan adları" description={readable ? `${result.totalGroups} alan adı grubu` : 'Site listesi hazırlanıyor.'}>
      <div className="ws-filters">
        <label className="ws-filter-search">Site ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Alan adı veya alias" /></label>
        <label>Durum<select value={status} onChange={(event) => filter('status', event.target.value)}><option value="all">Tüm durumlar</option><option value="active">Aktif</option><option value="draft">Taslak</option><option value="staged">Hazırlandı</option><option value="error">Hata</option></select></label>
        <details className="ws-list-options"><summary>Görünüm ve filtreler</summary><div className="ws-filter-options">
          <label>Tür<select value={type} onChange={(event) => filter('type', event.target.value)}><option value="all">Tüm türler</option><option value="proxy">Uygulama / Proxy</option><option value="static">Statik site</option></select></label>
          <label>Sıralama<select value={sort} onChange={(event) => filter('sort', event.target.value)}><option value="asc">Alan adı A–Z</option><option value="desc">Alan adı Z–A</option></select></label>
          <label>Kart aralığı<select value={preferences.density} onChange={(event) => changePreferences({ density: event.target.value })}><option value="comfortable">Rahat</option><option value="compact">Kompakt</option></select></label>
          <label>Sayfada alan adı grubu<select value={preferences.perPage} onChange={(event) => { changePreferences({ perPage: Number(event.target.value) }); filter('page', '1'); }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
        </div></details>
      </div>
      {!saved && <p className="ws-muted ws-view-notice" role="status">Görünüm tercihi bu oturumda uygulanıyor; tarayıcı kalıcı kayda izin vermiyor.</p>}
      <CollectionNotice resource={domains} label="Web siteleri" />
      <CollectionNotice resource={websites} label="Site bağlantıları" />
      <CollectionNotice resource={applications} label="Uygulamalar" />
      <CollectionNotice resource={certificates} label="SSL bilgisi" />
      {domains.status === 'ready' && !domains.items.length ? <EmptyState title="Henüz web sitesi yok" detail={isOwner ? 'İlk sitenizin alan adını, uygulama türünü ve HTTPS tercihini belirleyin.' : 'Hesabınıza bağlı siteler burada görünecek.'} icon="globe" action={isOwner && canManage ? <LinkButton to="/websites/new" variant="primary" icon="plus">İlk siteyi ekle</LinkButton> : null} /> : readable && <>
        {result.rows.length > 0 && <ul className="ws-website-task-list" aria-label="Siteler ve alt alan adları">
          {result.rows.map((row) => <li key={row.domain.id}><WebsiteTaskCard row={row} tasks={resolveTasks(row.domain.id)} certificates={certificates} filtering={filtering} onToggle={toggle} /></li>)}
        </ul>}
        {!result.rows.length && domains.items.length > 0 && <EmptyState title="Eşleşen alan adı bulunamadı" detail="Arama terimini veya filtreleri değiştirin." icon="search" action={<Button onClick={() => setParams((current) => clearSiteListFilters(current))}>Filtreleri temizle</Button>} />}
        {domains.items.length > 0 && <footer className="ws-pagination"><span>Alt alan adları üst kaydıyla birlikte gösterilir.</span><div className="ws-actions"><Button disabled={result.page <= 1} onClick={() => filter('page', String(result.page - 1))}>Önceki</Button><span>{result.page} / {result.pageCount}</span><Button disabled={result.page >= result.pageCount} onClick={() => filter('page', String(result.page + 1))}>Sonraki</Button></div></footer>}
      </>}
    </Section>
    <p className="ws-muted">Durum etiketleri son alınan kayıt ve sertifika bilgilerini gösterir; canlı servis sağlık testi değildir. {isOwner && <Link to="/domains">Gelişmiş alan adı araçları</Link>}</p>
  </>;
}
