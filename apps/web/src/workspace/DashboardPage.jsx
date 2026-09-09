import { Link } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, formatBytes, formatDate, siteHref } from './site-model.js';
import { knownCount } from './resource-model.js';
import JobsTable from './JobsTable.jsx';

const percent = (used, total) => Number.isFinite(used) && Number.isFinite(total) && total > 0 ? `${Math.round(used / total * 100)}%` : '—';
export function ServerSummary({ server }) {
  const inventory = server.inventory ?? {}; const memory = inventory.memory ?? {}; const disk = inventory.filesystem ?? {};
  return <article className="ws-mini-server"><header><div><h3>{server.displayName ?? server.name ?? server.hostname}</h3><small className="ws-muted">{server.hostname}</small></div><Badge state={server.connectivity} /></header><div className="ws-server-metrics">
    <div><span>CPU</span><strong>{Number.isFinite(inventory.cpu?.usagePercent) ? `${Math.round(inventory.cpu.usagePercent)}%` : '—'}</strong><small>{inventory.cpu?.count ?? '—'} çekirdek</small></div>
    <div><span>Bellek</span><strong>{percent(memory.usedBytes, memory.totalBytes)}</strong><small>{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}</small></div>
    <div><span>Disk</span><strong>{percent(disk.usedBytes, disk.totalBytes)}</strong><small>{formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}</small></div>
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
  const recentJobs = [...jobs.items].sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  return <>
    <PageHeading title="Genel bakış" description="Web sitelerinizin, uygulamalarınızın ve sunucunuzun çalışma durumu." actions={<><Button icon="refresh" onClick={refreshAll}>Yenile</Button><LinkButton to="/websites/new" variant="primary" icon="plus">Web sitesi ekle</LinkButton></>} />
    <section className="ws-metrics" aria-label="Yönetim özeti">{metrics.map(([label, value, detail, icon]) => <article className="ws-metric" key={label}><div className="ws-metric-label"><span>{label}</span><Icon name={icon} /></div><strong>{value ?? '—'}</strong><small>{detail}</small></article>)}</section>
    <div className="ws-two-columns"><Section title="Web siteleri" description="İşlem yapmak için siteyi açın." actions={<Link to="/websites">Tümünü gör</Link>}><CollectionNotice resource={domains} label="Web siteleri" />
      {domains.items.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Alan adı</th><th>Hedef</th><th>Durum</th><th>SSL</th></tr></thead><tbody>{domains.items.slice(0, 6).map((domain) => { const ssl = certificateState(domain, hasCerts ? certificates.items : null); return <tr key={domain.id}><td><Link to={siteHref(domain.id)}><strong>{domain.primaryDomain}</strong></Link><small>{domain.parentDomainId ? 'Alt alan adı' : 'Ana kayıt'}</small></td><td>{domain.targetType === 'proxy' ? 'Uygulama' : 'Statik'}</td><td><Badge state={domain.state} /></td><td><Badge state={ssl.state}>{ssl.label}</Badge></td></tr>; })}</tbody></table></div> : domains.status === 'ready' && <EmptyState icon="globe" title="İlk sitenizi ekleyin" detail="Yeni alan adını bir uygulamaya veya statik dosya hedefine bağlayın." action={<LinkButton to="/websites/new">Site oluştur</LinkButton>} />}
    </Section><Section title="Sunucu özeti" actions={<Link to="/servers">Sunucular</Link>}><CollectionNotice resource={servers} label="Sunucular" />{servers.items.slice(0, 2).map((server) => <ServerSummary key={server.id} server={server} />)}{!servers.items.length && servers.status === 'ready' && <EmptyState title="Sunucu kaydı yok" detail="Mevcut kurulumda sunucu kaydını Sunucular bölümünden ekleyin." icon="server" action={<LinkButton to="/servers">Sunuculara git</LinkButton>} />}</Section></div>
    <div className="ws-two-columns"><Section title="Son işlemler" actions={<Link to="/jobs">İşlem geçmişi</Link>}><CollectionNotice resource={jobs} label="İşler" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={recentJobs} limit={6} />}</Section><Section title="Kontrol edilmesi gerekenler"><CollectionNotice resource={certificates} label="Sertifikalar" />
      {warnings.length ? <div className="ws-alert-list">{warnings.slice(0, 5).map(({ domain, ssl }) => <div className="ws-alert-item" key={domain.id}><Icon name="shield" /><div><strong>{domain.primaryDomain}</strong><p>{ssl.label}</p></div><Link to={siteHref(domain.id, 'ssl')}>İncele</Link></div>)}</div> : hasCerts ? <EmptyState icon="check" title="Sertifika uyarısı yok" detail="Okunan sertifika kayıtlarında yaklaşan süre sonu veya hata bulunmadı. Bu, sitelerin dışarıdan erişilebilirlik testi değildir." /> : null}
    </Section></div>
  </>;
}
