import { Fragment } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, Icon, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { SITE_TABS, certificateState, externalSiteUrl, matchingApplications, parentTrail, selectedApplication, siteHref, siteJobs, formatDate } from './site-model.js';
import { ApplicationOperations, DomainOperations, SslOperations } from './SiteOperations.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import JobsTable from './JobsTable.jsx';

const unavailable = {
  mail: ['Mail yönetimi', 'Mailbox, kota, yönlendirme ve Roundcube backend’i henüz uygulanmadı. Bu sekme mail servisini kurmaz veya DNS kaydı yayımlamaz.', 'mail'],
  files: ['Dosya yönetimi', 'Site dosyalarını listeleme, yükleme ve düzenleme API’leri henüz uygulanmadı.', 'file'],
  databases: ['Veritabanları', 'Siteye bağlı veritabanı oluşturma, kullanıcı yetkileri ve dump/restore API’leri henüz uygulanmadı.', 'database'],
  cron: ['Zamanlanmış işler', 'Site kullanıcısıyla cron oluşturma ve çalışma kayıtları henüz uygulanmadı.', 'clock'],
  backups: ['Yedekler', 'Şifreli yedek, hedef/retention ve geri yükleme backend’i henüz uygulanmadı.', 'archive'],
  terminal: ['Entegre terminal', 'PTY/WebSocket terminali ve agentsiz backend geçişi henüz uygulanmadı. Bu sürümde terminal açılmaz.', 'terminal'],
};
export default function SiteDetailPage() {
  const { websiteId, tab = 'overview' } = useParams();
  // A separate instance per domain prevents form state leaking when the site changes.
  return <SiteWorkspace key={websiteId} websiteId={websiteId} tab={tab} />;
}
function SiteWorkspace({ websiteId, tab }) {
  const { domains, applications, certificates, servers, jobs, refreshAll } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const domain = domains.items.find((item) => item.id === websiteId);
  if (!domain) return <><PageHeading title="Web sitesi" /><CollectionNotice resource={domains} label="Alan adı" />{domains.status === 'ready' && <EmptyState title="Web sitesi bulunamadı" detail="Kayıt kaldırılmış olabilir veya bağlantı yanlış bir kimliğe işaret ediyor." icon="globe" action={<LinkButton to="/websites">Web sitelerine dön</LinkButton>} />}</>;
  if (!SITE_TABS.some(([key]) => key === tab)) return <EmptyState title="Site sekmesi bulunamadı" detail="Bu adres geçerli bir yönetim sekmesine ait değil." action={<LinkButton to={siteHref(domain.id)}>Siteye dön</LinkButton>} />;
  const matches = matchingApplications(domain, applications.items);
  const application = selectedApplication(domain, applications.items, params.get('application'));
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const server = servers.items.find((item) => item.id === domain.serverId);
  const url = externalSiteUrl(domain);
  const scopedJobs = siteJobs(domain, application, jobs.items);
  const query = application && params.get('application') ? `?application=${encodeURIComponent(application.id)}` : '';
  return <>
    <nav className="ws-breadcrumb" aria-label="Site konumu"><Link to="/websites">Web siteleri</Link>{parentTrail(domain, domains.items).map((parent) => <Fragment key={parent.id}><span aria-hidden="true">/</span><Link to={siteHref(parent.id)}>{parent.primaryDomain}</Link></Fragment>)}<span aria-hidden="true">/</span><span>{domain.primaryDomain}</span></nav>
    <PageHeading title={domain.primaryDomain} description={`${domain.parentDomainId ? 'Alt alan adı' : 'Web sitesi'} · ${server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi bekleniyor'}`} actions={<>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button"><Icon name="external" />Siteyi aç</a>}<Button onClick={refreshAll} icon="refresh">Yenile</Button></>} />
    <div className="ws-site-meta"><Badge state={domain.state} /><Badge state={ssl.state}>{ssl.label}</Badge><span>{application ? `${application.name} · Node.js ${application.runtime?.nodeMajor ?? ''}` : domain.targetType === 'static' ? 'Statik dosya yayını' : `Proxy · 127.0.0.1:${domain.target?.upstreamPort ?? '—'}`}</span></div>
    <nav className="ws-tabs" aria-label="Site yönetimi">{SITE_TABS.map(([key, label]) => <Link key={key} to={`${siteHref(domain.id, key)}${query}`} aria-current={tab === key ? 'page' : undefined}>{key === 'node' && application ? 'Node.js' : label}</Link>)}</nav>
    <CollectionNotice resource={domains} label="Alan adı verisi" />
    {['node', 'deploy', 'overview'].includes(tab) && <CollectionNotice resource={applications} label="Uygulama verisi" />}
    {['node', 'deploy'].includes(tab) && matches.length > 0 && <div className="ws-notice"><div><strong>Mevcut proxy hedefine uygun uygulama</strong><p>Kalıcı website–uygulama bağı henüz yok; adaylar aynı sunucu ve port eşleşmesine göre bulunur. İşlemler seçili uygulama kaydını etkiler.</p></div><label>Uygulama<select value={application?.id ?? ''} onChange={(event) => { setParams((current) => { const next = new URLSearchParams(current); if (event.target.value) next.set('application', event.target.value); else next.delete('application'); return next; }); }}><option value="">{matches.length > 1 ? 'Uygulamayı seçin' : 'Tek hedef eşleşmesi'}</option>{matches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
    {tab === 'overview' && <>
      <div className="ws-equal-columns"><Section title="Yayın bilgileri"><KeyValues items={[
        ['Alan adı', domain.primaryDomain], ['Aliaslar', domain.aliases?.join(', ') || 'Yok'],
        ['Hedef', domain.targetType === 'static' ? domain.target?.root : `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`],
        ['Uygulama eşleşmesi', application?.name ?? (matches.length > 1 ? 'Birden fazla aday; Uygulama sekmesinden seçin' : 'Bağlı uygulama bulunamadı')],
        ['Son etkinleştirme', formatDate(domain.lastAppliedAt)],
      ]} /></Section><Section title="Hızlı erişim"><div className="ws-section-body ws-actions"><LinkButton to={siteHref(domain.id, 'node')} icon="code">Uygulama</LinkButton><LinkButton to={siteHref(domain.id, 'ssl')} icon="shield">SSL</LinkButton><LinkButton to={siteHref(domain.id, 'domains')} icon="globe">Alan adları</LinkButton><LinkButton to={`/websites/new?parent=${encodeURIComponent(domain.id)}`} icon="plus">Alt alan adı</LinkButton></div><div className="ws-section-body"><p className="ws-muted">Trafik ve siteye özel disk kullanım ölçümleri henüz toplanmıyor. Eksik metrikler sıfır olarak gösterilmez.</p></div></Section></div>
      <Section title="Bu siteye ait son işlemler"><CollectionNotice resource={jobs} label="İşlemler" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={8} />}</Section>
    </>}
    {['node', 'deploy'].includes(tab) && <><ApplicationOperations domain={domain} application={application} deployOnly={tab === 'deploy'} disabled={domains.status !== 'ready'} />{application && tab === 'node' && <EnvironmentPanel key={application.id} application={application} />}</>}
    {tab === 'domains' && <DomainOperations domain={domain} />}
    {tab === 'ssl' && <><CollectionNotice resource={certificates} label="Sertifikalar" /><SslOperations key={domain.id} domain={domain} /></>}
    {tab === 'logs' && <><div className="ws-notice"><Icon name="file" /><span>Bu sürümde siteye ait işlem kayıtları gösterilir. Canlı Node.js/Nginx log akışı henüz yok.</span></div><Section title="Site işlem kayıtları"><CollectionNotice resource={jobs} label="İşlem kayıtları" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={50} />}</Section></>}
    {tab === 'settings' && <Section title="Site ayarları"><KeyValues items={[
      ['Kayıt kimliği', domain.id], ['Üst alan adı', domains.items.find((item) => item.id === domain.parentDomainId)?.primaryDomain ?? 'Bağımsız kayıt'],
      ['Sunucu', server?.displayName ?? server?.hostname], ['Hedef türü', domain.targetType],
      ['Oluşturulma', formatDate(domain.createdAt)], ['Güncelleme', formatDate(domain.updatedAt)],
    ]} /><div className="ws-section-body"><p className="ws-muted">Bu ekran mevcut domain kimliğini kullanır. Website veri modeli, kalıcı uygulama atama ve bağımlılıkları kontrol ederek silme/taşıma henüz tamamlanmadı.</p><Link to="/domains">Gelişmiş alan adı araçlarına git</Link></div></Section>}
    {unavailable[tab] && <Section title={unavailable[tab][0]}><EmptyState title="Bu modül henüz uygulanmadı" detail={unavailable[tab][1]} icon={unavailable[tab][2]} /></Section>}
  </>;
}
