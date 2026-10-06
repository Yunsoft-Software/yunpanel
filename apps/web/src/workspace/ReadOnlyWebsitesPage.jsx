import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { domainTreeRows } from '../domain-tree.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, CollectionNotice, EmptyState, Icon, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, selectedApplication, siteHref } from './site-model.js';
import './ui/console-lists.css';

export default function ReadOnlyWebsitesPage() {
  const { domains, applications, certificates, servers } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const rows = useMemo(() => domainTreeRows(domains.items, { query, collapsed: new Set() }), [domains.items, query]);
  const certs = ['ready', 'stale'].includes(certificates.status) ? certificates.items : null;
  return <>
    <PageHeading title="Web siteleri" description="Read Only hesabı: alan adı hiyerarşisi, hedef, sunucu, durum ve SSL bilgileri görüntülenir." />
    <Section title="Siteler ve alt alan adları" description="Bir kayda tıklayarak salt okunur detay ekranını açın.">
      <div className="ws-filters"><label className="ws-filter-search">Alan adı veya alias ara<input type="search" value={query} onChange={(event) => setParams(event.target.value ? { q: event.target.value } : {}, { replace: true })} placeholder="ör. api.example.com" /></label></div>
      <CollectionNotice resource={domains} label="Web siteleri" />
      {rows.length ? <div className="ws-table-scroll"><table className="ws-table ws-websites-table" role="table" aria-label="Web siteleri"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Alan adı</th><th scope="col" role="columnheader">Uygulama / hedef</th><th scope="col" role="columnheader">Sunucu</th><th scope="col" role="columnheader">Durum</th><th scope="col" role="columnheader">SSL</th><th scope="col" role="columnheader" className="ws-row-end"><span className="ws-sr-only">Detay</span></th></tr></thead><tbody role="rowgroup">{rows.map(({ domain, depth, warning }) => {
        const application = applications.status === 'ready' ? selectedApplication(domain, applications.items) : null;
        const ssl = certificateState(domain, certs);
        const server = servers.items.find((item) => item.id === domain.serverId);
        return <tr key={domain.id} role="row">
          <td role="cell" data-label="Alan adı"><div className="ws-domain-name" style={{ '--ws-depth': Math.min(depth, 3) }}><span className="ws-tree-spacer" /><span className="ws-domain-symbol"><Icon name="globe" /></span><div><Link to={siteHref(domain.id)}>{domain.primaryDomain}</Link><small>{domain.parentDomainId ? 'Alt alan adı' : 'Ana kayıt'}{domain.aliases?.length ? ` · ${domain.aliases.length} alias` : ''}</small>{warning && <small>Üst kayıt ilişkisini kontrol edin</small>}</div></div></td>
          <td role="cell" data-label="Uygulama / hedef"><strong>{application ? `Node.js ${application.runtime?.nodeMajor ?? ''}` : domain.targetType === 'static' ? 'Statik site' : 'Uygulama proxy'}</strong><small>{application?.name ?? (domain.targetType === 'proxy' ? `127.0.0.1:${domain.target?.upstreamPort ?? '—'}` : domain.target?.root ?? 'Dosya yayını')}</small></td>
          <td role="cell" data-label="Sunucu">{server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi yok'}</td><td role="cell" data-label="Durum"><Badge state={domain.state} /></td><td role="cell" data-label="SSL"><Badge state={ssl.state}>{ssl.label}</Badge></td><td role="cell" className="ws-row-end" data-label="Detay"><Link className="ws-button" to={siteHref(domain.id)}>Görüntüle</Link></td>
        </tr>;
      })}</tbody></table></div> : domains.status === 'ready' && <EmptyState title={domains.items.length ? 'Eşleşen alan adı bulunamadı' : 'Web sitesi kaydı yok'} detail={domains.items.length ? 'Arama terimini değiştirin.' : 'Bu hesap yeni kayıt oluşturamaz.'} icon={domains.items.length ? 'search' : 'globe'} />}
    </Section>
    <p className="ws-muted">Read Only hesabı alan adı, uygulama, DNS hedefi veya sertifika ayarını değiştiremez.</p>
  </>;
}
