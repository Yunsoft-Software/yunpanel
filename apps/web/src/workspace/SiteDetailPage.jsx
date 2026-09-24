import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, ErrorNotice, Icon, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { SITE_TABS, certificateState, externalSiteUrl, matchingApplications, parentTrail, selectedApplication, siteHref, siteJobs, formatDate } from './site-model.js';
import { ApplicationOperations, SslOperations } from './SiteOperations.jsx';
import DomainOperations from './DomainOperations.jsx';
import DomainHostingPanel from './DomainHostingPanel.jsx';
import DnsPanel from './DnsPanel.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import JobsTable from './JobsTable.jsx';
import TerminalPanel from './LazyTerminalPanel.jsx';
import SiteFilesPanel from './SiteFilesPanel.jsx';
import LogsPanel from './LogsPanel.jsx';
import SiteResourcesPanel from './SiteResourcesPanel.jsx';
import SiteCronPanel from './SiteCronPanel.jsx';
import SitePhpToolsPanel from './SitePhpToolsPanel.jsx';
import SiteBackupPanel from './SiteBackupPanel.jsx';
import SiteAnalyticsPanel from './SiteAnalyticsPanel.jsx';
import WebsiteSuspensionPanel from './WebsiteSuspensionPanel.jsx';
import WebsiteRemovalPanel from './WebsiteRemovalPanel.jsx';
import ProvisioningRecoveryPanel from './ProvisioningRecoveryPanel.jsx';
import WebsiteIsolationPanel from './WebsiteIsolationPanel.jsx';
import SiteNavigation from './ui/SiteNavigation.jsx';
import { panelRequest } from '../api.js';

function LegacyWebsiteRepair({ domain, canManage, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function repair() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let preview = await panelRequest('/websites/migration/preview');
      let item = preview.items.find((candidate) => candidate.domainId === domain.id);
      if (!item || item.status !== 'ready') {
        throw new Error(item?.status === 'ambiguous'
          ? 'Bu alan adı için birden fazla uygulama eşleşiyor; önce hedef uygulamayı seçin.'
          : 'Bu alan adı için aynı port ve sunucuda eşleşen bir uygulama bulunamadı.');
      }
      if (item.action === 'create_website_then_bind') {
        await panelRequest('/websites/migration/create-website', { method: 'POST', body: {
          domainId: domain.id, applicationId: item.applicationId, previewDigest: preview.digest,
          confirmation: `create-website:${domain.id}:${item.applicationId}:${preview.digest}`,
        } });
        preview = await panelRequest('/websites/migration/preview');
        item = preview.items.find((candidate) => candidate.domainId === domain.id);
      }
      if (!item || item.status !== 'ready' || item.action !== 'bind_existing_website' || !item.websiteId) {
        throw new Error('Site kaydı oluşturuldu ancak güvenli bağlama planı üretilemedi; sayfayı yenileyip tekrar deneyin.');
      }
      await panelRequest('/websites/migration/bind', { method: 'POST', body: {
        domainId: domain.id, websiteId: item.websiteId, previewDigest: preview.digest,
        confirmation: `bind:${domain.id}:${item.websiteId}:${preview.digest}`,
      } });
      onChanged();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Section title="Site bağlantısı gerekli"><div className="ws-section-body"><ErrorNotice error={error} /><p className="ws-muted">Dosya ve terminal erişimini açmak için bu eski alan adı kaydını yerel uygulamasıyla bağlayın.</p>{canManage && <Button variant="primary" disabled={busy} onClick={repair}>{busy ? 'Site bağlantısı hazırlanıyor…' : 'Site kaydını oluştur ve bağla'}</Button>}</div></Section>;
}
export default function SiteDetailPage() {
  const { websiteId, tab = 'overview' } = useParams();
  return <SiteWorkspace key={websiteId} websiteId={websiteId} tab={tab} />;
}
function SiteWorkspace({ websiteId, tab }) {
  const { domains, websites, applications, certificates, servers, jobs, refreshAll, canManage, isOwner } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const domain = domains.items.find((item) => item.id === websiteId);
  if (!domain) return <><PageHeading title="Web sitesi" /><CollectionNotice resource={domains} label="Alan adı" />{domains.status === 'ready' && <EmptyState title="Web sitesi bulunamadı" detail="Kayıt kaldırılmış olabilir veya bağlantı yanlış bir kimliğe işaret ediyor." icon="globe" action={<LinkButton to="/websites">Web sitelerine dön</LinkButton>} />}</>;
  const website = websites.items.find((item) => item.id === domain.websiteId);
  // Legacy proxy matching is never used to assign a different site's runtime to a site manager.
  const matches = isOwner ? matchingApplications(domain, applications.items) : [];
  const application = applications.items.find((item) => item.id === website?.applicationId)
    ?? (isOwner ? selectedApplication(domain, applications.items, params.get('application')) : null);
  const managedTerminalWebsite = website && ['static', 'node', 'php'].includes(website.runtimeType);
  const legacyManagedTarget = isOwner && !domain.websiteId && Boolean(application);
  const tabs = SITE_TABS.filter(([key]) => {
    if (['node', 'deploy'].includes(key)) return Boolean(application);
    if (key === 'files') return canManage;
    if (key === 'cron') return canManage;
    if (key === 'backup') return canManage && Boolean(website);
    if (key === 'analytics') return canManage && Boolean(website);
    if (key === 'terminal') return canManage && (managedTerminalWebsite || legacyManagedTarget);
    if (['databases', 'mail'].includes(key)) return canManage && Boolean(website);
    return true;
  }).map(([key, label]) => [key, key === 'node' && application?.type === 'node' ? 'Node.js' : key === 'node' && application?.type === 'php' ? 'PHP / WordPress' : label]);
  if (!tabs.some(([key]) => key === tab)) return <EmptyState title="Bu hedefte bu araç kullanılamaz" detail="Yalnız bu sitenin çalışma türüyle desteklenen yönetim araçları gösterilir." action={<LinkButton to={siteHref(domain.id)}>Siteye dön</LinkButton>} />;
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const server = servers.items.find((item) => item.id === domain.serverId);
  const url = externalSiteUrl(domain);
  const scopedJobs = siteJobs(domain, application, jobs.items);
  const query = application && params.get('application') ? `?application=${encodeURIComponent(application.id)}` : '';
  const runtimeType = website?.runtimeType ?? application?.type;
  const runtimeLabel = runtimeType === 'node' ? `Node.js ${application?.runtime?.nodeMajor ?? ''}` : ({ php: 'PHP-FPM', python: 'Python', static: 'Statik site', docker: 'Docker / proxy' }[runtimeType] ?? 'Yerel proxy');
  const shortcuts = [
    ['files', 'Dosya Yöneticisi', 'folder'], ['databases', 'Veritabanları', 'database'],
    ['ssl', 'SSL/TLS Sertifikaları', 'shield'], ['node', application?.type === 'node' ? 'Node.js' : application?.type === 'php' ? 'PHP / WordPress' : 'Uygulama', 'code'],
    ['deploy', 'Git / Yayınlama', 'git'], ['logs', 'Günlükler', 'file'], ['analytics', 'İstatistikler', 'dashboard'],
    ['dns', 'DNS', 'globe'], ['mail', 'Posta', 'mail'], ['cron', 'Zamanlanmış Görevler', 'clock'], ['backup', 'Yedekleme ve Geri Yükleme', 'archive'],
  ].filter(([key]) => tabs.some(([tabKey]) => key === tabKey));
  const hostingTools = [
    ['settings', 'Barındırma ayarları', 'settings'], ['dns', 'DNS', 'globe'],
    ['domains', 'Alan adı ve yayın yönetimi', 'globe'], ['terminal', 'Site terminali', 'terminal'],
    ['cron', 'Zamanlanmış Görevler', 'clock'], ['backup', 'Yedekleme ve Geri Yükleme', 'archive'],
  ].filter(([key]) => tabs.some(([tabKey]) => key === tabKey));
  const toolLinks = (items) => <div className="ws-console-quicklinks">{items.map(([key, label, icon]) => <Link className="ws-console-quicklink" key={key} to={`${siteHref(domain.id, key)}${query}`}><Icon name={icon} size={22} /><span>{label}</span></Link>)}</div>;
  return <>
    <nav className="ws-breadcrumb" aria-label="Site konumu"><Link to="/websites">Web Siteleri ve Alan Adları</Link>{parentTrail(domain, domains.items).map((parent) => <Fragment key={parent.id}><span aria-hidden="true">/</span><Link to={siteHref(parent.id)}>{parent.primaryDomain}</Link></Fragment>)}<span aria-hidden="true">/</span><span>{domain.primaryDomain}</span></nav>
    <PageHeading title={domain.primaryDomain} description={`${domain.parentDomainId ? 'Alt alan adı' : 'Web sitesi'} · ${server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi bekleniyor'}`} actions={<>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button"><Icon name="external" />Siteyi aç</a>}<Button onClick={refreshAll} icon="refresh">Yenile</Button></>} />
    <div className="ws-site-meta"><Badge state={domain.state} /><Badge state={ssl.state}>{ssl.label}</Badge><span>{runtimeLabel}</span></div>
    <SiteNavigation tabs={tabs} activeTab={tab} domainId={domain.id} query={query} />
    <CollectionNotice resource={domains} label="Alan adı verisi" />
    <CollectionNotice resource={websites} label="Site kaydı" />
    {['node', 'deploy', 'overview', 'resources', 'databases'].includes(tab) && <CollectionNotice resource={applications} label="Uygulama verisi" />}
    {['node', 'deploy'].includes(tab) && !website?.applicationId && matches.length > 0 && <div className="ws-notice"><div><strong>Uygulama bağlantısını kontrol edin</strong><p>İşlemler aşağıda seçilen uygulamayı etkiler. Bu eski kaydın kalıcı site bağlantısı henüz kurulmamıştır.</p></div><label>Uygulama<select value={application?.id ?? ''} onChange={(event) => { setParams((current) => { const next = new URLSearchParams(current); if (event.target.value) next.set('application', event.target.value); else next.delete('application'); return next; }); }}><option value="">{matches.length > 1 ? 'Uygulamayı seçin' : 'Tek hedef eşleşmesi'}</option>{matches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
    {tab === 'overview' && <>
      <Section title="Site araçları">{toolLinks(shortcuts)}</Section>
      <Section title="Yayın bilgileri" actions={<Link to={siteHref(domain.id, 'hosting')}>Barındırma ve DNS</Link>}><KeyValues items={[
        ['Alan adı', domain.primaryDomain], ['Uygulama türü', runtimeLabel], ['Aliaslar', domain.aliases?.join(', ') || 'Yok'], ['Son yayın', formatDate(domain.lastAppliedAt)],
      ]} />{isOwner && <div className="ws-section-body"><LinkButton to={`/websites/new?parent=${encodeURIComponent(domain.id)}`} icon="plus">Alt alan adı ekle</LinkButton></div>}</Section>
      {website && isOwner && <ProvisioningRecoveryPanel websiteId={website.id} canManage={canManage} onChanged={refreshAll} />}
      <details className="ws-section ws-disclosure"><summary>Yayın ve uygulama ayrıntıları</summary><KeyValues items={[
        ['Yayın hedefi', domain.targetType === 'static' ? domain.target?.root : `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`],
        ['Çalışma türü', website?.runtimeType ?? 'Eski / ilişkisiz kayıt'], ['Uygulama', application?.name ?? (matches.length > 1 ? 'Uygulama bölümünden hedef seçin' : 'Bağlı uygulama yok')],
      ]} /></details>
      <Section title="Bu siteye ait son işlemler" actions={<Link to={siteHref(domain.id, 'logs')}>Tümünü gör</Link>}><CollectionNotice resource={jobs} label="İşlemler" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={5} />}</Section>
    </>}
    {tab === 'hosting' && <Section title="Barındırma ve DNS">{toolLinks(hostingTools)}</Section>}
    {['resources', 'databases', 'mail'].includes(tab) && <SiteResourcesPanel domain={domain} website={website} application={application} server={server} activeTab={tab} />}
    {tab === 'node' && canManage && (website?.runtimeType === 'php' || application?.type === 'php') && <SitePhpToolsPanel domainId={domain.id} />}
    {['node', 'deploy'].includes(tab) && <><ApplicationOperations domain={domain} application={application} deployOnly={tab === 'deploy'} disabled={domains.status !== 'ready'} />{application && tab === 'node' && <EnvironmentPanel key={application.id} application={application} />}</>}
    {tab === 'cron' && <SiteCronPanel domainId={domain.id} />}
    {tab === 'backup' && <SiteBackupPanel domainId={domain.id} />}
    {tab === 'analytics' && <SiteAnalyticsPanel domainId={domain.id} />}
    {tab === 'domains' && <DomainOperations domain={domain} />}
    {tab === 'dns' && <DnsPanel key={domain.id} domain={domain} domains={domains.items} canManage={canManage} />}
    {tab === 'ssl' && <><CollectionNotice resource={certificates} label="Sertifikalar" /><SslOperations key={domain.id} domain={domain} /></>}
    {tab === 'logs' && <><LogsPanel application={application} domain={domain} server={server} /><Section title="Site işlem kayıtları"><CollectionNotice resource={jobs} label="İşlem kayıtları" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={50} />}</Section></>}
    {tab === 'terminal' && (domain.websiteId ? <TerminalPanel title="Site terminali" description={`${domain.primaryDomain} · Bu siteye ait kullanıcıyla terminal oturumu.`} target={{ scope: 'site', websiteId: domain.websiteId }} /> : <LegacyWebsiteRepair domain={domain} canManage={isOwner && canManage} onChanged={refreshAll} />)}
    {tab === 'files' && <SiteFilesPanel domainId={domain.id} legacyRepair={legacyManagedTarget ? <LegacyWebsiteRepair domain={domain} canManage={isOwner && canManage} onChanged={refreshAll} /> : null} />}
    {tab === 'settings' && <>
      <DomainHostingPanel domain={domain} />
      {website && <WebsiteSuspensionPanel domainId={domain.id} onChanged={refreshAll} />}
      <Section title="Barındırma bilgileri"><KeyValues items={[
        ['Alan adı', domain.primaryDomain],
        ['Üst alan adı', domains.items.find((item) => item.id === domain.parentDomainId)?.primaryDomain ?? 'Bağımsız kayıt'],
        ['Sunucu', server?.displayName ?? server?.hostname], ['Uygulama türü', runtimeLabel],
        ['Oluşturulma', formatDate(domain.createdAt)], ['Güncelleme', formatDate(domain.updatedAt)],
      ]} /></Section>
      {website && isOwner && <WebsiteIsolationPanel websiteId={website.id} onChanged={refreshAll} />}
      {website && isOwner && <WebsiteRemovalPanel domainId={domain.id} />}
      <details className="ws-section ws-disclosure"><summary>Teknik kayıt kimlikleri</summary><KeyValues items={[
        ['Alan adı kimliği', domain.id], ['Site kimliği', website?.id ?? 'Bağlı değil'], ['Hedef türü', domain.targetType],
      ]} />{isOwner && <div className="ws-section-body"><Link to="/domains">Gelişmiş alan adı araçları</Link></div>}</details>
    </>}
  </>;
}
