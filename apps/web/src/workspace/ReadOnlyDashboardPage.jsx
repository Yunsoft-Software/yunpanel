import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, siteHref } from './site-model.js';
import { knownCount } from './resource-model.js';
import { readableItems, usagePercent } from './ui/console-model.js';
import { ServerSummary } from './DashboardPage.jsx';

export default function ReadOnlyDashboardPage() {
  const { domains, applications, certificates, servers, refreshAll } = useWorkspace();
  const certsReadable = ['ready', 'stale'].includes(certificates.status) && ['ready', 'stale'].includes(domains.status);
  const certs = certsReadable ? certificates.items : [];
  const warnings = certsReadable
    ? domains.items.map((domain) => ({ domain, ssl: certificateState(domain, certs) })).filter(({ ssl }) => ['warning', 'expired', 'error'].includes(ssl.state))
    : [];
  const server = readableItems(servers)[0];
  const disk = server?.inventory?.filesystem;
  const diskUsage = usagePercent(disk?.usedBytes, disk?.totalBytes);
  const metrics = [
    ['Web siteleri', knownCount(domains), 'Kayıtlı web siteleri', 'globe', '/websites', 'Siteleri aç'],
    ['Uygulamalar', knownCount(applications), 'Salt okunur uygulama envanteri', 'code', '/websites', 'Site yönetimi'],
    ['Sunucular', knownCount(servers), 'Kayıtlı sistemler', 'server', '/servers', 'Sunucuları aç'],
    ['SSL uyarıları', certsReadable ? warnings.length : null, 'Sertifika kayıtlarındaki uyarılar', 'shield', '/websites', 'Siteleri incele'],
  ];
  return <>
    <PageHeading title="Genel bakış" description="Read Only hesabı: envanter ve çalışma durumu görüntülenir; yönetim işlemleri kapalıdır." actions={<button type="button" className="ws-button" onClick={refreshAll}><Icon name="refresh" />Yenile</button>} />
    <section className="ws-metrics ws-console-metrics" aria-label="Salt okunur özet">{metrics.map(([label, value, detail, icon, to, linkLabel]) => <article className="ws-metric" key={label}><div className="ws-metric-label"><span>{label}</span><Icon name={icon} /></div><strong>{value ?? '—'}</strong><small>{detail}</small>{to && <><br /><Link to={to} aria-label={`${label}: ${linkLabel}`}>{linkLabel}<Icon name="arrow" size={14} /></Link></>}</article>)}</section>
    {diskUsage !== null && diskUsage >= 90 ? (
      <div className="ws-notice ws-notice-error" role="alert" aria-live="assertive"><Icon name="alert" /><div><strong>Kritik disk doluluğu · %{Math.round(diskUsage)}</strong><p>Disk alanı kritik seviyede (%90 üzeri). Sistem yöneticisiyle iletişime geçin.</p></div></div>
    ) : diskUsage !== null && diskUsage >= 85 ? (
      <div className="ws-notice ws-notice-warn" role="alert" aria-live="polite"><Icon name="alert" /><div><strong>Disk alanı azalıyor · %{Math.round(diskUsage)}</strong><p>Kullanılabilir disk alanı azalıyor.</p></div></div>
    ) : null}
    <div className="ws-two-columns">
      <Section title="Web siteleri" description="Kayıtlı web siteleri ve alan adları." actions={<Link to="/websites" aria-label="Web siteleri listesine git">Web sitelerini aç</Link>}><CollectionNotice resource={domains} label="Web siteleri" />
        <div className="ws-section-body">
          <strong className="ws-site-count">{knownCount(domains) ?? '—'}</strong>
          <p className="ws-muted">Kayıtlı ana alan adları ve alt alan adları</p>
          <div className="ws-actions">
            <LinkButton to="/websites" aria-label="Web siteleri listesini aç">Web sitelerini aç</LinkButton>
          </div>
        </div>
      </Section>
      <Section title="Sunucu özeti" actions={<Link to="/servers">Sunucular</Link>}><CollectionNotice resource={servers} label="Sunucular" />{servers.items.slice(0, 2).map((server) => <ServerSummary key={server.id} server={server} />)}{!servers.items.length && servers.status === 'ready' && <EmptyState title="Sunucu kaydı yok" detail="Kayıtlı sunucu bulunamadı." icon="server" />}</Section>
    </div>
    <Section title="Kontrol edilmesi gereken sertifikalar"><CollectionNotice resource={certificates} label="Sertifikalar" />
      {warnings.length ? <div className="ws-alert-list" aria-label="SSL sertifika uyarıları">{warnings.slice(0, 8).map(({ domain, ssl }) => <div className="ws-alert-item" key={domain.id}><Icon name="shield" /><div><strong>{domain.primaryDomain}</strong><p>{ssl.label}</p></div><Link to={siteHref(domain.id)}>Görüntüle</Link></div>)}</div> : certsReadable ? <EmptyState icon="check" title="Sertifika uyarısı yok" detail="Okunan sertifika kayıtlarında yaklaşan süre sonu veya hata bulunmadı." /> : null}
    </Section>
  </>;
}
