import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, CollectionNotice, EmptyState, ErrorNotice, Icon, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { SITE_TABS, certificateState, externalSiteUrl, matchingApplications, parentTrail, selectedApplication, siteHref, siteJobs, formatDate } from './site-model.js';
import { ApplicationOperations, DomainOperations, SslOperations } from './SiteOperations.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import JobsTable from './JobsTable.jsx';
import TerminalPanel from './LazyTerminalPanel.jsx';
import FilesPanel from './FilesPanel.jsx';
import LogsPanel from './LogsPanel.jsx';
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
          ? 'Bu Domain için birden fazla uygulama eşleşiyor; önce hedef uygulamayı tekilleştirin.'
          : 'Bu Domain için aynı port ve sunucuda eşleşen bir uygulama bulunamadı.');
      }
      if (item.action === 'create_website_then_bind') {
        await panelRequest('/websites/migration/create-website', {
          method: 'POST',
          body: {
            domainId: domain.id,
            applicationId: item.applicationId,
            previewDigest: preview.digest,
            confirmation: `create-website:${domain.id}:${item.applicationId}:${preview.digest}`,
          },
        });
        preview = await panelRequest('/websites/migration/preview');
        item = preview.items.find((candidate) => candidate.domainId === domain.id);
      }
      if (!item || item.status !== 'ready' || item.action !== 'bind_existing_website' || !item.websiteId) {
        throw new Error('Website kaydı oluşturuldu ancak güvenli bağlama planı üretilemedi; sayfayı yenileyip tekrar deneyin.');
      }
      await panelRequest('/websites/migration/bind', {
        method: 'POST',
        body: {
          domainId: domain.id,
          websiteId: item.websiteId,
          previewDigest: preview.digest,
          confirmation: `bind:${domain.id}:${item.websiteId}:${preview.digest}`,
        },
      });
      onChanged();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Section title="Site kimliği gerekli"><div className="ws-section-body"><ErrorNotice error={error} /><p className="ws-muted">Bu eski Domain kaydı henüz kalıcı Website kimliğine bağlı değil. Terminal ve dosya erişimi açılmadan önce eşleşen yerel uygulamayla açıkça bağlanmalıdır.</p>{canManage && <Button variant="primary" disabled={busy} onClick={repair}>{busy ? 'Site kimliği hazırlanıyor…' : 'Site kimliğini oluştur ve bağla'}</Button>}</div></Section>;
}
export default function SiteDetailPage() {
  const { websiteId, tab = 'overview' } = useParams();
  // A separate instance per domain prevents form state leaking when the site changes.
  return <SiteWorkspace key={websiteId} websiteId={websiteId} tab={tab} />;
}
function SiteWorkspace({ websiteId, tab }) {
  const { domains, websites, applications, certificates, servers, jobs, refreshAll, canManage } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const domain = domains.items.find((item) => item.id === websiteId);
  if (!domain) return <><PageHeading title="Web sitesi" /><CollectionNotice resource={domains} label="Alan adı" />{domains.status === 'ready' && <EmptyState title="Web sitesi bulunamadı" detail="Kayıt kaldırılmış olabilir veya bağlantı yanlış bir kimliğe işaret ediyor." icon="globe" action={<LinkButton to="/websites">Web sitelerine dön</LinkButton>} />}</>;
  const matches = matchingApplications(domain, applications.items);
  const website = websites.items.find((item) => item.id === domain.websiteId);
  const application = applications.items.find((item) => item.id === website?.applicationId)
    ?? selectedApplication(domain, applications.items, params.get('application'));
  const managedWebsite = website && ['static', 'node'].includes(website.runtimeType);
  const legacyManagedTarget = !domain.websiteId && Boolean(application);
  const tabs = SITE_TABS.filter(([key]) => {
    if (['node', 'deploy'].includes(key)) return Boolean(application);
    if (['files', 'terminal'].includes(key)) return managedWebsite || legacyManagedTarget;
    return true;
  });
  if (!tabs.some(([key]) => key === tab)) return <EmptyState title="Bu hedefte bu araç kullanılamaz" detail="Yalnız bu sitenin gerçek çalışma türüyle desteklenen yönetim araçları gösterilir." action={<LinkButton to={siteHref(domain.id)}>Siteye dön</LinkButton>} />;
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const server = servers.items.find((item) => item.id === domain.serverId);
  const url = externalSiteUrl(domain);
  const scopedJobs = siteJobs(domain, application, jobs.items);
  const query = application && params.get('application') ? `?application=${encodeURIComponent(application.id)}` : '';
  return <>
    <nav className="ws-breadcrumb" aria-label="Site konumu"><Link to="/websites">Web siteleri</Link>{parentTrail(domain, domains.items).map((parent) => <Fragment key={parent.id}><span aria-hidden="true">/</span><Link to={siteHref(parent.id)}>{parent.primaryDomain}</Link></Fragment>)}<span aria-hidden="true">/</span><span>{domain.primaryDomain}</span></nav>
    <PageHeading title={domain.primaryDomain} description={`${domain.parentDomainId ? 'Alt alan adı' : 'Web sitesi'} · ${server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi bekleniyor'}`} actions={<>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button"><Icon name="external" />Siteyi aç</a>}<Button onClick={refreshAll} icon="refresh">Yenile</Button></>} />
    <div className="ws-site-meta"><Badge state={domain.state} /><Badge state={ssl.state}>{ssl.label}</Badge><span>{application ? `${application.name} · ${application.type === 'node' ? `Node.js ${application.runtime?.nodeMajor ?? ''}` : 'Statik uygulama'}` : domain.targetType === 'static' ? 'Statik dosya yayını' : `Proxy · 127.0.0.1:${domain.target?.upstreamPort ?? '—'}`}</span></div>
    <nav className="ws-tabs" aria-label="Site yönetimi">{tabs.map(([key, label]) => <Link key={key} to={`${siteHref(domain.id, key)}${query}`} aria-current={tab === key ? 'page' : undefined}>{key === 'node' && application?.type === 'node' ? 'Node.js' : label}</Link>)}</nav>
    <CollectionNotice resource={domains} label="Alan adı verisi" />
    <CollectionNotice resource={websites} label="Website kimliği" />
    {['node', 'deploy', 'overview'].includes(tab) && <CollectionNotice resource={applications} label="Uygulama verisi" />}
    {['node', 'deploy'].includes(tab) && matches.length > 0 && <div className="ws-notice"><div><strong>Mevcut proxy hedefine uygun uygulama</strong><p>Kalıcı website–uygulama bağı henüz yok; adaylar aynı sunucu ve port eşleşmesine göre bulunur. İşlemler seçili uygulama kaydını etkiler.</p></div><label>Uygulama<select value={application?.id ?? ''} onChange={(event) => { setParams((current) => { const next = new URLSearchParams(current); if (event.target.value) next.set('application', event.target.value); else next.delete('application'); return next; }); }}><option value="">{matches.length > 1 ? 'Uygulamayı seçin' : 'Tek hedef eşleşmesi'}</option>{matches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>}
    {tab === 'overview' && <>
      <div className="ws-equal-columns"><Section title="Yayın bilgileri"><KeyValues items={[
        ['Alan adı', domain.primaryDomain], ['Aliaslar', domain.aliases?.join(', ') || 'Yok'],
        ['Hedef', domain.targetType === 'static' ? domain.target?.root : `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`],
        ['Uygulama eşleşmesi', application?.name ?? (matches.length > 1 ? 'Birden fazla aday; Uygulama sekmesinden seçin' : 'Bağlı uygulama bulunamadı')],
        ['Son etkinleştirme', formatDate(domain.lastAppliedAt)],
      ]} /></Section><Section title="Hızlı erişim"><div className="ws-section-body ws-actions">{application && <LinkButton to={siteHref(domain.id, 'node')} icon="code">Uygulama</LinkButton>}<LinkButton to={siteHref(domain.id, 'ssl')} icon="shield">SSL</LinkButton><LinkButton to={siteHref(domain.id, 'domains')} icon="globe">Alan adları</LinkButton><LinkButton to={`/websites/new?parent=${encodeURIComponent(domain.id)}`} icon="plus">Alt alan adı</LinkButton></div><div className="ws-section-body"><p className="ws-muted">Trafik ve siteye özel disk kullanım ölçümleri henüz toplanmıyor. Eksik metrikler sıfır olarak gösterilmez.</p></div></Section></div>
      <Section title="Bu siteye ait son işlemler"><CollectionNotice resource={jobs} label="İşlemler" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={8} />}</Section>
    </>}
    {['node', 'deploy'].includes(tab) && <><ApplicationOperations domain={domain} application={application} deployOnly={tab === 'deploy'} disabled={domains.status !== 'ready'} />{application && tab === 'node' && <EnvironmentPanel key={application.id} application={application} />}</>}
    {tab === 'domains' && <DomainOperations domain={domain} />}
    {tab === 'ssl' && <><CollectionNotice resource={certificates} label="Sertifikalar" /><SslOperations key={domain.id} domain={domain} /></>}
    {tab === 'logs' && <><LogsPanel application={application} domain={domain} server={server} /><Section title="Site işlem kayıtları"><CollectionNotice resource={jobs} label="İşlem kayıtları" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={scopedJobs} limit={50} />}</Section></>}
    {tab === 'terminal' && (domain.websiteId ? <TerminalPanel
      title="Site terminali"
      description={`${domain.primaryDomain} için dedicated site kullanıcısında interaktif PTY.`}
      target={{ scope: 'site', websiteId: domain.websiteId }}
    /> : <LegacyWebsiteRepair domain={domain} canManage={canManage} onChanged={refreshAll} />)}
    {tab === 'files' && (domain.websiteId ? <FilesPanel websiteId={domain.websiteId} /> : <LegacyWebsiteRepair domain={domain} canManage={canManage} onChanged={refreshAll} />)}
    {tab === 'settings' && <Section title="Site ayarları"><KeyValues items={[
      ['Kayıt kimliği', domain.id], ['Üst alan adı', domains.items.find((item) => item.id === domain.parentDomainId)?.primaryDomain ?? 'Bağımsız kayıt'],
      ['Sunucu', server?.displayName ?? server?.hostname], ['Hedef türü', domain.targetType],
      ['Oluşturulma', formatDate(domain.createdAt)], ['Güncelleme', formatDate(domain.updatedAt)],
    ]} /><div className="ws-section-body"><p className="ws-muted">Bu ekran yalnız bu panel sunucusundaki Domain ve kalıcı Website kimliğini kullanır.</p><Link to="/domains">Gelişmiş alan adı araçlarına git</Link></div></Section>}
  </>;
}
