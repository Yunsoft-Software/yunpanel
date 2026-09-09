import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, CollectionNotice, EmptyState, Icon, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, siteHref } from './site-model.js';
import { knownCount } from './resource-model.js';
import { ServerSummary } from './DashboardPage.jsx';

export default function ReadOnlyDashboardPage() {
  const { domains, applications, certificates, servers, refreshAll } = useWorkspace();
  const hasCerts = certificates.status === 'ready' && domains.status === 'ready';
  const warnings = hasCerts
    ? domains.items.map((domain) => ({ domain, ssl: certificateState(domain, certificates.items) })).filter(({ ssl }) => ['warning', 'expired', 'error'].includes(ssl.state))
    : [];
  const metrics = [
    ['Web sitesi kayıtları', knownCount(domains), 'Ana ve alt alan adları', 'globe'],
    ['Uygulamalar', knownCount(applications), 'Salt okunur uygulama envanteri', 'code'],
    ['Sunucular', knownCount(servers), 'Kayıtlı sistemler', 'server'],
    ['SSL uyarıları', hasCerts ? warnings.length : null, 'Sertifika kayıtlarındaki uyarılar', 'shield'],
  ];
  return <>
    <PageHeading title="Genel bakış" description="Read Only hesabı: envanter ve çalışma durumu görüntülenir; yönetim işlemleri kapalıdır." actions={<button type="button" className="ws-button" onClick={refreshAll}><Icon name="refresh" />Yenile</button>} />
    <section className="ws-metrics" aria-label="Salt okunur özet">{metrics.map(([label, value, detail, icon]) => <article className="ws-metric" key={label}><div className="ws-metric-label"><span>{label}</span><Icon name={icon} /></div><strong>{value ?? '—'}</strong><small>{detail}</small></article>)}</section>
    <div className="ws-two-columns">
      <Section title="Web siteleri" description="Detayları görüntülemek için siteyi açın." actions={<Link to="/websites">Tümünü gör</Link>}><CollectionNotice resource={domains} label="Web siteleri" />
        {domains.items.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Alan adı</th><th>Hedef</th><th>Durum</th><th>SSL</th></tr></thead><tbody>{domains.items.slice(0, 6).map((domain) => { const ssl = certificateState(domain, hasCerts ? certificates.items : null); return <tr key={domain.id}><td><Link to={siteHref(domain.id)}><strong>{domain.primaryDomain}</strong></Link><small>{domain.parentDomainId ? 'Alt alan adı' : 'Ana kayıt'}</small></td><td>{domain.targetType === 'proxy' ? 'Uygulama' : 'Statik'}</td><td><Badge state={domain.state} /></td><td><Badge state={ssl.state}>{ssl.label}</Badge></td></tr>; })}</tbody></table></div> : domains.status === 'ready' && <EmptyState icon="globe" title="Web sitesi kaydı yok" detail="Bu hesap yeni kayıt oluşturamaz." />}
      </Section>
      <Section title="Sunucu özeti" actions={<Link to="/servers">Sunucular</Link>}><CollectionNotice resource={servers} label="Sunucular" />{servers.items.slice(0, 2).map((server) => <ServerSummary key={server.id} server={server} />)}{!servers.items.length && servers.status === 'ready' && <EmptyState title="Sunucu kaydı yok" detail="Kayıtlı sunucu bulunamadı." icon="server" />}</Section>
    </div>
    <Section title="Kontrol edilmesi gereken sertifikalar"><CollectionNotice resource={certificates} label="Sertifikalar" />
      {warnings.length ? <div className="ws-alert-list">{warnings.slice(0, 8).map(({ domain, ssl }) => <div className="ws-alert-item" key={domain.id}><Icon name="shield" /><div><strong>{domain.primaryDomain}</strong><p>{ssl.label}</p></div><Link to={siteHref(domain.id)}>Görüntüle</Link></div>)}</div> : hasCerts ? <EmptyState icon="check" title="Sertifika uyarısı yok" detail="Okunan sertifika kayıtlarında yaklaşan süre sonu veya hata bulunmadı." /> : null}
    </Section>
  </>;
}
