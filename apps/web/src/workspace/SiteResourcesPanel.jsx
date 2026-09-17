import { useCallback, useEffect, useState } from 'react';
import { getWebsiteDatabaseResources, panelRequest } from '../api.js';
import { websiteDatabaseResourcesView } from './database-model.js';
import { Badge, Button, EmptyState, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';

export default function SiteResourcesPanel({ domain, website, application, server }) {
  const [mailDomains, setMailDomains] = useState(undefined);
  const [databaseResources, setDatabaseResources] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!server) return;
    setBusy(true); setError(null);
    try {
      const [mail, resources] = await Promise.all([
        panelRequest('/mail-domains'),
        website ? getWebsiteDatabaseResources(server.id, website.id) : Promise.resolve(null),
      ]);
      setMailDomains((Array.isArray(mail) ? mail : []).filter((item) => item.webDomainId === domain.id));
      const databaseView = resources ? websiteDatabaseResourcesView(resources) : null;
      if (resources && !databaseView) throw new Error('Website veritabanı durumu geçersiz');
      setDatabaseResources(databaseView);
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { setBusy(false); }
  }, [server?.id, domain.id, website?.id, application?.id]);
  useEffect(() => { load(); }, [load]);

  const compose = website?.managedComposeBinding ?? null;
  const externalDocker = website?.dockerWorkloadId ?? null;
  const mails = mailDomains ?? [];
  const databases = databaseResources?.databases ?? [];

  return <><Section title="Bağlı kaynaklar" description="Yalnız explicit Website/Application/Domain ilişkileri gösterilir; port, isim veya hostname tahmini yapılmaz." actions={<Button icon="refresh" disabled={busy} onClick={load}>Yenile</Button>}><div className="ws-section-body"><ErrorNotice error={error} /><KeyValues items={[
    ['Website kimliği', website?.id ?? 'Legacy / bağlı değil'],
    ['Runtime', website?.runtimeType ?? domain.targetType],
    ['Uygulama', application?.name ?? '—'],
    ['Site kullanıcısı', website?.unixUser ?? '—'],
    ['Veritabanı bağı', databaseResources === undefined ? 'Yükleniyor…' : databases.length],
    ['DB credential', databaseResources === undefined ? 'Yükleniyor…' : databases.filter((entry) => entry.credential).length],
    ['Mail domain bağı', mailDomains === undefined ? 'Yükleniyor…' : mails.length],
    ['Docker bağı', compose ? 'Managed Compose' : externalDocker ? 'External workload' : 'Yok'],
  ]} /></div></Section>
  <div className="ws-equal-columns">
    <Section title="Veritabanları" description="Bu Website’e explicit bağlı schema ve secret-free credential/grant durumu.">{databases.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Veritabanı</th><th>Site user</th><th>DB user / grant</th><th>Revizyon</th></tr></thead><tbody>{databases.map(({ binding, credential }) => <tr key={binding.id}><td><strong>{binding.databaseName}</strong><small>{binding.id}</small></td><td><code>{binding.unixUser}</code></td><td>{credential ? <><code>{credential.username}</code><small>{credential.privileges.join(', ')}</small></> : <span>Credential oluşturulmadı</span>}</td><td>{binding.revision}{credential ? ` / ${credential.revision}` : ''}</td></tr>)}</tbody></table></div> : databaseResources !== undefined && <EmptyState icon="database" title="Bağlı veritabanı yok" detail="Sunucu veritabanları ayrı envanterde olabilir; burada yalnız bu siteye explicit bind edilmiş kayıtlar gösterilir." />}<div className="ws-section-body"><LinkButton to="/databases" icon="database">Veritabanlarını yönet</LinkButton></div></Section>
    <Section title="Mail" description="Web Domain kimliğiyle explicit bağlı mail-domain kayıtları.">{mails.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Domain</th><th>Mod</th><th>Durum</th></tr></thead><tbody>{mails.map((mail) => <tr key={mail.id}><td><strong>{mail.domainName}</strong></td><td>{mail.managementMode}</td><td><Badge state={mail.status === 'enabled' || mail.status === 'ready' ? 'active' : mail.status === 'degraded' ? 'warning' : 'offline'}>{mail.status}</Badge></td></tr>)}</tbody></table></div> : mailDomains !== undefined && <EmptyState icon="mail" title="Bağlı mail domain yok" detail="Bu web Domain için explicit mail-domain lifecycle kaydı bulunmuyor." />}<div className="ws-section-body">{mails[0] ? <LinkButton to={`/mail/${encodeURIComponent(mails[0].id)}`} icon="mail">Mail’i yönet</LinkButton> : <LinkButton to="/mail" icon="mail">Mail domainleri</LinkButton>}</div></Section>
  </div>
  <Section title="Docker" description="Website runtime’ına bağlı Docker identity; transient host published port burada kalıcı state olarak tutulmaz."><div className="ws-section-body">{compose ? <><KeyValues items={[
    ['Tür', 'Managed Compose'], ['Project ID', compose.projectId], ['Servis', compose.serviceName], ['Target port', `${compose.targetPort}/${compose.protocol}`],
  ]} /><LinkButton to={`/docker/${encodeURIComponent(compose.projectId)}`} icon="box">Compose projesini yönet</LinkButton></> : externalDocker ? <><KeyValues items={[['Tür', 'External / unverified workload'], ['Workload ID', externalDocker]]} /><p className="ws-muted">Bu legacy/external workload Managed Compose project gibi varsayılmaz.</p></> : <EmptyState icon="box" title="Docker bağı yok" detail="Bu Website Application/static runtime kullanıyor veya Docker ile ilişkilendirilmemiş." />}</div></Section>
  </>;
}
