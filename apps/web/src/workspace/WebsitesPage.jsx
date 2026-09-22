import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, selectedApplication, siteHref } from './site-model.js';
import { siteListPage } from './site-list-model.js';
import { useWebsitePreferences } from './useWebsitePreferences.js';
import { readableItems } from './ui/console-model.js';
import './website-preferences.css';
import './ui/console-lists.css';

export default function WebsitesPage() {
  const { domains, websites, applications, certificates, isOwner } = useWorkspace();
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
  function filter(name, value) {
    setParams((current) => { const next = new URLSearchParams(current); if (value && value !== 'all') next.set(name, value); else next.delete(name); if (name !== 'page') next.delete('page'); return next; }, { replace: name === 'q' });
  }
  function toggle(id) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const certs = ['ready', 'stale'].includes(certificates.status) ? certificates.items : null;
  const siteItems = readableItems(websites);
  const appItems = readableItems(applications);
  return <>
    <PageHeading title="Web siteleri" description="Bir siteyi seçin; uygulama, dosyalar, veritabanı ve SSL’i aynı çalışma alanından yönetin." actions={<><Button icon="refresh" onClick={domains.refresh}>Yenile</Button><LinkButton to="/websites/new" icon="plus" variant="primary">Web sitesi ekle</LinkButton></>} />
    <Section className={`ws-site-table ws-site-table-${preferences.density} ws-site-list`} title="Siteler ve alt alan adları" description={readable ? `${result.totalGroups} alan adı grubu` : 'Site listesi hazırlanıyor.'}>
      <div className="ws-filters">
        <label className="ws-filter-search">Site ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Alan adı veya alias" /></label>
        <label>Durum<select value={status} onChange={(event) => filter('status', event.target.value)}><option value="all">Tüm durumlar</option><option value="active">Aktif</option><option value="draft">Taslak</option><option value="staged">Hazırlandı</option><option value="error">Hata</option></select></label>
        <details className="ws-list-options"><summary>Görünüm ve filtreler</summary><div className="ws-filter-options">
          <label>Tür<select value={type} onChange={(event) => filter('type', event.target.value)}><option value="all">Tüm türler</option><option value="proxy">Uygulama / Proxy</option><option value="static">Statik site</option></select></label>
          <label>Sıralama<select value={sort} onChange={(event) => filter('sort', event.target.value)}><option value="asc">Alan adı A–Z</option><option value="desc">Alan adı Z–A</option></select></label>
          <label>Satır aralığı<select value={preferences.density} onChange={(event) => changePreferences({ density: event.target.value })}><option value="comfortable">Rahat</option><option value="compact">Kompakt</option></select></label>
          <label>Sayfada alan adı grubu<select value={preferences.perPage} onChange={(event) => { changePreferences({ perPage: Number(event.target.value) }); filter('page', '1'); }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
        </div></details>
      </div>
      {!saved && <p className="ws-muted ws-view-notice" role="status">Görünüm tercihi bu oturumda uygulanıyor; tarayıcı kalıcı kayda izin vermiyor.</p>}
      <CollectionNotice resource={domains} label="Web siteleri" />
      <CollectionNotice resource={websites} label="Site bağlantıları" />
      <CollectionNotice resource={applications} label="Uygulamalar" />
      <CollectionNotice resource={certificates} label="SSL bilgisi" />
      {domains.status === 'ready' && !domains.items.length ? <EmptyState title="Henüz web sitesi yok" detail="İlk sitenizin alan adını, uygulama türünü ve HTTPS tercihini belirleyin." icon="globe" action={<LinkButton to="/websites/new" variant="primary" icon="plus">İlk siteyi ekle</LinkButton>} /> : readable && <>
        {result.rows.length > 0 && <div className="ws-table-scroll"><table className="ws-table ws-websites-table" role="table" aria-label="Siteler ve alt alan adları"><thead><tr><th scope="col">Alan adı</th><th scope="col">Uygulama</th><th scope="col">Durum</th><th scope="col">SSL</th><th scope="col"><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody>
          {result.rows.map(({ domain, depth, childCount, expanded, warning, contextOnly }) => {
            const website = siteItems.find((item) => item.id === domain.websiteId);
            const application = appItems.find((item) => item.id === website?.applicationId) ?? selectedApplication(domain, appItems);
            const runtimeType = website?.runtimeType ?? application?.type;
            const runtime = runtimeType === 'node' ? `Node.js ${application?.runtime?.nodeMajor ?? ''}` : ({ php: 'PHP-FPM', python: 'Python', docker: 'Docker', static: 'Statik site' }[runtimeType] ?? (domain.targetType === 'static' ? 'Statik site' : 'Uygulama / Proxy'));
            const ssl = certificateState(domain, certs);
            return <tr key={domain.id} role="row" className={contextOnly ? 'ws-context-row' : ''}>
              <td role="cell"><div className="ws-domain-name" style={{ '--ws-depth': Math.min(depth, 3) }}>
                {childCount ? <button className="ws-tree-toggle" type="button" disabled={filtering} aria-expanded={expanded} aria-label={`${domain.primaryDomain} alt alan adlarını ${expanded ? 'daralt' : 'genişlet'}`} onClick={() => toggle(domain.id)}><Icon name="chevron" size={15} /></button> : <span className="ws-tree-spacer" />}
                <span className="ws-domain-symbol"><Icon name="globe" /></span><div><Link to={siteHref(domain.id)}>{domain.primaryDomain}</Link><small>{domain.parentDomainId ? 'Alt alan adı' : 'Ana kayıt'}{domain.aliases?.length ? ` · ${domain.aliases.length} alias` : ''}</small>{warning && <small>Üst kayıt ilişkisini kontrol edin</small>}</div>
              </div></td>
              <td role="cell" data-label="Uygulama"><strong>{runtime}</strong><small>{application?.name ?? (domain.targetType === 'static' ? 'Dosya yayını' : 'Yerel yayın hedefi')}</small></td>
              <td role="cell" data-label="Durum"><Badge state={domain.state} /></td><td role="cell" data-label="SSL"><Badge state={ssl.state}>{ssl.label}</Badge></td>
              <td role="cell" className="ws-row-end"><div className="ws-actions"><LinkButton to={siteHref(domain.id, 'ssl')} icon="shield" aria-label={`${domain.primaryDomain} SSL ayarları`}>SSL</LinkButton><LinkButton to={siteHref(domain.id)} icon="arrow" aria-label={`${domain.primaryDomain} sitesini yönet`}>Yönet</LinkButton></div></td>
            </tr>;
          })}
        </tbody></table></div>}
        {!result.rows.length && domains.items.length > 0 && <EmptyState title="Eşleşen alan adı bulunamadı" detail="Arama terimini veya filtreleri değiştirin." icon="search" action={<Button onClick={() => setParams({})}>Filtreleri temizle</Button>} />}
        {domains.items.length > 0 && <footer className="ws-pagination"><span>Alt alan adları üst kaydıyla birlikte gösterilir.</span><div className="ws-actions"><Button disabled={result.page <= 1} onClick={() => filter('page', String(result.page - 1))}>Önceki</Button><span>{result.page} / {result.pageCount}</span><Button disabled={result.page >= result.pageCount} onClick={() => filter('page', String(result.page + 1))}>Sonraki</Button></div></footer>}
      </>}
    </Section>
    <p className="ws-muted">DNS, SSL ve mail durumunu ilgili sitenin içinden takip edebilirsiniz. {isOwner && <Link to="/domains">Gelişmiş alan adı araçları</Link>}</p>
  </>;
}
