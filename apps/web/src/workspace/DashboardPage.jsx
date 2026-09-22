import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, formatBytes, formatDate, siteHref } from './site-model.js';
import { knownCount } from './resource-model.js';
import { websiteCount } from './ui/ux-model.js';
import { readableItems, usagePercent } from './ui/console-model.js';

function UsageRing({ label, value, detail }) {
  const valid = Number.isFinite(value) && value >= 0 && value <= 100;
  const rounded = valid ? Math.round(value) : null;
  return <div className="ws-usage-metric"><div className={`ws-usage-ring ${valid && value >= 85 ? 'is-high' : ''} ${!valid ? 'is-unknown' : ''}`}
    style={{ '--usage': valid ? `${value}%` : '0%' }} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded ?? undefined}
    aria-valuetext={valid ? `%${rounded}` : 'Bilinmiyor'}><strong>{valid ? `%${rounded}` : '—'}</strong></div>
    <span>{label}</span><small>{detail}</small></div>;
}
export function ServerSummary({ server }) {
  const inventory = server.inventory ?? {};
  const memory = inventory.memory ?? {};
  const disk = inventory.filesystem ?? {};
  return <article className="ws-mini-server"><header><div><h3>{server.displayName ?? server.name ?? server.hostname}</h3><small className="ws-muted">{server.hostname}</small></div><Badge state={server.connectivity} /></header>
    <div className="ws-server-metrics">
      <UsageRing label="CPU" value={inventory.cpu?.usagePercent} detail={`${inventory.cpu?.count ?? '—'} çekirdek`} />
      <UsageRing label="Bellek" value={usagePercent(memory.usedBytes, memory.totalBytes)} detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`} />
      <UsageRing label="Disk" value={usagePercent(disk.usedBytes, disk.totalBytes)} detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`} />
    </div>
    <p className="ws-muted">{inventory.operatingSystem?.prettyName ?? 'Sistem bilgisi bekleniyor'} · Son bildirim {formatDate(server.lastSeenAt)}</p>
  </article>;
}
export default function DashboardPage() {
  const { domains, websites, applications, servers, certificates, jobs, refreshAll, isOwner } = useWorkspace();
  const hasCerts = certificates.status === 'ready' && domains.status === 'ready';
  const warnings = hasCerts ? domains.items.map((domain) => ({ domain, ssl: certificateState(domain, certificates.items) })).filter(({ ssl }) => ['warning', 'expired', 'error'].includes(ssl.state)) : [];
  const activeJobs = knownCount(jobs, (job) => ['queued', 'running'].includes(job.status));
  const failedJobs = knownCount(jobs, (job) => job.status === 'failed');
  const server = readableItems(servers)[0];
  const disk = server?.inventory?.filesystem;
  const diskUsage = usagePercent(disk?.usedBytes, disk?.totalBytes);
  const metrics = [
    ['Web siteleri', websiteCount(websites), 'Bağımsız site çalışma alanı', 'globe', '/websites', 'Siteleri aç'],
    ['Uygulamalar', knownCount(applications), 'Kayıtlı yayın uygulamaları', 'code', '/websites', 'Site yönetimine git'],
    ['Devam eden işler', activeJobs, 'Sıradaki ve çalışan işlemler', 'jobs', '/jobs?status=running', 'İşlemleri aç'],
    ['SSL uyarıları', hasCerts ? warnings.length : null, 'Süre veya sertifika hataları', 'shield', '/websites', 'Siteleri incele'],
  ];
  const quicklinks = [
    ['/websites/new', 'Site ekle', 'Yeni çalışma alanı', 'plus'],
    ['/databases', 'Veritabanları', 'phpMyAdmin ve erişim', 'database'],
    ['/mail', 'Mail hesapları', 'Posta ve webmail', 'mail'],
    isOwner ? ['/servers', 'Sunucu', 'Servisler ve terminal', 'server'] : ['/websites', 'Sitelerim', 'Dosyalar ve uygulamalar', 'globe'],
  ];
  return <>
    <PageHeading title="Genel bakış" description="Sunucunuzun durumu ve günlük yönetim araçları." actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button><LinkButton to="/websites/new" variant="primary" icon="plus">Site ekle</LinkButton></>} />
    <CollectionNotice resource={websites} label="Web siteleri" />
    <CollectionNotice resource={applications} label="Uygulamalar" />
    <section className="ws-metrics ws-console-metrics" aria-label="Yönetim özeti">{metrics.map(([label, value, detail, icon, to, linkLabel]) => <article className="ws-metric" key={label}>
      <div className="ws-metric-label"><span>{label}</span><Icon name={icon} /></div><strong>{value ?? '—'}</strong><small>{detail}</small><br /><Link to={to}>{linkLabel}<Icon name="arrow" size={14} /></Link>
    </article>)}</section>
    {diskUsage !== null && diskUsage >= 85 && <div className="ws-notice ws-notice-warn ws-console-notice" role="alert"><Icon name="alert" /><div><strong>Disk alanı azalıyor · %{Math.round(diskUsage)}</strong><p>Yeni dağıtımlar ve yedekler için kullanılabilir alanı kontrol edin.</p></div>{isOwner && <LinkButton to="/servers">Sunucuyu incele</LinkButton>}</div>}
    <div className="ws-console-grid">
      <Section title="Sunucu kaynakları" description="Son alınan gerçek sunucu ölçümleri." actions={isOwner && <Link to="/servers">Ayrıntılar</Link>}>
        <CollectionNotice resource={servers} label="Sunucu" />
        {server ? <ServerSummary server={server} /> : servers.status === 'ready' && <EmptyState title="Sunucu bilgisi yok" detail="Yerel sunucu envanteri doğrulandığında kaynak kullanımı burada görünür." icon="server" />}
      </Section>
      <Section title="Hızlı işlemler" description="Sık kullandığınız araçlara doğrudan erişin."><div className="ws-console-quicklinks">{quicklinks.map(([to, label, detail, icon]) => <Link className="ws-console-quicklink" key={to} to={to}><Icon name={icon} size={22} /><span>{label}<small>{detail}</small></span></Link>)}</div></Section>
    </div>
    <div className="ws-console-bottom">
      <Section title="Kontrol edilmesi gerekenler" actions={<Link to="/websites">Web siteleri</Link>}>
        <CollectionNotice resource={domains} label="Alan adları" />
        <CollectionNotice resource={certificates} label="Sertifikalar" />
        {warnings.length ? <div className="ws-alert-list">{warnings.slice(0, 5).map(({ domain, ssl }) => <div className="ws-alert-item" key={domain.id}><Icon name="shield" /><div><strong>{domain.primaryDomain}</strong><p>{ssl.label}</p></div><Link to={siteHref(domain.id, 'ssl')}>SSL’i incele</Link></div>)}</div> : hasCerts && <EmptyState icon="check" title="Sertifika uyarısı yok" detail="Okunan sertifika kayıtlarında yaklaşan süre sonu veya hata bulunmadı. Dış erişim kontrolü ayrıca yapılır." />}
      </Section>
      <Section title="İşlem merkezi" actions={<Link to="/jobs">Geçmişi aç</Link>}>
        <CollectionNotice resource={jobs} label="İşlemler" />
        <div className="ws-section-body"><div className="ws-job-summary"><Badge state={activeJobs === null ? 'unknown' : activeJobs > 0 ? 'running' : 'succeeded'}>{activeJobs ?? '—'} devam eden</Badge><Badge state={failedJobs === null ? 'unknown' : failedJobs > 0 ? 'failed' : 'succeeded'}>{failedJobs ?? '—'} başarısız</Badge></div>
          <p className="ws-muted">Dağıtım, SSL ve servis işlemleri arka planda sürer. Bu sayfadan ayrılmanız sunucudaki işi durdurmaz.</p><div className="ws-actions"><LinkButton to="/jobs">İşlemleri takip et</LinkButton>{failedJobs > 0 && <LinkButton to="/jobs?status=failed">Hataları incele</LinkButton>}</div>
        </div>
      </Section>
    </div>
  </>;
}
