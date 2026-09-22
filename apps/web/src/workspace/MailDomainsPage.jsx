import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { getMailDomain, listMailAliases, listMailDomains, listMailboxes } from './mail-client.js';
import MailAliasesPanel from './MailAliasesPanel.jsx';
import MailboxesPanel from './MailboxesPanel.jsx';
import MailConfigurationPanel from './MailConfigurationPanel.jsx';
import MailDkimDiagnosticsPanel from './MailDkimDiagnosticsPanel.jsx';
import MailDomainCreateDialog from './MailDomainCreateDialog.jsx';
import MailOperationsPanel from './MailOperationsPanel.jsx';
import MailWebmailPanel from './MailWebmailPanel.jsx';
import { Badge, Button, EmptyState, Icon, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';
import { paginateConsoleItems } from './ui/console-model.js';
import './ui/mail-console.css';

function useAsyncResource(loader, dependencies = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, status: current.data ? 'stale' : 'loading', error: null }));
    Promise.resolve(loader(controller.signal))
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setState((current) => ({ status: current.data ? 'stale' : 'error', data: current.data, error })); });
    return () => controller.abort();
    // Identity primitives deliberately control the loader lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);
  return { ...state, refresh };
}
function LoadNotice({ resource, label }) {
  if (resource.status === 'loading') return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
  if (!resource.error) return null;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error.message ?? 'Veri alınamadı.'}</p></div><Button icon="refresh" onClick={resource.refresh}>Yeniden dene</Button></div>;
}
function mailState(domain) {
  if (domain.managementMode === 'external') {
    if (domain.status === 'ready') return 'active';
    if (domain.status === 'degraded') return 'warning';
    return 'unknown';
  }
  return domain.status === 'enabled' ? 'active' : 'offline';
}
function mailStatusLabel(domain) {
  return ({ enabled: 'Etkin', disabled: 'Kapalı', ready: 'Hazır', degraded: 'Kontrol gerekli' })[domain.status] ?? domain.status ?? 'Bilinmiyor';
}
function MailDomainList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const domains = useAsyncResource(() => listMailDomains(), []);
  const items = Array.isArray(domains.data) ? domains.data : [];
  const query = params.get('q') ?? '';
  const mode = ['local', 'external'].includes(params.get('mode')) ? params.get('mode') : 'all';
  const filtered = items.filter((item) => (mode === 'all' || item.managementMode === mode) && String(item.domainName).toLocaleLowerCase('tr-TR').includes(query.trim().toLocaleLowerCase('tr-TR')));
  const page = paginateConsoleItems(filtered, params.get('page'));
  function filter(key, value) {
    setParams((current) => { const next = new URLSearchParams(current); if (value && value !== 'all') next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); return next; }, { replace: key === 'q' });
  }
  return <>
    <PageHeading title="Mail" description="Posta hesapları, webmail ve alan adı ayarları." actions={<><Button icon="refresh" onClick={domains.refresh}>Yenile</Button><Button icon="plus" variant="primary" onClick={() => setCreating(true)}>Mail alan adı ekle</Button></>} />
    <LoadNotice resource={domains} label="Mail alan adları" />
    <Section title="Mail alan adları" actions={<span className="ws-muted">{domains.data ? `${items.length} kayıt` : 'Bağlantı bekleniyor'}</span>}>
      <div className="ws-filters"><label className="ws-filter-search">Alan adı ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="Örneğin: sirket.com" /></label><label>Yönetim<select aria-label="Mail yönetim modu" value={mode} onChange={(event) => filter('mode', event.target.value)}><option value="all">Tümü</option><option value="local">Bu sunucuda</option><option value="external">Harici sağlayıcı</option></select></label></div>
      {page.items.length > 0 ? <>
        <div className="ws-table-scroll"><table className="ws-table ws-mail-table" role="table" aria-label="Mail alan adları"><thead><tr><th scope="col">Alan adı</th><th scope="col">Yönetim</th><th scope="col">Durum</th><th scope="col">Güncellendi</th><th scope="col" className="ws-row-end">İşlem</th></tr></thead><tbody>{page.items.map((domain) => <tr key={domain.id} role="row"><td role="cell"><div className="ws-mail-name"><Icon name="mail" /><strong>{domain.domainName}</strong></div></td><td role="cell" data-label="Yönetim">{domain.managementMode === 'local' ? 'Bu sunucuda' : 'Harici sağlayıcı'}</td><td role="cell" data-label="Durum"><Badge state={mailState(domain)}>{mailStatusLabel(domain)}</Badge></td><td role="cell" data-label="Güncellendi">{formatDate(domain.updatedAt)}</td><td role="cell" className="ws-row-end"><LinkButton to={`/mail/${encodeURIComponent(domain.id)}`} icon="arrow">Yönet</LinkButton></td></tr>)}</tbody></table></div>
        <footer className="ws-pagination"><span>{page.count} sonuç</span><div className="ws-actions"><Button disabled={page.page <= 1} onClick={() => filter('page', String(page.page - 1))}>Önceki</Button><span>{page.page} / {page.pages}</span><Button disabled={page.page >= page.pages} onClick={() => filter('page', String(page.page + 1))}>Sonraki</Button></div></footer>
      </> : domains.status === 'ready' && <EmptyState icon="mail" title={items.length ? 'Eşleşen alan adı yok' : 'Henüz mail alan adı yok'} detail={items.length ? 'Arama veya yönetim filtresini değiştirin.' : 'Mail hesaplarını yönetmek için bir alan adı ekleyin.'} action={!items.length && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Mail alan adı ekle</Button>} />}
    </Section>
    {creating && <MailDomainCreateDialog onClose={() => setCreating(false)} onCreated={(created) => { domains.refresh(); navigate(`/mail/${encodeURIComponent(created.id)}`); }} />}
  </>;
}
const mailSections = [['mailboxes', 'Posta kutuları'], ['webmail', 'Webmail'], ['aliases', 'Takma adlar'], ['security', 'DNS ve DKIM'], ['configuration', 'Yapılandırma'], ['operations', 'Kuyruk ve loglar']];
function MailDomainDetail({ mailDomainId }) {
  const [params] = useSearchParams();
  const section = mailSections.some(([key]) => key === params.get('section')) ? params.get('section') : 'mailboxes';
  const detail = useAsyncResource(async () => {
    const domain = await getMailDomain(mailDomainId);
    const [mailboxes, aliases] = domain.managementMode === 'local' ? await Promise.all([listMailboxes(mailDomainId), listMailAliases(mailDomainId)]) : [[], []];
    return { domain, mailboxes, aliases };
  }, [mailDomainId]);
  const data = detail.data;
  const domain = data?.domain ?? null;
  const href = (key) => { const next = new URLSearchParams(params); next.set('section', key); return `/mail/${encodeURIComponent(mailDomainId)}?${next}`; };
  return <>
    <nav className="ws-breadcrumb" aria-label="Mail konumu"><Link to="/mail">Mail</Link><span>/</span><span>{domain?.domainName ?? 'Alan adı'}</span></nav>
    <PageHeading title={domain?.domainName ?? 'Mail alan adı'} description="Bu alan adına ait posta hesapları ve mail hizmetleri." actions={<Button icon="refresh" onClick={detail.refresh}>Yenile</Button>} />
    <LoadNotice resource={detail} label="Mail alan adı" />
    {domain && <>
      <div className="ws-site-meta"><Badge state={mailState(domain)}>{mailStatusLabel(domain)}</Badge><span>{domain.managementMode === 'local' ? 'Bu sunucuda' : 'Harici sağlayıcı'}</span>{domain.managementMode === 'local' && <><span>{data.mailboxes.length} posta kutusu</span><span>{data.aliases.length} takma ad</span></>}</div>
      {domain.managementMode === 'local' ? <>
        <nav className="ws-tabs" aria-label="Mail yönetimi">{mailSections.map(([key, label]) => <Link key={key} to={href(key)} aria-current={section === key ? 'page' : undefined}>{label}</Link>)}</nav>
        {/* Keep panels mounted when switching sections so edits and durable-job state survive. */}
        <div className="ws-mail-pane" hidden={section !== 'mailboxes'}><MailboxesPanel domain={domain} mailboxes={data.mailboxes ?? []} onChanged={detail.refresh} /></div>
        <div className="ws-mail-pane" hidden={section !== 'webmail'}><MailWebmailPanel domain={domain} onChanged={detail.refresh} /></div>
        <div className="ws-mail-pane" hidden={section !== 'aliases'}><MailAliasesPanel domain={domain} aliases={data.aliases ?? []} onChanged={detail.refresh} /></div>
        <div className="ws-mail-pane" hidden={section !== 'security'}><MailDkimDiagnosticsPanel domain={domain} onChanged={detail.refresh} /></div>
        <div className="ws-mail-pane" hidden={section !== 'configuration'}><MailConfigurationPanel domain={domain} onChanged={detail.refresh} /></div>
        <div className="ws-mail-pane" hidden={section !== 'operations'}><MailOperationsPanel /></div>
      </> : <Section title="Harici mail sağlayıcısı"><EmptyState icon="external" title="Posta hesapları harici sağlayıcıda yönetiliyor" detail="Bu alan adı yalnızca takip edilir. Yerel posta kutusu, takma ad ve DKIM işlemleri bu kayda uygulanmaz." /></Section>}
      <details className="ws-section ws-disclosure"><summary>Alan adı kayıt ayrıntıları</summary><KeyValues items={[
        ['Yönetim modu', domain.managementMode], ['Revizyon', domain.revision], ['Web Domain', domain.webDomainId ?? '—'], ['Son gözlem', formatDate(domain.lastObservedAt)],
      ]} /></details>
    </>}
  </>;
}
export default function MailDomainsPage() {
  const { mailDomainId } = useParams();
  return mailDomainId ? <MailDomainDetail key={mailDomainId} mailDomainId={mailDomainId} /> : <MailDomainList />;
}
export const mailDomainsPageInternals = Object.freeze({ mailState });
