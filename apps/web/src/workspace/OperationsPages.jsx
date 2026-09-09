import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import DomainManager from '../DomainManager.jsx';
import ServerManager from '../ServerManager.jsx';
import SystemUpdatePanel from '../SystemUpdatePanel.jsx';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, CollectionNotice, ConfirmDialog, EmptyState, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { ServerSummary } from './DashboardPage.jsx';
import JobsTable from './JobsTable.jsx';

export function ServersPage() {
  const { servers } = useWorkspace();
  return <><PageHeading title="Sunucular" description="Sistem envanteri, bağlantı durumu ve mevcut sunucu kurulum araçları." actions={<Button icon="refresh" onClick={servers.refresh}>Yenile</Button>} /><CollectionNotice resource={servers} label="Sunucular" /><div className="ws-equal-columns">{servers.items.map((server) => <Section key={server.id} title={server.displayName ?? server.name ?? server.hostname}><ServerSummary server={server} /></Section>)}</div><details className="ws-section ws-section-body"><summary>Gelişmiş: mevcut sunucu kayıt akışı</summary><p className="ws-muted">Ayrı agent’ın kaldırılması henüz uygulanmadı. Mevcut sunucu kaydı ve enrollment araçları geçiş tamamlanana kadar korunur.</p><ServerManager servers={servers.items} access={servers.status} renderServer={() => null} /></details></>;
}
export function JobsPage() {
  const { jobs, refreshAll } = useWorkspace(); const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const pending = useRef(false);
  const query = params.get('q') ?? ''; const status = params.get('status') ?? 'all';
  const items = jobs.items.filter((job) => (status === 'all' || status === job.status) && [job.type, job.id, job.resourceId].some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase()))).sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0));
  const pages = Math.max(1, Math.ceil(items.length / 20)); const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page'), 10) || 1));
  function filter(key, value) { setParams((current) => { const next = new URLSearchParams(current); next.set(key, value); if (key !== 'page') next.delete('page'); return next; }, { replace: key === 'q' }); }
  async function cancel() {
    if (pending.current || !selected) return; pending.current = true; setBusy(true); setError(null);
    try { await panelRequest(`/jobs/${encodeURIComponent(selected.id)}/cancel`, { method: 'POST', body: {} }); setSelected(null); refreshAll(); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <><PageHeading title="İşler" description="Sunucuda sıraya alınan ve tamamlanan işlemler." actions={<Button icon="refresh" onClick={jobs.refresh}>Yenile</Button>} /><Section title="İşlem geçmişi"><div className="ws-filters"><label className="ws-filter-search">İşlem ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} placeholder="İşlem türü, iş veya kaynak kimliği" /></label><label>Durum<select value={status} onChange={(event) => filter('status', event.target.value)}><option value="all">Tümü</option><option value="queued">Sırada</option><option value="running">Çalışıyor</option><option value="succeeded">Tamamlandı</option><option value="failed">Başarısız</option><option value="cancelled">İptal</option></select></label></div><CollectionNotice resource={jobs} label="İşlem geçmişi" />{['ready', 'stale'].includes(jobs.status) && <JobsTable jobs={items.slice((page - 1) * 20, page * 20)} limit={20} onCancel={jobs.status === 'ready' ? (job) => { setError(null); setSelected(job); } : undefined} busy={busy} />}<footer className="ws-pagination"><span>{items.length} kayıt</span><div className="ws-actions"><Button disabled={page <= 1} onClick={() => filter('page', String(page - 1))}>Önceki</Button><span>{page} / {pages}</span><Button disabled={page >= pages} onClick={() => filter('page', String(page + 1))}>Sonraki</Button></div></footer></Section>{selected && <ConfirmDialog title="Sıradaki işi iptal et" message={`${selected.type ?? selected.operation} işlemi iptal edilecek. İş çalışmaya başladıysa sunucu iptali reddedebilir.`} busy={busy} error={error} onCancel={() => setSelected(null)} onConfirm={cancel} confirmLabel="İşi iptal et" />}</>;
}
export function AdvancedDomainsPage() {
  const { domains, certificates, servers, refreshAll } = useWorkspace();
  return <><PageHeading title="Gelişmiş alan adı araçları" description="Mevcut kayıt ve sertifika yönetimi korunur. Günlük işlemler için site ekranlarını kullanın." actions={<LinkButton to="/websites">Web siteleri</LinkButton>} /><DomainManager domains={domains.items} domainAccess={domains.status} certificates={certificates.items} certificateAccess={certificates.status} servers={servers.items} onChanged={refreshAll} /></>;
}
export function SettingsPage() {
  const { servers } = useWorkspace(); const [params, setParams] = useSearchParams();
  const server = servers.items.find((item) => item.id === params.get('server')) ?? (servers.items.length === 1 ? servers.items[0] : null);
  return <><PageHeading title="Ayarlar" description="Panel bakım araçları ve yönetim erişimi." /><Section title="Hesap ve erişim"><div className="ws-section-body"><p className="ws-muted">Parola, MFA ve oturumlar üstteki Hesabım menüsünden yönetilir. Ek kullanıcı oluşturma/düzenleme/silme backend’i bu sürüme eklenemedi; mevcut Owner korumaları değiştirilmedi.</p></div></Section><Section title="YunPanel güncellemeleri"><CollectionNotice resource={servers} label="Sunucular" /><div className="ws-section-body"><label>Sunucu<select value={server?.id ?? ''} onChange={(event) => setParams({ server: event.target.value })}><option value="">Sunucu seçin</option>{servers.items.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.name ?? item.hostname}</option>)}</select></label></div>{server && servers.status === 'ready' && !import.meta.env.DEV && <div className="ws-section-body"><SystemUpdatePanel key={server.id} server={server} /></div>}</Section>{import.meta.env.DEV && <p className="ws-muted">Paket güncelleme işlemleri geliştirme görünümünde kapalıdır.</p>}<Section title="Gelişmiş araçlar"><div className="ws-section-body ws-actions"><LinkButton to="/applications" icon="code">Uygulamalar</LinkButton><LinkButton to="/domains" icon="globe">Alan adları ve sertifikalar</LinkButton><LinkButton to="/servers" icon="server">Sunucu kayıtları</LinkButton></div></Section></>;
}
const capabilities = {
  databases: ['Veritabanları', 'MySQL/MariaDB oluşturma, kullanıcı yetkileri ve yedek/restore yönetimi henüz uygulanmadı.', 'database'],
  docker: ['Docker', 'Compose yaşam döngüsü, registry ve volume yönetimi henüz uygulanmadı.', 'box'],
  mail: ['Mail', 'Postfix, Dovecot, mailbox ve Roundcube yönetim backend’i henüz uygulanmadı.', 'mail'],
  backups: ['Yedekler', 'Yedek hedefleri, retention ve geri yükleme yönetimi henüz uygulanmadı.', 'archive'],
  audit: ['Denetim kayıtları', 'Tüm yönetim işlemlerini kapsayan audit ekranı henüz uygulanmadı. İşler ekranı audit kaydının yerine geçmez.', 'shield'],
};
export function CapabilityPage({ name }) {
  const [title, detail, icon] = capabilities[name];
  return <><PageHeading title={title} description="Modülün uygulama durumu." /><Section title={title}><EmptyState title="Bu modül henüz uygulanmadı" detail={detail} icon={icon} action={<LinkButton to="/websites">Web sitelerine dön</LinkButton>} /></Section></>;
}
export function NotFoundPage() {
  return <><PageHeading title="Sayfa bulunamadı" /><Section title="Geçersiz adres"><EmptyState title="Bu yönetim sayfası bulunmuyor" detail="Adres yanlış olabilir veya bu modül henüz mevcut olmayabilir." icon="search" action={<Link to="/dashboard">Genel bakışa dön</Link>} /></Section></>;
}
