import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, selectedApplication, siteHref } from './site-model.js';
import { siteListPage } from './site-list-model.js';
import { useWebsitePreferences } from './useWebsitePreferences.js';
import './website-preferences.css';

export default function WebsitesPage() {
  const { domains, applications, certificates, servers } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const { preferences, change: changePreferences, saved } = useWebsitePreferences();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const query = params.get('q') ?? '';
  const type = params.get('type') ?? 'all';
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') === 'desc' ? 'desc' : 'asc';
  const filtering = Boolean(query.trim()) || type !== 'all' || status !== 'all';
  const tree = useMemo(() => domainTreeRows(domains.items, { query, collapsed: filtering ? new Set() : collapsed }), [domains.items, query, filtering, collapsed]);
  const result = siteListPage(tree, { type, status, sort, perPage: preferences.perPage, page: Number(params.get('page') ?? 1) });
  function filter(name, value) {
    setParams((current) => { const next = new URLSearchParams(current); if (value && value !== 'all') next.set(name, value); else next.delete(name); if (name !== 'page') next.delete('page'); return next; }, { replace: name === 'q' });
  }
  function toggle(id) {
    setCollapsed((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const certs = ['ready', 'stale'].includes(certificates.status) ? certificates.items : null;
  return <>
    <PageHeading title="Web siteleri" description="Alan adlarınızı, alt alan adlarınızı ve site işlemlerini tek yerden yönetin." actions={<LinkButton to="/websites/new" icon="plus" variant="primary">Web sitesi ekle</LinkButton>} />
    <Section className={`ws-site-table ws-site-table-${preferences.density}`} title="Siteler ve alt alan adları" description="Bir alan adına tıklayarak uygulama, SSL ve yayın ayarlarına geçin." actions={<Button icon="refresh" onClick={domains.refresh}>Yenile</Button>}>
      <div className="ws-filters">
        <label className="ws-filter-search">Alan adı veya alias ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="ör. api.example.com" /></label>
        <label>Tür<select value={type} onChange={(event) => filter('type', event.target.value)}><option value="all">Tüm türler</option><option value="proxy">Uygulama / Proxy</option><option value="static">Statik site</option></select></label>
        <label>Durum<select value={status} onChange={(event) => filter('status', event.target.value)}><option value="all">Tüm durumlar</option><option value="active">Aktif</option><option value="draft">Taslak</option><option value="staged">Hazırlandı</option><option value="error">Hata</option></select></label>
        <label>Sıralama<select value={sort} onChange={(event) => filter('sort', event.target.value)}><option value="asc">Alan adı A–Z</option><option value="desc">Alan adı Z–A</option></select></label>
        <label>Satır aralığı<select value={preferences.density} onChange={(event) => changePreferences({ density: event.target.value })}><option value="comfortable">Rahat</option><option value="compact">Sık</option></select></label>
        <label>Sayfada alan adı grubu<select value={preferences.perPage} onChange={(event) => { changePreferences({ perPage: Number(event.target.value) }); filter('page', '1'); }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
      </div>
      {!saved && <p className="ws-muted ws-view-notice" role="status">Tarayıcı depolaması kullanılamıyor. Görünüm tercihi yalnızca bu ekran açıkken uygulanacak.</p>}
      <CollectionNotice resource={domains} label="Web siteleri" />
      {domains.status === 'ready' && !domains.items.length ? <EmptyState title="Henüz web sitesi yok" detail="İlk alan adınızı ekleyin; uygulama hedefini ve HTTPS tercihini aynı akışta belirleyin." icon="globe" action={<LinkButton to="/websites/new" variant="primary" icon="plus">İlk siteyi ekle</LinkButton>} /> : <>
        {result.rows.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th scope="col">Alan adı</th><th scope="col">Uygulama / hedef</th><th scope="col">Sunucu</th><th scope="col">Durum</th><th scope="col">SSL</th><th scope="col"><span className="ws-sr-only">İşlemler</span></th></tr></thead><tbody>
          {result.rows.map(({ domain, depth, childCount, expanded, warning, contextOnly }) => {
            const application = applications.status === 'ready' ? selectedApplication(domain, applications.items) : null;
            const ssl = certificateState(domain, certs);
            const server = servers.items.find((item) => item.id === domain.serverId);
            return <tr key={domain.id} className={contextOnly ? 'ws-context-row' : ''}>
              <td><div className="ws-domain-name" style={{ '--ws-depth': Math.min(depth, 3) }}>
                {childCount ? <button className="ws-tree-toggle" type="button" disabled={filtering} aria-expanded={expanded} aria-label={`${domain.primaryDomain} alt alan adlarını ${expanded ? 'daralt' : 'genişlet'}`} onClick={() => toggle(domain.id)}><Icon name="chevron" size={15} /></button> : <span className="ws-tree-spacer" />}
                <span className="ws-domain-symbol"><Icon name="globe" /></span><div><Link to={siteHref(domain.id)}>{domain.primaryDomain}</Link><small>{domain.parentDomainId ? 'Alt alan adı' : 'Ana kayıt'}{domain.aliases?.length ? ` · ${domain.aliases.length} alias` : ''}</small>{warning && <small>Üst kayıt ilişkisini kontrol edin</small>}</div>
              </div></td>
              <td><strong>{application ? `Node.js ${application.runtime?.nodeMajor ?? ''}` : domain.targetType === 'static' ? 'Statik site' : 'Uygulama proxy'}</strong><small>{application?.name ?? (domain.targetType === 'proxy' ? `127.0.0.1:${domain.target?.upstreamPort ?? '—'}` : 'Dosya yayını')}</small></td>
              <td>{server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi yok'}</td>
              <td><Badge state={domain.state} /></td><td><Badge state={ssl.state}>{ssl.label}</Badge></td>
              <td className="ws-row-end"><LinkButton to={siteHref(domain.id)} icon="arrow">Yönet</LinkButton></td>
            </tr>;
          })}
        </tbody></table></div>}
        {!result.rows.length && domains.items.length > 0 && <EmptyState title="Eşleşen alan adı bulunamadı" detail="Arama terimini veya filtreleri değiştirin." icon="search" />}
        {domains.items.length > 0 && <footer className="ws-pagination"><span>{result.totalGroups} alan adı grubu · Alt alan adları üst kaydıyla birlikte gösterilir.</span><div className="ws-actions"><Button disabled={result.page <= 1} onClick={() => filter('page', String(result.page - 1))}>Önceki</Button><span>{result.page} / {result.pageCount}</span><Button disabled={result.page >= result.pageCount} onClick={() => filter('page', String(result.page + 1))}>Sonraki</Button></div></footer>}
      </>}
    </Section>
    <p className="ws-muted">Alan adı eklemek DNS kaydı yayımlamaz. Eski kayıtların üst alan adı ilişkileri otomatik tahmin edilmez. <Link to="/domains">Gelişmiş alan adı araçları</Link></p>
  </>;
}
