import { useEffect, useMemo, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { readHostingAccount, hostingAccountMessage } from './hosting-account-client.js';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { usePanelSession } from '../panel-session.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, Badge, CollectionNotice, EmptyState, ErrorNotice, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { filterWebsiteListDomains, siteListPage } from './site-list-model.js';
import { siteHref } from './site-model.js';
import { createWebsiteTaskResolver, siteListFilterParams, clearSiteListFilters } from './website-task-model.js';
import { buildCustomerQuotaSnapshot, buildCustomerSiteQuotaBreakdown } from './quota-model.js';
import { buildCustomerNextActions, buildOwnerNextActions, buildResellerNextActions } from './next-actions-model.js';
import WebsiteTaskCard from './WebsiteTaskCard.jsx';
import WebsiteRemovalRecoveryPanel from './WebsiteRemovalRecoveryPanel.jsx';
import { useWebsitePreferences } from './useWebsitePreferences.js';
import './website-preferences.css';
import './ui/console-lists.css';
import './ui/website-task-cards.css';

export default function WebsitesPage() {
  const { domains, websites, applications, certificates, servers, jobs, isOwner, isReseller, isCustomer, hostingProfile, canManage, refreshAll } = useWorkspace();
  const { session } = usePanelSession();
  const [params, setParams] = useSearchParams();
  const { preferences, change: changePreferences, saved } = useWebsitePreferences();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const customerId = isOwner ? params.get('customer') : null;
  const selfAccountId = isCustomer ? (session?.user?.id ?? null) : null;
  const [customer, setCustomer] = useState(null), [customerError, setCustomerError] = useState(null);
  const [selfAccount, setSelfAccount] = useState(null);
  const lastSelfAccountId = useRef(selfAccountId);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setCustomer(null); setCustomerError(null);
    if (customerId) panelRequest(`/users/hosting/accounts/${encodeURIComponent(customerId)}`, { signal: controller.signal }).then(value => {
      const account = readHostingAccount(value);
      if (account.id !== customerId || account.kind !== 'customer' || !account.websiteIds) throw Object.assign(new Error('Unknown customer sites'), { code: 'hosting_result_invalid' });
      if (active) setCustomer(account);
    }).catch(error => { if (active && error.name !== 'AbortError') setCustomerError(hostingAccountMessage(error)); });
    return () => { active = false; controller.abort(); };
  }, [customerId]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    if (lastSelfAccountId.current !== selfAccountId) {
      lastSelfAccountId.current = selfAccountId;
      setSelfAccount(null);
    }
    if (!selfAccountId) { setSelfAccount(null); return () => { active = false; controller.abort(); }; }
    panelRequest(`/users/hosting/accounts/${encodeURIComponent(selfAccountId)}`, { signal: controller.signal }).then(value => {
      const account = readHostingAccount(value);
      if (active && account.id === selfAccountId && account.kind === 'customer') setSelfAccount(account);
    }).catch(() => { /* Keep previous verified state or pending indicator; never fabricate usage. */ });
    return () => { active = false; controller.abort(); };
  }, [selfAccountId, websites.status, domains.status, websites.items.length, domains.items.length]);

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
  const isSuspended = session?.user?.active === false || selfAccount?.active === false || hostingProfile?.active === false;
  const customerQuota = useMemo(
    () => (isCustomer ? buildCustomerQuotaSnapshot({ hostingProfile, account: selfAccount }) : null),
    [isCustomer, hostingProfile, selfAccount],
  );
  const isQuotaReached = Boolean((selfAccount?.quotas ?? hostingProfile?.quotas) && customerQuota?.isWebsiteQuotaFull);
  const customerSiteBreakdown = useMemo(
    () => (isCustomer ? buildCustomerSiteQuotaBreakdown(websites.items, visibleDomains) : []),
    [isCustomer, websites.items, visibleDomains],
  );
  const ownerNextActions = useMemo(
    () => (isOwner && canManage ? buildOwnerNextActions({ domains, websites, certificates, servers, jobs }) : null),
    [isOwner, canManage, domains, websites, certificates, servers, jobs],
  );
  const resellerNextActions = useMemo(
    () => (isReseller && !isOwner ? buildResellerNextActions({ domains }) : null),
    [isReseller, isOwner, domains],
  );
  const customerNextActions = useMemo(
    () => (isCustomer ? buildCustomerNextActions({ domains: visibleDomains, certificates }) : null),
    [isCustomer, visibleDomains, certificates],
  );

  return <>
    {customerId && <p className="ws-notice" role="status">{customer ? `${customer.username} hesabının web siteleri` : customerError ? 'Müşteri siteleri doğrulanamadı.' : 'Müşterinin web siteleri yükleniyor…'} <Link to="/websites">Tüm siteler</Link></p>}
    <ErrorNotice error={customerError} />
    <PageHeading title={isReseller ? 'Sitelerim' : 'Web Siteleri'} description={isReseller ? 'Müşterilerinize ait web sitelerini ve yayın araçlarını yönetin.' : isCustomer ? 'Web sitenizin dosya, e-posta ve veritabanı araçlarını buradan yönetin.' : 'Barındırılan web siteleri, alt alan adları ve yayın araçları.'} actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button>{isOwner && canManage && <LinkButton to="/websites/new" icon="plus" variant="primary">Web sitesi ekle</LinkButton>}{isOwner && canManage && <LinkButton to="/websites/new?mode=subdomain" icon="plus">Alt alan adı ekle</LinkButton>}{isReseller && <LinkButton to="/customers" icon="user" variant="primary">Müşterilerim</LinkButton>}</>} />
    {isOwner && canManage && <WebsiteRemovalRecoveryPanel onChanged={refreshAll} />}
    {isOwner && canManage && ownerNextActions && (
      <Section
        title="Öncelikli durum ve sonraki adımlar"
        description="Sunucu sağlığı, dikkat gerektiren siteler ve hızlı yönetim girişleri"
        actions={<div className="ws-actions">{ownerNextActions.quickEntries.map((entry) => <LinkButton key={entry.to} to={entry.to} icon={entry.icon}>{entry.label}</LinkButton>)}</div>}
      >
        <div className="ws-section-body" data-next-actions="owner">
          {ownerNextActions.items.length > 0 ? (
            <div className="ws-alert-list" aria-label="Öncelikli yönetici adımları">
              {ownerNextActions.items.map((item) => (
                <div className="ws-alert-item" key={item.id}>
                  <Icon name={item.severity === 'danger' || item.severity === 'warning' ? 'alert' : 'globe'} />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <LinkButton to={item.to} variant={item.severity === 'danger' ? 'primary' : 'secondary'}>{item.cta}</LinkButton>
                </div>
              ))}
            </div>
          ) : (
            <div className="ws-health-clear">
              <Icon name="check" />
              <span>Acil müdahale gerektiren sunucu veya site uyarısı görünmüyor.</span>
            </div>
          )}
        </div>
      </Section>
    )}
    {isReseller && !isOwner && resellerNextActions && resellerNextActions.items.length > 0 && (
      <Section title="Sonraki adımlar" description="Müşterileriniz ve barındırılan siteler için önerilen işlemler">
        <div className="ws-section-body" data-next-actions="reseller">
          <div className="ws-alert-list" aria-label="Bayi sonraki adımları">
            {resellerNextActions.items.map((item) => (
              <div className="ws-alert-item" key={item.id}>
                <Icon name="globe" />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
                {item.to && <LinkButton to={item.to} variant="primary">{item.cta}</LinkButton>}
              </div>
            ))}
          </div>
        </div>
      </Section>
    )}
    {isCustomer && customerQuota && (
      <Section
        title="Barındırma Kaynakları ve Kotalar"
        description={`${customerQuota.managementContext.label} · ${customerQuota.measurementLabel}`}
      >
        <div className="ws-section-body" data-customer-quotas="true">
          <p className="ws-muted" data-customer-management={customerQuota.managementContext.kind}>
            <strong>{customerQuota.managementContext.label}:</strong> {customerQuota.managementContext.detail}
          </p>
          {isSuspended && (
            <div className="ws-notice ws-notice-danger" role="alert">
              <strong>Kaynaklar Kilitli:</strong> Hesabınız askıya alınmıştır ve yeni kaynak işlemleri kilitlidir. {customerQuota.managementContext.detail}
            </div>
          )}
          {isQuotaReached && (
            <div className="ws-notice ws-notice-warning" role="alert">
              <strong>Kota Sınırı:</strong> Web sitesi kotanız ({customerQuota.websites.summaryText}) sınırına ulaşmıştır. {customerQuota.managementContext.detail}
            </div>
          )}
          <div data-quota-group="enforced" style={{ marginBottom: customerQuota.unmeasured.length > 0 ? '0.85rem' : 0 }}>
            <p className="ws-muted" style={{ marginBottom: '0.45rem', fontSize: '0.85rem' }}>
              {customerQuota.enforced.length > 1 ? 'Uygulanan kotalar' : 'Uygulanan kota'}
            </p>
            <div className="ws-quota-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '1rem', alignItems: 'stretch' }}>
              {customerQuota.enforced.map((metric) => (
                <div
                  key={metric.key}
                  data-quota-metric={metric.key}
                  data-quota-status={metric.status}
                  data-quota-enforced="true"
                  style={{ padding: '0.85rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.4rem' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <span className="ws-muted" style={{ fontSize: '0.85rem' }}>{metric.label}</span>
                    <Badge state={metric.badgeState}>{metric.badgeLabel}</Badge>
                  </div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 600 }}>
                    {metric.measured ? metric.summaryText : metric.usageText}
                  </div>
                  <small className="ws-muted">{metric.detailText}</small>
                </div>
              ))}
            </div>
          </div>
          {customerQuota.unmeasured.length > 0 && (
            <div data-quota-group="unmeasured">
              <p className="ws-muted" style={{ marginBottom: '0.45rem', fontSize: '0.85rem' }}>
                {customerQuota.unmeasured.some((metric) => metric.measured)
                  ? 'Kayıtlı kaynak sınırları · Otomatik uygulanmıyor'
                  : 'Kayıtlı kaynak sınırları · Otomatik ölçülmüyor ve uygulanmıyor'}
              </p>
              <div className="ws-quota-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: '1rem', alignItems: 'stretch' }}>
                {customerQuota.unmeasured.map((metric) => (
                  <div
                    key={metric.key}
                    data-quota-metric={metric.key}
                    data-quota-status={metric.status}
                    data-quota-enforced="false"
                    style={{ padding: '0.85rem', background: 'var(--ws-surface-subtle)', border: '1px solid var(--ws-border)', borderRadius: 'var(--ws-radius-small, 9px)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.4rem' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span className="ws-muted" style={{ fontSize: '0.85rem' }}>{metric.label}</span>
                      <Badge state={metric.badgeState}>{metric.badgeLabel}</Badge>
                    </div>
                    <div style={{ fontSize: '1.15rem', fontWeight: 600 }}>
                      {metric.measured ? metric.summaryText : metric.usageText}
                    </div>
                    <small className="ws-muted">{metric.detailText}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
          {customerSiteBreakdown.length > 0 && (
            <div data-customer-site-breakdown="true" style={{ marginTop: '1rem' }}>
              <p className="ws-muted" style={{ marginBottom: '0.5rem' }}>Site bazında kaynak dağılımı</p>
              <ul className="ws-alert-list" aria-label="Site bazında kaynak dağılımı" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {customerSiteBreakdown.map((site) => (
                  <li className="ws-alert-item" key={site.id}>
                    <Icon name="globe" />
                    <div>
                      <strong><Link to={site.href}>{site.name}</Link></strong>
                      <p>{site.runtimeLabel}</p>
                    </div>
                    <div className="ws-actions">
                      {site.domainId && <LinkButton to={siteHref(site.domainId, 'resources')} icon="box">Site Kaynakları</LinkButton>}
                      <Badge state={site.statusState}>{site.statusLabel}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Section>
    )}
    {isCustomer && customerNextActions && (
      <Section
        title="Yapılacak adımlar"
        description={customerNextActions.allClear ? 'Tüm temel yayın kontrolleri tamamlandı' : 'Sitenizi yayına hazırlamak için bekleyen adımlar'}
        actions={customerNextActions.quickLinks.length > 0 ? <div className="ws-actions">{customerNextActions.quickLinks.map((entry) => <LinkButton key={entry.to} to={entry.to} icon={entry.icon}>{entry.label}</LinkButton>)}</div> : undefined}
      >
        <div className="ws-section-body" data-next-actions="customer">
          {customerNextActions.allClear ? (
            <div className="ws-health-clear">
              <Icon name="check" />
              <span>{customerNextActions.summaryText}</span>
            </div>
          ) : customerNextActions.items.length > 0 ? (
            <div className="ws-alert-list" aria-label="Müşteri yapılacak adımları">
              {customerNextActions.items.map((item) => (
                <div className="ws-alert-item" key={item.id}>
                  <Icon name={item.severity === 'danger' || item.severity === 'warning' ? 'alert' : 'globe'} />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <LinkButton to={item.to} variant="primary">{item.cta}</LinkButton>
                </div>
              ))}
            </div>
          ) : (
            <p className="ws-muted">Hesabınıza ilk web sitesi bağlandığında DNS, SSL, e-posta ve yedekleme adımları burada listelenir.</p>
          )}
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
