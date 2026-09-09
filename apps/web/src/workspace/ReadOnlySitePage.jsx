import { Fragment } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, CollectionNotice, EmptyState, Icon, KeyValues, PageHeading, Section } from './PanelKit.jsx';
import { certificateState, externalSiteUrl, matchingApplications, parentTrail, selectedApplication, siteHref, formatDate } from './site-model.js';

export default function ReadOnlySitePage() {
  const { websiteId, tab } = useParams();
  const { domains, applications, certificates, servers, refreshAll } = useWorkspace();
  if (tab && tab !== 'overview') return <Navigate to={siteHref(websiteId)} replace />;
  const domain = domains.items.find((item) => item.id === websiteId);
  if (!domain) return <><PageHeading title="Web sitesi" /><CollectionNotice resource={domains} label="Alan adı" />{domains.status === 'ready' && <EmptyState title="Web sitesi bulunamadı" detail="Kayıt kaldırılmış olabilir veya bağlantı yanlış bir kimliğe işaret ediyor." icon="globe" />}</>;
  const matches = matchingApplications(domain, applications.items);
  const application = selectedApplication(domain, applications.items);
  const ssl = certificateState(domain, certificates.status === 'ready' ? certificates.items : null);
  const server = servers.items.find((item) => item.id === domain.serverId);
  const url = externalSiteUrl(domain);
  return <>
    <nav className="ws-breadcrumb" aria-label="Site konumu"><Link to="/websites">Web siteleri</Link>{parentTrail(domain, domains.items).map((parent) => <Fragment key={parent.id}><span aria-hidden="true">/</span><Link to={siteHref(parent.id)}>{parent.primaryDomain}</Link></Fragment>)}<span aria-hidden="true">/</span><span>{domain.primaryDomain}</span></nav>
    <PageHeading title={domain.primaryDomain} description={`Read Only · ${domain.parentDomainId ? 'Alt alan adı' : 'Web sitesi'} · ${server?.displayName ?? server?.name ?? server?.hostname ?? 'Sunucu bilgisi bekleniyor'}`} actions={<>{url && <a href={url} target="_blank" rel="noopener noreferrer" className="ws-button"><Icon name="external" />Siteyi aç</a>}<button type="button" className="ws-button" onClick={refreshAll}><Icon name="refresh" />Yenile</button></>} />
    <div className="ws-site-meta"><Badge state={domain.state} /><Badge state={ssl.state}>{ssl.label}</Badge><span>{application ? `${application.name} · Node.js ${application.runtime?.nodeMajor ?? ''}` : domain.targetType === 'static' ? 'Statik dosya yayını' : `Proxy · 127.0.0.1:${domain.target?.upstreamPort ?? '—'}`}</span></div>
    <CollectionNotice resource={domains} label="Alan adı verisi" /><CollectionNotice resource={applications} label="Uygulama verisi" /><CollectionNotice resource={certificates} label="Sertifika verisi" />
    <div className="ws-equal-columns">
      <Section title="Yayın bilgileri"><KeyValues items={[
        ['Alan adı', domain.primaryDomain], ['Aliaslar', domain.aliases?.join(', ') || 'Yok'],
        ['Hedef', domain.targetType === 'static' ? domain.target?.root : `127.0.0.1:${domain.target?.upstreamPort ?? '—'}`],
        ['Uygulama', application?.name ?? (matches.length > 1 ? `${matches.length} olası uygulama eşleşmesi` : 'Bağlı uygulama bulunamadı')],
        ['Sunucu', server?.displayName ?? server?.name ?? server?.hostname ?? '—'], ['Son etkinleştirme', formatDate(domain.lastAppliedAt)],
      ]} /></Section>
      <Section title="Kayıt bilgileri"><KeyValues items={[
        ['Durum', domain.state], ['SSL', ssl.label], ['Hedef türü', domain.targetType],
        ['Üst alan adı', domains.items.find((item) => item.id === domain.parentDomainId)?.primaryDomain ?? 'Bağımsız kayıt'],
        ['Oluşturulma', formatDate(domain.createdAt)], ['Güncelleme', formatDate(domain.updatedAt)],
      ]} /></Section>
    </div>
    <Section title="Salt okunur erişim"><div className="ws-section-body"><p className="ws-muted">Bu hesap deploy, restart, env, domain, SSL, terminal veya başka bir sunucu işlemi başlatamaz. İşlem geçmişi ve hassas çalışma verileri bu rolde gösterilmez.</p></div></Section>
  </>;
}
