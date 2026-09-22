import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, formatBytes, formatDate, siteHref } from './site-model.js';
import { knownCount } from './resource-model.js';
const percent = (used, total) => Number.isFinite(used) && Number.isFinite(total) && total > 0 ? used / total * 100 : null;
function UsageRing({ label, value, detail }) {
  const valid = Number.isFinite(value) && value >= 0 && value <= 100;
  const rounded = valid ? Math.round(value) : null;
  return <div className="ws-usage-metric"><div className={`ws-usage-ring ${rounded >= 85 ? 'is-high' : ''} ${!valid ? 'is-unknown' : ''}`}
    style={{ '--usage': valid ? `${value}%` : '0%' }} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded ?? undefined}
    aria-valuetext={valid ? `%${rounded}` : 'Bilinmiyor'}><strong>{valid ? `%${rounded}` : '—'}</strong></div>
    <span>{label}</span><small>{detail}</small></div>;
}
export function ServerSummary({ server }) {
  const inventory = server.inventory ?? {}; const memory = inventory.memory ?? {}; const disk = inventory.filesystem ?? {};
  return <article className="ws-mini-server"><header><div><h3>{server.displayName ?? server.name ?? server.hostname}</h3><small className="ws-muted">{server.hostname}</small></div><Badge state={server.connectivity} /></header><div className="ws-server-metrics">
    <UsageRing label="CPU" value={inventory.cpu?.usagePercent} detail={`${inventory.cpu?.count ?? '—'} çekirdek`} />
    <UsageRing label="Bellek" value={percent(memory.usedBytes, memory.totalBytes)} detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`} />
    <UsageRing label="Disk" value={percent(disk.usedBytes, disk.totalBytes)} detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`} />
  </div><p className="ws-muted">{inventory.operatingSystem?.prettyName ?? 'Sistem bilgisi bekleniyor'} · Son bildirim {formatDate(server.lastSeenAt)}</p></article>;
}
export default function DashboardPage() {
  const { domains, applications, servers, certificates, jobs, refreshAll } = useWorkspace();
  const hasCerts = certificates.status === 'ready' && domains.status === 'ready';
  const warnings = hasCerts ? domains.items.map((domain) => ({ domain, ssl: certificateState(domain, certificates.items) })).filter(({ ssl }) => ['warning', 'expired', 'error'].includes(ssl.state)) : [];
  const activeJobs = knownCount(jobs, (job) => ['queued', 'running'].includes(job.status));
  const metrics = [
    ['Web sitesi kayıtları', knownCount(domains), 'Ana ve alt alan adları', 'globe'],
    ['Uygulamalar', knownCount(applications), 'Node.js ve statik yayınlar', 'code'],
    ['Devam eden işler', activeJobs, 'Sıradaki ve çalışan işlemler', 'jobs'],
    ['SSL uyarıları', hasCerts ? warnings.length : null, 'Süre veya sertifika hataları', 'shield'],
  ];
  const failedJobs = knownCount(jobs, (job) => job.status === 'failed');
  return <>
    <PageHeading title="Genel bakış" description="Web sitelerinizin, uygulamalarınızın ve sunucunuzun çalışma durumu." actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button><LinkButton to="/websites/new" variant="primary" icon="plus">Web sitesi ekle</LinkButton></>} />
    <section className="ws-metrics" aria-label="Yönetim özeti">{metrics.map(([label, value, detail, icon]) => <article className="ws-metric" key={label}><div className="ws-metric-label"><span>{label}</span><Icon name={icon} /></div><strong>{value ?? '—'}</strong><small>{detail}</small></article>)}</section>
    <div className="ws-two-columns"><Section title="Web siteleri" actions={<Link to="/websites">Web sitelerini aç</Link>}><CollectionNotice resource={domains} label="Web siteleri" /><div className="ws-section-body"><strong className="ws-site-count">{knownCount(domains) ?? '—'}</strong><p className="ws-muted">Kayıtlı ana alan adları ve alt alan adları</p>{domains.status === 'ready' && domains.items.length === 0 && <LinkButton to="/websites/new">İlk siteyi oluştur</LinkButton>}</div></Section><Section title="Sunucu özeti" actions={<Link to="/servers">Sunucuya git</Link>}><CollectionNotice resource={servers} label="Sunucu" />{servers.items.slice(0, 1).map((server) => <ServerSummary key={server.id} server={server} />)}{!servers.items.length && servers.status === 'ready' && <EmptyState title="Sunucu kaydı yok" detail="Kurulu sunucunun kimliğini doğrulayın." icon="server" />}</Section></div>
    <div className="ws-two-columns"><Section title="İşlemler" actions={<Link to="/jobs">İşlem geçmişi</Link>}><CollectionNotice resource={jobs} label="İşler" /><div className="ws-section-body"><strong>{activeJobs ?? '—'}</strong> devam eden · <strong>{failedJobs ?? '—'}</strong> başarısız işlem<p className="ws-muted">Ayrıntı ve güvenli hata nedenleri işlem geçmişinde.</p></div></Section><Section title="Kontrol edilmesi gerekenler"><CollectionNotice resource={certificates} label="Sertifikalar" />
      {warnings.length ? <div className="ws-alert-list">{warnings.slice(0, 5).map(({ domain, ssl }) => <div className="ws-alert-item" key={domain.id}><Icon name="shield" /><div><strong>{domain.primaryDomain}</strong><p>{ssl.label}</p></div><Link to={siteHref(domain.id, 'ssl')}>İncele</Link></div>)}</div> : hasCerts ? <EmptyState icon="check" title="Sertifika uyarısı yok" detail="Okunan sertifika kayıtlarında yaklaşan süre sonu veya hata bulunmadı. Bu, sitelerin dışarıdan erişilebilirlik testi değildir." /> : null}
    </Section></div>
  </>;
}
