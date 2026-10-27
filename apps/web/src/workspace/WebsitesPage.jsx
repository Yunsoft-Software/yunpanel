import { useEffect, useMemo, useState } from 'react';
import { panelRequest } from '../api.js';
import { readHostingAccount, hostingAccountMessage } from './hosting-account-client.js';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { usePanelSession } from '../panel-session.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, CollectionNotice, EmptyState, ErrorNotice, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { filterWebsiteListDomains, siteListPage } from './site-list-model.js';
import { createWebsiteTaskResolver, siteListFilterParams, clearSiteListFilters } from './website-task-model.js';
import WebsiteTaskCard from './WebsiteTaskCard.jsx';
import WebsiteRemovalRecoveryPanel from './WebsiteRemovalRecoveryPanel.jsx';
import { useWebsitePreferences } from './useWebsitePreferences.js';
import './website-preferences.css';
import './ui/console-lists.css';
import './ui/website-task-cards.css';

export default function WebsitesPage() {
  const { domains, websites, applications, certificates, isOwner, isReseller, isCustomer, hostingProfile, canManage, refreshAll } = useWorkspace();
  const { session } = usePanelSession();
  const [params, setParams] = useSearchParams();
  const { preferences, change: changePreferences, saved } = useWebsitePreferences();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const customerId = isOwner ? params.get('customer') : null;
  const [customer, setCustomer] = useState(null), [customerError, setCustomerError] = useState(null);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setCustomer(null); setCustomerError(null);
    if (customerId) panelRequest(`/users/hosting/accounts/${encodeURIComponent(customerId)}`, { signal: controller.signal }).then(value => {
      const account = readHostingAccount(value);
      if (account.id !== customerId || account.kind !== 'customer' || !account.websiteIds) throw Object.assign(new Error('Unknown customer sites'), { code: 'hosting_result_invalid' });
      if (active) setCustomer(account);
    }).catch(error => { if (active && error.name !== 'AbortError') setCustomerError(hostingAccountMessage(error)); });
    return () => { active = false; controller.abort(); };
  }, [customerId]);

  const query = params.get('q') ?? params.get('search') ?? params.get('query') ?? '';
  const type = ['proxy', 'static'].includes(params.get('type')) ? params.get('type') : 'all';
  const statusParam = params.get('status') ?? params.get('state');
  const status = ['active', 'draft', 'staged', 'error'].includes(statusParam) ? statusParam : 'all';
  const sort = params.get('sort') === 'desc' ? 'desc' : 'asc';
  const filtering = Boolean(query.trim()) || Boolean(customerId) || type !== 'all' || status !== 'all';
  const visibleDomains = useMemo(() => {
    const filtered = filterWebsiteListDomains(domains.items);
    return customerId ? filtered.filter(domain => customer?.websiteIds?.includes(domain.websiteId)) : filtered;
  }, [customerId, customer, domains.items]);
  const tree = useMemo(() => domainTreeRows(visibleDomains, { query, collapsed: filtering ? new Set() : collapsed, flattenSubdomains: true }), [visibleDomains, query, filtering, collapsed]);
  const result = siteListPage(tree, { type, status, sort, perPage: preferences.perPage, page: Number(params.get('page') ?? 1) });
  const subdomainsCount = useMemo(() => {
    const fromTree = tree.reduce((sum, row) => sum + ((row.depth ?? 0) > 0 ? 1 : (collapsed.has(row.domain?.id) ? (row.childCount ?? row.subdomainCount ?? row.childrenCount ?? 0) : 0)), 0);
    return fromTree > 0 ? fromTree : Math.max(0, visibleDomains.length - result.totalGroups);
  }, [tree, collapsed, visibleDomains.length, result.totalGroups]);
  const readable = ['ready', 'stale'].includes(domains.status);
  const resolveTasks = useMemo(() => createWebsiteTaskResolver({ domains, websites, applications, canManage, isOwner }), [domains, websites, applications, canManage, isOwner]);
  function filter(name, value) {
    setParams((current) => siteListFilterParams(current, name, value), { replace: name === 'q' });
  }
  function toggle(id) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const websiteCount = websites.status === 'ready' ? new Set(websites.items.map(site => site.id)).size : null;
  const isSuspended = session?.user?.active === false || hostingProfile?.active === false;
  const isQuotaReached = hostingProfile?.quotas?.maxWebsites !== null && hostingProfile?.quotas?.maxWebsites !== undefined && websiteCount >= hostingProfile.quotas.maxWebsites;

  return <>
    {customerId && <p className="ws-notice" role="status">{customer ? `${customer.username} hesabının web siteleri` : customerError ? 'Müşteri siteleri doğrulanamadı.' : 'Müşterinin web siteleri yükleniyor…'} <Link to="/websites">Tüm siteler</Link></p>}
    <ErrorNotice error={customerError} />
    <PageHeading title={isReseller ? 'Sitelerim' : 'Web Siteleri'} description={isReseller ? 'Müşterilerinize ait web sitelerini ve yayın araçlarını yönetin.' : isCustomer ? 'Web sitenizin dosya, e-posta ve veritabanı araçlarını buradan yönetin.' : 'Barındırılan web siteleri, alt alan adları ve yayın araçları.'} actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button>{isOwner && canManage && <LinkButton to="/docker" icon="box">Uygulama Marketi</LinkButton>}{isOwner && canManage && <LinkButton to="/websites/new" icon="plus" variant="primary">Web sitesi ekle</LinkButton>}{isOwner && canManage && <LinkButton to="/websites/new?mode=subdomain" icon="plus">Alt alan adı ekle</LinkButton>}{isReseller && <LinkButton to="/customers" icon="user" variant="primary">Müşterilerim</LinkButton>}</>} />
    {isOwner && canManage && <WebsiteRemovalRecoveryPanel onChanged={refreshAll} />}
    {isCustomer && (
      <Section title="Barındırma Kaynakları ve Kotalar" description="Hesabınıza tahsis edilen kaynak kullanım durumu">
        {isSuspended && (
          <div className="ws-notice ws-notice-danger" role="alert">
            <strong>Kaynaklar Kilitli:</strong> Hesabınız askıya alınmıştır ve barındırma kaynaklarınız kilitli durumdadır. Yeniden etkinleştirmek için bayinizle iletişime geçin.
          </div>
        )}
        {isQuotaReached && (
          <div className="ws-notice ws-notice-warning" role="alert">
            <strong>Kota Sınırı:</strong> Web sitesi kotanız ({websiteCount ?? 'Ölçülmedi'} / {hostingProfile.quotas.maxWebsites}) sınırına ulaşmıştır. Yeni site talepleri için bayinizle iletişime geçin.
          </div>
        )}
        <div className="ws-quota-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: '1rem' }}>
          <div style={{ padding: '0.75rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)' }}>
            <span className="ws-muted" style={{ fontSize: '0.85rem' }}>Web Siteleri</span>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.25rem' }}>
              {websiteCount ?? 'Ölçülmedi'} / {hostingProfile?.quotas?.maxWebsites ?? 'Sınırsız'}
            </div>
          </div>
          <div style={{ padding: '0.75rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)' }}>
            <span className="ws-muted" style={{ fontSize: '0.85rem' }}>Disk Alanı</span>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.25rem' }}>
              {hostingProfile?.usage?.diskMb !== undefined && hostingProfile?.usage?.diskMb !== null ? `${hostingProfile.usage.diskMb} MB` : '—'} / {hostingProfile?.quotas?.maxDiskMb != null ? hostingProfile.quotas.maxDiskMb + ' MB' : 'Sınırsız'}
            </div>
          </div>
          <div style={{ padding: '0.75rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)' }}>
            <span className="ws-muted" style={{ fontSize: '0.85rem' }}>Aylık Trafik</span>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.25rem' }}>
              {hostingProfile?.usage?.trafficMb !== undefined && hostingProfile?.usage?.trafficMb !== null ? `${hostingProfile.usage.trafficMb} MB` : '—'} / {hostingProfile?.quotas?.maxTrafficMb != null ? hostingProfile.quotas.maxTrafficMb + ' MB' : 'Sınırsız'}
            </div>
          </div>
          <div style={{ padding: '0.75rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)' }}>
            <span className="ws-muted" style={{ fontSize: '0.85rem' }}>Veritabanları</span>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.25rem' }}>
              {hostingProfile?.usage?.databases !== undefined && hostingProfile?.usage?.databases !== null ? hostingProfile.usage.databases : '—'} / {hostingProfile?.quotas?.maxDatabases != null ?? 'Sınırsız'}
            </div>
          </div>
        </div>
      </Section>
    )}
    <Section className={`ws-site-table ws-site-table-${preferences.density} ws-site-list`} title="Siteler ve alt alan adları" description={readable ? `${result.totalGroups} ana alan adı · ${subdomainsCount} alt alan adı` : 'Site listesi hazırlanıyor.'}>
      <div className="ws-filters">
        <label className="ws-filter-search">Site ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Alan adı veya alias" /></label>
        <label>Durum<select value={status} onChange={(event) => filter('status', event.target.value)}><option value="all">Tüm durumlar</option><option value="active">Aktif</option><option value="draft">Taslak</option><option value="staged">Hazırlandı</option><option value="error">Hata</option></select></label>
        <details className="ws-list-options"><summary>Görünüm ve filtreler</summary><div className="ws-filter-options">
          <label>Tür<select value={type} onChange={(event) => filter('type', event.target.value)}><option value="all">Tüm türler</option><option value="proxy">Uygulama / Proxy</option><option value="static">Statik site</option><option value="redirect">Yönlendirme</option></select></label>
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
      {domains.status === 'ready' && !domains.items.length ? <EmptyState title="Henüz web sitesi yok" detail={isOwner ? 'İlk sitenizin alan adını, uygulama türünü ve HTTPS tercihini belirleyin.' : isReseller ? 'Müşterilerinize henüz bir web sitesi tahsis edilmedi. Müşteriler sayfasından yeni site tahsis edebilirsiniz.' : 'Hesabınıza bağlı siteler burada görünecek.'} icon="globe" action={isOwner && canManage ? <LinkButton to="/websites/new" variant="primary" icon="plus">İlk siteyi ekle</LinkButton> : isReseller ? <LinkButton to="/customers" variant="primary" icon="user">Müşterilere git</LinkButton> : null} /> : readable && <>
        {result.rows.length > 0 && <ul className="ws-website-task-list" aria-label="Siteler ve alt alan adları">
          {result.rows.map((row) => <li key={row.domain.id}><WebsiteTaskCard row={row} tasks={resolveTasks(row.domain.id)} certificates={certificates} filtering={filtering} onToggle={toggle} /></li>)}
        </ul>}
        {!result.rows.length && domains.items.length > 0 && <EmptyState title="Eşleşen alan adı bulunamadı" detail="Arama terimini veya filtreleri değiştirin." icon="search" action={<Button onClick={() => setParams((current) => clearSiteListFilters(current))}>Filtreleri temizle</Button>} />}
        {domains.items.length > 0 && <footer className="ws-pagination"><span>{result.totalGroups} ana alan adı · {subdomainsCount} alt alan adı</span><div className="ws-actions"><Button disabled={result.page <= 1} onClick={() => filter('page', String(result.page - 1))}>Önceki</Button><span>{result.page} / {result.pageCount}</span><Button disabled={result.page >= result.pageCount} onClick={() => filter('page', String(result.page + 1))}>Sonraki</Button></div></footer>}
      </>}
    </Section>
  </>;
}
